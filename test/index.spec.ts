import { env } from 'cloudflare:test';
import { describe, expect, test, vi } from 'vitest';
import { buildAssetResolutionIdentity } from '../src/services/assets/cache';
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

function createTestEnv(
  flagValue: boolean | Error,
  assetCache = createCache(),
  options: {
    enabledFlags?: string[];
    rateLimit?: () => Promise<{ success: boolean }>;
  } = {},
): CloudflareBindings {
  return {
    ...env,
    ROBLOX_API_KEY: '',
    assetCache,
    ASSET_PROXY_RATE_LIMITER: {
      limit: options.rateLimit ?? (async () => ({ success: true })),
    },
    FLAGS: {
      getBooleanValue: async (name: string) => {
        if (name !== 'use-asset-delivery-v2') return options.enabledFlags?.includes(name) ?? false;
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
      .mockResolvedValueOnce(Response.json({ location: 'https://cdn.test/asset-202', assetTypeId: 9 }))
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

  test('authenticates v1 asset delivery with the configured API key', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(new Uint8Array([8]), { headers: { 'Content-Type': 'image/png' } }));
    const testEnv = { ...createTestEnv(false, createCache()), ROBLOX_API_KEY: 'session-token' };

    const response = await worker.fetch(request('706'), testEnv);

    expect(response.status).toBe(200);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://apis.roblox.com/asset-delivery-api/v1/assetId/706');
    const assetRequest = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(assetRequest.headers).get('x-api-key')).toBe('session-token');
    fetchMock.mockRestore();
  });

  test('authenticates v2 discovery through Open Cloud without dropping allowlisted headers', async () => {
    const cache = createCache();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ locations: [{ location: 'https://cdn.test/authed' }] }))
      .mockResolvedValueOnce(new Response(new Uint8Array([9])));

    const incoming = request('707');
    const headers = new Headers(incoming.headers);
    headers.set('Roblox-Place-Id', '42');
    const testEnv = { ...createTestEnv(true, cache), ROBLOX_API_KEY: 'session-token' };
    const response = await worker.fetch(new Request(incoming.url, { headers }), testEnv);

    expect(response.status).toBe(200);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://apis.roblox.com/asset-delivery-api/v1/assetId/707');
    const discoveryRequest = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const discoveryHeaders = new Headers(discoveryRequest.headers);
    expect(discoveryHeaders.get('Roblox-Place-Id')).toBe('42');
    expect(discoveryHeaders.get('x-api-key')).toBe('session-token');
    const locationRequest = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const locationHeaders = new Headers(locationRequest?.headers);
    expect(locationHeaders.get('Roblox-Place-Id')).toBe('42');
    expect(locationHeaders.has('x-api-key')).toBe(false);
    fetchMock.mockRestore();
  });

  test('accepts authenticated Open Cloud asset bytes without discovery JSON', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(new Uint8Array([11, 12]), { headers: { 'Content-Type': 'image/png' } }));

    const response = await worker.fetch(request('709'), {
      ...createTestEnv(true, createCache()),
      ROBLOX_API_KEY: 'session-token',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Asset-Extension')).toBe('.png');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([11, 12]));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockRestore();
  });

  test('omits the api key header when no session is configured', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ locations: [{ location: 'https://cdn.test/anon' }] }))
      .mockResolvedValueOnce(new Response(new Uint8Array([10])));

    const testEnv = { ...createTestEnv(true, createCache()), ROBLOX_API_KEY: '' };
    await worker.fetch(request('808'), testEnv);

    const discoveryRequest = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(discoveryRequest.headers).has('x-api-key')).toBe(false);
    const locationRequest = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(new Headers(locationRequest?.headers).has('x-api-key')).toBe(false);
    fetchMock.mockRestore();
  });

  test('surfaces a rejected discovery instead of reporting it as malformed', async () => {
    const cache = createCache();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      /* Roblox answers permission failures with 200 and an errors array */
      Response.json({ errors: [{ code: 401, message: 'Authentication required to access Asset.' }] }),
    );

    const response = await worker.fetch(request('909'), createTestEnv(true, cache));
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(401);
    expect(body.error).toBe('Authentication required to access Asset.');
    expect([...cache.values.keys()].some((key) => key.includes('909'))).toBe(false);
    fetchMock.mockRestore();
  });

  test('treats an unusable rejection code as a gateway failure', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ errors: [{ code: 0, message: 'Unknown upstream failure' }] }));

    const response = await worker.fetch(request('910'), createTestEnv(true, createCache()));

    expect(response.status).toBe(502);
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

  test('lazy client limiting runs once for an outer request and exempts later cache hits', async () => {
    const cache = createCache();
    const limiter = vi.fn(async () => ({ success: true }));
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'image/png' } }));
    const testEnv = createTestEnv(false, cache, {
      enabledFlags: ['asset-cache-hit-exempt-limit'],
      rateLimit: limiter,
    });

    expect((await worker.fetch(request('7001'), testEnv)).status).toBe(200);
    expect((await worker.fetch(request('7001'), testEnv)).status).toBe(200);
    expect(limiter).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect([...cache.values.keys()][0]).toMatch(/^asset:v2:[a-f0-9]{64}$/);
    fetchMock.mockRestore();
  });

  test('a batch makes one lazy client-limit decision for all unique misses', async () => {
    const limiter = vi.fn(async () => ({ success: true }));
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(new Uint8Array([2]), { headers: { 'Content-Type': 'image/png' } }));

    const response = await worker.fetch(
      batchRequest({ assetIds: ['7101', '7102', '7101'] }),
      createTestEnv(false, createCache(), {
        enabledFlags: ['asset-cache-hit-exempt-limit'],
        rateLimit: limiter,
      }),
    );

    expect(response.status).toBe(200);
    expect(limiter).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockRestore();
  });

  test('passes through upstream Retry-After without retrying or caching 429', async () => {
    const cache = createCache();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('slow down', { status: 429, headers: { 'Retry-After': '17' } }));

    const response = await worker.fetch(request('7201'), createTestEnv(false, cache));

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('17');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cache.values.size).toBe(0);
    fetchMock.mockRestore();
  });

  test('serves stale KV bytes without client limiting and refreshes in the background', async () => {
    const cache = createCache();
    const assetRequest = request('7301');
    const identity = await buildAssetResolutionIdentity('7301', assetRequest, false);
    const storedAt = Date.now() - 25 * 60 * 60 * 1_000;
    cache.values.set(identity.physicalKey, {
      value: new Uint8Array([3]).buffer,
      metadata: {
        kind: 'asset',
        version: 2,
        timestamp: storedAt,
        storedAt,
        freshUntil: storedAt + 24 * 60 * 60 * 1_000,
        staleUntil: storedAt + 7 * 24 * 60 * 60 * 1_000,
        contentType: 'image/png',
        extension: '.png',
      },
    });
    const limiter = vi.fn(async () => ({ success: true }));
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(new Uint8Array([4]), { headers: { 'Content-Type': 'image/png' } }));

    const response = await worker.fetch(
      assetRequest,
      createTestEnv(false, cache, {
        enabledFlags: ['asset-cache-layered', 'asset-cache-hit-exempt-limit'],
        rateLimit: limiter,
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Cache-Status')).toBe('stale-hit');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([3]));
    expect(limiter).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new Uint8Array(cache.values.get(identity.physicalKey)?.value ?? new ArrayBuffer(0))).toEqual(
      new Uint8Array([4]),
    );
    fetchMock.mockRestore();
  });

  test('serves a fresh L1 hit without KV, upstream, or another client-limit decision', async () => {
    const assetId = '7401';
    const limiter = vi.fn(async () => ({ success: true }));
    const enabledFlags = ['asset-cache-layered', 'asset-cache-hit-exempt-limit'];
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(new Uint8Array([6]), { headers: { 'Content-Type': 'image/png' } }));

    const first = await worker.fetch(
      request(assetId),
      createTestEnv(false, createCache(), { enabledFlags, rateLimit: limiter }),
    );
    const second = await worker.fetch(
      request(assetId),
      createTestEnv(false, createCache(), { enabledFlags, rateLimit: limiter }),
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers.get('X-Cache-Status')).toBe('l1-hit');
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(new Uint8Array([6]));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(limiter).toHaveBeenCalledTimes(1);
    fetchMock.mockRestore();
  });

  test('rejects a lazy-limited cold miss before contacting Roblox', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const response = await worker.fetch(
      request('7501'),
      createTestEnv(false, createCache(), {
        enabledFlags: ['asset-cache-hit-exempt-limit'],
        rateLimit: async () => ({ success: false }),
      }),
    );

    expect(response.status).toBe(429);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });
});
