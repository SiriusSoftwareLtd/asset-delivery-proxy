import { env } from 'cloudflare:test';
import { describe, expect, test, vi } from 'vitest';
import worker from './worker';

function createCache() {
  const values = new Map<string, { value: ArrayBuffer; metadata?: unknown }>();
  return {
    values,
    async getWithMetadata<T>(key: string) {
      const stored = values.get(key);
      return {
        value: stored?.value ?? null,
        metadata: (stored?.metadata as T | undefined) ?? null,
      };
    },
    async put(key: string, value: ArrayBuffer, options?: { metadata?: unknown }) {
      values.set(key, { value, metadata: options?.metadata });
    },
    async delete() {},
  };
}

function createTestEnv(assetCache = createCache()) {
  return {
    ...env,
    assetCache,
    OBSERVABILITY_REPORT_LEVEL: 'off',
    ASSET_PROXY_RATE_LIMITER: { limit: async () => ({ success: true }) },
    FLAGS: { getBooleanValue: async () => false },
  } as unknown as CloudflareBindings;
}

function request(path: string) {
  return new Request(`https://proxy.test${path}`);
}

function batchRequest(body: unknown) {
  return new Request('https://proxy.test/icon/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M1 1h22v22H1z"/></svg>';
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

describe('icon delivery', () => {
  test('renders a Lucide icon with PNG and cache headers without secure mode', async () => {
    const cache = createCache();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(svg, { headers: { 'Content-Type': 'image/svg+xml' } }));

    const response = await worker.fetch(request('/icons/lucide/circle-check'), createTestEnv(cache));

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(response.headers.get('Cache-Control')).toContain('max-age=86400');
    expect(response.headers.get('X-Request-ID')).toBeTruthy();
    expect(response.headers.get('X-Icon-Pack')).toBe('lucide');
    expect(new Uint8Array(await response.arrayBuffer()).subarray(0, 8)).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect([...cache.values.keys()][0]).toMatch(/^icon:v1:lucide:/);
    fetchMock.mockRestore();
  });

  test.each([
    ['/icons/unknown/check', 'unknown icon pack unknown'],
    ['/icons/lucide/BadName', 'iconName'],
    ['/icons/lucide/check?size=0', 'size'],
    ['/icons/lucide/check?size=64px', 'size'],
    ['/icons/lucide/check?size=1025', 'size'],
    ['/icons/remix/check', 'category'],
    ['/icons/rayfield/BadName', 'iconName'],
    ['/icons/rayfield/check?size=64', 'Rayfield icons do not support query options'],
    ['/icons/rayfield/missing', 'The requested icon does not exist'],
  ])('rejects invalid request %s', async (path, message) => {
    const response = await worker.fetch(request(path), createTestEnv());
    expect(response.status).toBe(400);
    expect((await response.json<{ error: string }>()).error).toContain(message);
  });

  test.each([
    ['/icons/font-awesome/circle?style=brands', '/FortAwesome/Font-Awesome/7.x/svgs/brands/circle.svg'],
    [
      '/icons/hero/academic-cap?sourceSize=20&style=solid',
      '/tailwindlabs/heroicons/master/optimized/20/solid/academic-cap.svg',
    ],
    ['/icons/remix/home?category=Buildings', '/Remix-Design/RemixIcon/master/icons/Buildings/home.svg'],
  ])('maps provider variant %s', async (path, expectedPath) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(svg));
    const response = await worker.fetch(request(path), createTestEnv());

    expect(response.status).toBe(200);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(expectedPath);
    fetchMock.mockRestore();
  });

  test('uses the same cache entry for default and explicit default size', async () => {
    const cache = createCache();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(svg));

    const first = await worker.fetch(request('/icons/lucide/check'), createTestEnv(cache));
    const second = await worker.fetch(request('/icons/lucide/check?size=64'), createTestEnv(cache));

    expect(first.status).toBe(200);
    expect(first.headers.get('X-Cache-Status')).toBe('miss');
    expect(second.status).toBe(200);
    expect(second.headers.get('X-Cache-Status')).toBe('hit');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cache.values.size).toBe(1);
    fetchMock.mockRestore();
  });

  test('delivers registry-backed Rayfield PNG icons', async () => {
    const cache = createCache();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(png));

    const response = await worker.fetch(request('/icons/rayfield/check'), createTestEnv(cache));

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(response.headers.get('X-Icon-Pack')).toBe('rayfield');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      '/siriusSoftwareLtd/rayfield-gen2/refs%2Fheads%2Fmain/assets/125626312718314.png',
    );
    expect([...cache.values.keys()][0]).toBe('icon:v1:rayfield::125626312718314');
    fetchMock.mockRestore();
  });

  test.each([
    [new Response('missing', { status: 404 }), 404],
    [new DOMException('timed out', 'TimeoutError'), 504],
    [new Error('upstream unavailable'), 502],
  ])('maps icon generation failures to %s', async (failure, expectedStatus) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      if (failure instanceof Response) return failure;
      throw failure;
    });

    const response = await worker.fetch(request('/icons/lucide/check'), createTestEnv());
    expect(response.status).toBe(expectedStatus);
    expect((await response.json<{ requestId: string }>()).requestId).toBeTruthy();
    vi.restoreAllMocks();
  });

  test.each([
    [new Response('<html>not svg</html>', { headers: { 'Content-Type': 'text/html' } }), 502],
    [new Response('not svg', { headers: { 'Content-Type': 'text/plain' } }), 502],
    [new Response('', { headers: { 'Content-Type': 'image/svg+xml' } }), 502],
    [new Response(svg, { headers: { 'Content-Length': String(512 * 1024 + 1) } }), 502],
  ])('rejects invalid upstream SVG responses', async (upstreamResponse, expectedStatus) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => upstreamResponse.clone());

    const response = await worker.fetch(request('/icons/lucide/check'), createTestEnv());
    const body = await response.json<{ error: string; requestId: string }>();

    expect(response.status).toBe(expectedStatus);
    expect(body.error).toBe('Unable to generate icon');
    expect(body.requestId).toBeTruthy();
    vi.restoreAllMocks();
  });

  test('returns ordered base64 PNG results for mixed providers', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('/siriusSoftwareLtd/rayfield-gen2/')) return new Response(png);
      return new Response(svg);
    });
    const response = await worker.fetch(
      batchRequest({
        icons: [
          {
            iconPack: 'lucide',
            iconName: 'circle-check',
            options: { size: '64' },
          },
          {
            iconPack: 'hero',
            iconName: 'academic-cap',
            options: { sourceSize: '20', style: 'solid', size: '128' },
          },
          {
            iconPack: 'rayfield',
            iconName: 'check',
            options: {},
          },
        ],
      }),
      createTestEnv(),
    );
    const body = (await response.json()) as {
      requestId: string;
      results: Array<Record<string, unknown>>;
    };

    expect(response.status).toBe(200);
    expect(body.requestId).toBeTruthy();
    expect(body.results).toHaveLength(3);
    expect(body.results).toEqual([
      expect.objectContaining({
        iconPack: 'lucide',
        iconName: 'circle-check',
        status: 200,
        contentType: 'image/png',
        cacheStatus: 'miss',
        cacheHit: false,
      }),
      expect.objectContaining({
        iconPack: 'hero',
        iconName: 'academic-cap',
        status: 200,
        contentType: 'image/png',
        cacheStatus: 'miss',
        cacheHit: false,
      }),
      expect.objectContaining({
        iconPack: 'rayfield',
        iconName: 'check',
        status: 200,
        contentType: 'image/png',
        cacheStatus: 'miss',
        cacheHit: false,
      }),
    ]);
    expect(
      body.results.every((result) => typeof result.dataBase64 === 'string' && (result.dataBase64 as string).length > 0),
    ).toBe(true);
    const fetchedUrls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(
      fetchedUrls.some((url) => url.includes('/tailwindlabs/heroicons/master/optimized/20/solid/academic-cap.svg')),
    ).toBe(true);
    expect(
      fetchedUrls.some((url) =>
        url.includes('/siriusSoftwareLtd/rayfield-gen2/refs%2Fheads%2Fmain/assets/125626312718314.png'),
      ),
    ).toBe(true);
    fetchMock.mockRestore();
  });

  test('uses an existing single-icon cache entry for a batch item', async () => {
    const cache = createCache();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(svg));
    const first = await worker.fetch(request('/icons/lucide/circle-check?size=64'), createTestEnv(cache));
    expect(first.status).toBe(200);

    const response = await worker.fetch(
      batchRequest({
        icons: [
          {
            iconPack: 'lucide',
            iconName: 'circle-check',
            options: { size: '64' },
          },
        ],
      }),
      createTestEnv(cache),
    );
    const body = (await response.json()) as {
      results: Array<Record<string, unknown>>;
    };

    expect(response.status).toBe(200);
    expect(body.results).toEqual([
      expect.objectContaining({
        status: 200,
        cacheStatus: 'hit',
        cacheHit: true,
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockRestore();
  });

  test('returns per-item validation and upstream failures', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('missing', { status: 404 }))
      .mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'))
      .mockRejectedValueOnce(new Error('upstream unavailable'));
    const response = await worker.fetch(
      batchRequest({
        icons: [
          { iconPack: 'unknown', iconName: 'check', options: {} },
          {
            iconPack: 'hero',
            iconName: 'check',
            options: { sourceSize: '16', style: 'outline' },
          },
          { iconPack: 'lucide', iconName: 'missing', options: {} },
          { iconPack: 'lucide', iconName: 'timeout', options: {} },
          { iconPack: 'lucide', iconName: 'failure', options: {} },
        ],
      }),
      createTestEnv(),
    );
    const body = (await response.json()) as {
      results: Array<Record<string, unknown>>;
    };

    expect(response.status).toBe(200);
    expect(body.results.map((result) => result.status)).toEqual([400, 400, 404, 504, 502]);
    expect(body.results.map((result) => result.error)).toEqual([
      'unknown icon pack unknown',
      'Heroicons 16 and 20 source sizes only support solid style',
      'Icon not found',
      'Icon source timed out',
      'Unable to generate icon',
    ]);
    fetchMock.mockRestore();
  });

  test.each([
    new Request('https://proxy.test/icon/batch', {
      method: 'POST',
      body: '{not-json',
    }),
    batchRequest({}),
    batchRequest({ icons: [] }),
    batchRequest({
      icons: Array.from({ length: 51 }, () => ({
        iconPack: 'lucide',
        iconName: 'check',
        options: {},
      })),
    }),
    batchRequest({ icons: [{ iconPack: 'lucide', options: {} }] }),
    batchRequest({
      icons: [{ iconPack: 'lucide', iconName: 'check', options: { size: 64 } }],
    }),
  ])('rejects malformed batch body', async (batch) => {
    const response = await worker.fetch(batch, createTestEnv());
    expect(response.status).toBe(400);
  });
});
