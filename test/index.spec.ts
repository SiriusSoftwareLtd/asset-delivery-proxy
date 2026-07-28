import { env } from 'cloudflare:test';
import { describe, expect, test, vi } from 'vitest';
import worker from './worker';

type StoredValue = {
  value: ArrayBuffer;
  metadata?: unknown;
};

function createCache() {
  const values = new Map<string, StoredValue>();
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
    async delete(key: string) {
      values.delete(key);
    },
  };
}

function createTestEnv(flagValue: boolean | Error, assetCache = createCache()) {
  return {
    ...env,
    assetCache,
    ASSET_PROXY_RATE_LIMITER: {
      limit: async () => ({ success: true }),
    },
    FLAGS: {
      getBooleanValue: async () => {
        if (flagValue instanceof Error) throw flagValue;
        return flagValue;
      },
    },
  } as unknown as CloudflareBindings;
}

function request(assetId: string, init: RequestInit = {}) {
  return new Request(`https://proxy.test/assets/${assetId}`, {
    ...init,
    headers: {
      'X-Rayfield-Secure-Mode': 'true',
      ...init.headers,
    },
  });
}

function batchRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request('https://proxy.test/assets/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Rayfield-Secure-Mode': 'true', ...headers },
    body: JSON.stringify(body),
  });
}

