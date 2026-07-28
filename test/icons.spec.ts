import { env } from 'cloudflare:test';
import { describe, expect, test, vi } from 'vitest';
import worker from '../src';

function createCache() {
  const values = new Map<string, { value: ArrayBuffer; metadata?: unknown }>();
  return {
    values,
    async getWithMetadata<T>(key: string) {
      const stored = values.get(key);
      return { value: stored?.value ?? null, metadata: (stored?.metadata as T | undefined) ?? null };
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

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M1 1h22v22H1z"/></svg>';

describe('icon delivery', () => {
  test('renders a Lucide icon with PNG and cache headers without secure mode', async () => {
    const cache = createCache();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(svg, { headers: { 'Content-Type': 'image/svg+xml' } }));

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
    ['/icons/unknown/check', 'Unsupported icon pack'],
    ['/icons/lucide/BadName', 'iconName'],
    ['/icons/lucide/check?size=1025', 'size'],
    ['/icons/remix/check', 'category'],
  ])('rejects invalid request %s', async (path, message) => {
    const response = await worker.fetch(request(path), createTestEnv());
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain(message);
  });

  test.each([
    ['/icons/font-awesome/circle?style=brands', '/FortAwesome/Font-Awesome/7.x/svgs/brands/circle.svg'],
    ['/icons/hero/academic-cap?sourceSize=20&style=solid', '/tailwindlabs/heroicons/master/optimized/20/solid/academic-cap.svg'],
    ['/icons/remix/home?category=Buildings', '/Remix-Design/RemixIcon/master/icons/Buildings/home.svg'],
  ])('maps provider variant %s', async (path, expectedPath) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(svg));
    const response = await worker.fetch(request(path), createTestEnv());

    expect(response.status).toBe(200);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(expectedPath);
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
    expect((await response.json()).requestId).toBeTruthy();
    vi.restoreAllMocks();
  });
});