describe('asset delivery rollout', () => {
  test('flag false/default calls v1 and preserves byte response and cache behavior', async () => {
    const cache = createCache();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'Content-Type': 'image/png' },
      }),
    );

    const first = await worker.fetch(request('101'), createTestEnv(false, cache));
    const second = await worker.fetch(request('101'), createTestEnv(false, cache));

    expect(first.status).toBe(200);
    expect(first.headers.get('X-Asset-Extension')).toBe('.png');
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(second.headers.get('X-Cache-Status')).toBe('hit');
    expect(second.headers.get('X-Asset-Extension')).toBe('.png');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://assetdelivery.roblox.com/v1/asset/?id=101');
    fetchMock.mockRestore();
  });

  test('flag true discovers and follows the v2 location, then caches bytes', async () => {
    const cache = createCache();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json({
          locations: [{ location: 'https://cdn.test/asset-202' }],
          assetTypeId: 9,
        }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([4, 5]), {
          headers: { 'Content-Type': 'model/gltf-binary' },
        }),
      );

    const response = await worker.fetch(request('202'), createTestEnv(true, cache));
    const cached = await worker.fetch(request('202'), createTestEnv(true, cache));

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Asset-Extension')).toBe('.rbxl');
    expect(await response.arrayBuffer()).toEqual(new Uint8Array([4, 5]).buffer);
    expect(cached.headers.get('X-Cache-Status')).toBe('hit');
    expect(cached.headers.get('X-Asset-Extension')).toBe('.rbxl');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/v2/assetId/202');
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe('https://cdn.test/asset-202');
    fetchMock.mockRestore();
  });

  test('flag evaluation failure falls back to v1', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(new Uint8Array([6]), { headers: { 'Content-Type': 'application/octet-stream' } }),
      );
    const response = await worker.fetch(request('303'), createTestEnv(new Error('Flagship unavailable')));
    expect(response.status).toBe(200);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/v1/asset/?id=303');
    fetchMock.mockRestore();
  });

  test('forwards only v2 allowlisted inputs and varies the cache key', async () => {
    const cache = createCache();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ locations: [{ location: 'https://cdn.test/one' }] }))
      .mockResolvedValueOnce(new Response(new Uint8Array([7])))
      .mockResolvedValueOnce(Response.json({ locations: [{ location: 'https://cdn.test/two' }] }))
      .mockResolvedValueOnce(new Response(new Uint8Array([8])));

    const firstRequest = request('404');
    const firstUrl = new URL(firstRequest.url);
    firstUrl.searchParams.set('assetVersionId', '1');
    firstUrl.searchParams.set('unknown', 'drop-me');
    const headers = new Headers(firstRequest.headers);
    headers.set('Roblox-Place-Id', '99');
    headers.set('X-Unknown', 'drop-me');
    const first = await worker.fetch(new Request(firstUrl, { headers }), createTestEnv(true, cache));
    const secondUrl = new URL(firstUrl);
    secondUrl.searchParams.set('assetVersionId', '2');
    const second = await worker.fetch(new Request(secondUrl, { headers }), createTestEnv(true, cache));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const discoveryRequest = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(discoveryRequest.headers).get('Roblox-Place-Id')).toBe('99');
    expect(new Headers(discoveryRequest.headers).get('X-Unknown')).toBeNull();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('assetVersionId=1');
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('unknown=');
    fetchMock.mockRestore();
  });

  test('v2 404 is negatively cached, while malformed discovery is a 502 without a cache write', async () => {
    const cache = createCache();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('missing', { status: 404 }))
      .mockResolvedValueOnce(new Response('{not-json', { status: 200 }));

    const notFound = await worker.fetch(request('505'), createTestEnv(true, cache));
    expect(notFound.status).toBe(404);
    expect([...cache.values.keys()]).toHaveLength(1);
    const malformed = await worker.fetch(request('606'), createTestEnv(true, cache));
    expect(malformed.status).toBe(502);
    expect([...cache.values.keys()].some((key) => key.includes('606'))).toBe(false);
    fetchMock.mockRestore();
  });

  test('batch returns ordered cache hit, upstream success, and negative-cache result', async () => {
    const cache = createCache();
    cache.values.set('101', {
      value: new Uint8Array([1, 2]).buffer,
      metadata: { kind: 'asset', timestamp: 123, contentType: 'image/png', extension: '.png' },
    });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(new Uint8Array([3, 4]), { headers: { 'Content-Type': 'image/jpeg' } }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));

    const response = await worker.fetch(batchRequest({ assetIds: ['101', '202', '303'] }), createTestEnv(false, cache));
    const body = (await response.json()) as { requestId: string; results: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(body.requestId).toBeTruthy();
    expect(body.results).toEqual([
      expect.objectContaining({
        assetId: '101',
        status: 200,
        contentType: 'image/png',
        extension: '.png',
        cacheStatus: 'hit',
        cacheHit: true,
        dataBase64: 'AQI=',
      }),
      expect.objectContaining({
        assetId: '202',
        status: 200,
        contentType: 'image/jpeg',
        cacheStatus: 'miss',
        cacheHit: false,
        dataBase64: 'AwQ=',
      }),
      expect.objectContaining({
        assetId: '303',
        status: 404,
        cacheStatus: 'negative-write',
        cacheHit: false,
        error: 'Asset not found',
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockRestore();
  });

  test('batch rejects invalid requests and checks secure mode before parsing or processing', async () => {
    const cases = [
      new Request('https://proxy.test/assets/batch', {
        method: 'POST',
        headers: { 'X-Rayfield-Secure-Mode': 'true' },
        body: '{not-json',
      }),
      batchRequest({}),
      batchRequest({ assetIds: [] }),
      batchRequest({ assetIds: Array.from({ length: 26 }, (_, index) => String(index + 1)) }),
      batchRequest({ assetIds: ['not-an-id'] }),
    ];

    for (const request of cases) {
      const response = await worker.fetch(request, createTestEnv(false));
      expect(response.status).toBe(400);
    }

    const denied = await worker.fetch(
      batchRequest({ assetIds: ['101'] }, { 'X-Rayfield-Secure-Mode': 'false' }),
      createTestEnv(false),
    );
    expect(denied.status).toBe(403);
  });

  test('batch duplicate IDs preserve order and share the in-flight cacheable operation', async () => {
    const cache = createCache();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(new Uint8Array([9]), { headers: { 'Content-Type': 'image/png' } }));

    const response = await worker.fetch(batchRequest({ assetIds: ['404', '404', '505'] }), createTestEnv(false, cache));
    const body = (await response.json()) as { results: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(body.results.map((result) => result.assetId)).toEqual(['404', '404', '505']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(body.results[0]).toEqual(expect.objectContaining({ status: 200, dataBase64: 'CQ==' }));
    expect(body.results[1]).toEqual(expect.objectContaining({ status: 200, dataBase64: 'CQ==' }));
    fetchMock.mockRestore();
  });
});
