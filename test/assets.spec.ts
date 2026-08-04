import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, test, vi } from 'vitest';
import sourceWorker from '../src';
import { buildAssetResolutionIdentity } from '../src/services/assets/cache';
import type { AssetResolutionResult } from '../src/types/app';
import worker from './worker';

type StoredValue = {
  value: ArrayBuffer;
  metadata?: unknown;
};
type AnalyticsPoint = {
  blobs?: string[];
  doubles?: number[];
  indexes?: string[];
};

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

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
    async get(key: string, type?: 'arrayBuffer') {
      const stored = values.get(key);
      if (!stored) return null;
      if (type === 'arrayBuffer') return stored.value;
      return new TextDecoder().decode(stored.value);
    },
    async put(key: string, value: ArrayBuffer, options?: { metadata?: unknown }) {
      values.set(key, { value, metadata: options?.metadata });
    },
    async delete(key: string) {
      values.delete(key);
    },
  };
}

const ASSET_FEATURE_FLAGS = [
  'use-asset-delivery-v2',
  'asset-cache-hit-exempt-limit',
  'asset-cache-layered',
  'asset-upstream-coordinator',
  'asset-upstream-backpressure',
] as const;

type AssetFeatureFlag = (typeof ASSET_FEATURE_FLAGS)[number];
type AssetFeatureFlagValue = boolean | Error;

function isAssetFeatureFlag(name: string): name is AssetFeatureFlag {
  return ASSET_FEATURE_FLAGS.some((flag) => flag === name);
}

function createFeatureFlags(
  useAssetDeliveryV2: boolean | Error,
  enabledFlags: readonly string[] = [],
): CloudflareBindings['FLAGS'] {
  const values: Record<AssetFeatureFlag, AssetFeatureFlagValue> = {
    'use-asset-delivery-v2': useAssetDeliveryV2,
    'asset-cache-hit-exempt-limit': false,
    'asset-cache-layered': false,
    'asset-upstream-coordinator': false,
    'asset-upstream-backpressure': false,
  };

  for (const flag of enabledFlags) {
    if (!isAssetFeatureFlag(flag)) {
      throw new Error(`Unknown asset feature flag in test: ${flag}`);
    }
    values[flag] = true;
  }

  return {
    getBooleanValue: async (name: string, fallback = false) => {
      if (!isAssetFeatureFlag(name)) return fallback;

      const value = values[name];
      if (value instanceof Error) throw value;
      return value;
    },
  } as CloudflareBindings['FLAGS'];
}

function createTestEnv(
  flagValue: boolean | Error,
  assetCache: KVNamespace | ReturnType<typeof createCache> = createCache(),
  options: {
    enabledFlags?: string[];
    rateLimit?: () => Promise<{ success: boolean }>;
    assetMetrics?: { writeDataPoint: (point: AnalyticsPoint) => void };
  } = {},
): CloudflareBindings {
  return {
    ...env,
    ROBLOX_API_KEY: '',
    assetCache,
    ASSET_METRICS: options.assetMetrics,
    ASSET_PROXY_RATE_LIMITER: {
      limit: options.rateLimit ?? (async () => ({ success: true })),
    },
    FLAGS: createFeatureFlags(flagValue, options.enabledFlags),
  } as unknown as CloudflareBindings;
}

function fakeCoordinator(result: AssetResolutionResult): CloudflareBindings['ASSET_RESOLUTION_COORDINATOR'] {
  return {
    getByName: () => ({
      resolve: async () => result,
    }),
  } as unknown as CloudflareBindings['ASSET_RESOLUTION_COORDINATOR'];
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

async function seedStaleAsset(
  cache: KVNamespace,
  identity: Awaited<ReturnType<typeof buildAssetResolutionIdentity>>,
  data: Uint8Array,
): Promise<void> {
  const storedAt = Date.now() - 25 * 60 * 60 * 1_000;
  const value = new ArrayBuffer(data.byteLength);
  new Uint8Array(value).set(data);
  await cache.put(identity.physicalKey, value, {
    expirationTtl: 7 * 24 * 60 * 60,
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
}

describe('asset delivery', () => {
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

  test('authenticated v1 follows Open Cloud discovery and caches the final asset', async () => {
    const cache = createCache();

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json({
          location: 'https://cdn.test/v1-asset',
        }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([8, 9]), {
          headers: { 'Content-Type': 'image/png' },
        }),
      );

    const testEnv = {
      ...createTestEnv(false, cache),
      ROBLOX_API_KEY: 'session-token',
    };

    const response = await worker.fetch(request('706'), testEnv);
    const cached = await worker.fetch(request('706'), testEnv);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(response.headers.get('X-Asset-Extension')).toBe('.png');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([8, 9]));

    expect(cached.status).toBe(200);
    expect(cached.headers.get('X-Cache-Status')).toBe('hit');
    expect(cached.headers.get('X-Asset-Extension')).toBe('.png');
    expect(new Uint8Array(await cached.arrayBuffer())).toEqual(new Uint8Array([8, 9]));

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const discoveryCall = fetchMock.mock.calls[0];
    if (!discoveryCall) {
      throw new Error('Expected Open Cloud discovery request');
    }

    const assetCall = fetchMock.mock.calls[1];
    if (!assetCall) {
      throw new Error('Expected signed asset location request');
    }

    expect(String(discoveryCall[0])).toBe('https://apis.roblox.com/asset-delivery-api/v1/assetId/706');

    const discoveryRequest = discoveryCall[1] as RequestInit;
    const discoveryHeaders = new Headers(discoveryRequest.headers);

    expect(discoveryHeaders.get('x-api-key')).toBe('session-token');

    expect(String(assetCall[0])).toBe('https://cdn.test/v1-asset');

    const assetRequest = assetCall[1] as RequestInit;
    const assetHeaders = new Headers(assetRequest.headers);

    expect(assetHeaders.has('x-api-key')).toBe(false);

    fetchMock.mockRestore();
  });

  test.each([
    ['missing location', {}],
    ['invalid location URL', { location: 'not-a-url' }],
    ['non-HTTPS location', { location: 'http://cdn.test/v1-asset' }],
  ])('authenticated v1 rejects %s', async (_label, discovery) => {
    const cache = createCache();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json(discovery));
    const testEnv = {
      ...createTestEnv(false, cache),
      ROBLOX_API_KEY: 'session-token',
    };

    try {
      const response = await worker.fetch(request('710'), testEnv);

      expect(response.status).toBe(502);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://apis.roblox.com/asset-delivery-api/v1/assetId/710');
      expect(cache.values.size).toBe(0);
    } finally {
      fetchMock.mockRestore();
    }
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
    const cachedIdentity = await buildAssetResolutionIdentity('101', request('101'), false);
    cache.values.set(cachedIdentity.physicalKey, {
      value: new Uint8Array([1, 2]).buffer,
      metadata: {
        kind: 'asset',
        version: 2,
        timestamp: 123,
        storedAt: 123,
        freshUntil: Date.now() + 60_000,
        staleUntil: Date.now() + 120_000,
        contentType: 'image/png',
        extension: '.png',
      },
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

  test('reports a coordinator fresh KV recheck as a cache hit metric', async () => {
    const timestamp = Date.now();
    const metricWrites: AnalyticsPoint[] = [];
    const testEnv = {
      ...createTestEnv(false, createCache(), {
        enabledFlags: ['asset-cache-layered', 'asset-upstream-coordinator'],
        assetMetrics: { writeDataPoint: (point) => metricWrites.push(point) },
      }),
      ASSET_RESOLUTION_COORDINATOR: fakeCoordinator({
        kind: 'asset',
        status: 200,
        data: new Uint8Array([8, 9]),
        contentType: 'image/png',
        extension: '.png',
        timestamp,
        attempts: 0,
        queueTimeMs: 0,
        joined: false,
        origin: 'kv',
      }),
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    const response = await worker.fetch(request('7251'), testEnv);

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Cache-Status')).toBe('kv-fresh-hit');
    expect(response.headers.get('X-Cache-Hit')).toBe('true');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([8, 9]));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(metricWrites).toHaveLength(1);
    expect(metricWrites[0]?.blobs?.[0]).toBe('coordinator');
    expect(metricWrites[0]?.blobs?.[1]).toBe('fresh-hit');
    fetchMock.mockRestore();
  });

  test('reports a coordinator negative KV recheck as a negative cache hit metric', async () => {
    const metricWrites: AnalyticsPoint[] = [];
    const testEnv = {
      ...createTestEnv(false, createCache(), {
        enabledFlags: ['asset-upstream-coordinator'],
        assetMetrics: { writeDataPoint: (point) => metricWrites.push(point) },
      }),
      ASSET_RESOLUTION_COORDINATOR: fakeCoordinator({
        kind: 'not-found',
        status: 404,
        error: 'Asset not found',
        timestamp: Date.now(),
        attempts: 0,
        queueTimeMs: 0,
        joined: false,
        origin: 'kv',
      }),
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    const response = await worker.fetch(request('7252'), testEnv);

    expect(response.status).toBe(404);
    expect(response.headers.get('X-Cache-Status')).toBe('negative-hit');
    expect(response.headers.get('X-Cache-Hit')).toBe('true');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(metricWrites).toHaveLength(1);
    expect(metricWrites[0]?.blobs?.[0]).toBe('coordinator');
    expect(metricWrites[0]?.blobs?.[1]).toBe('negative-hit');
    fetchMock.mockRestore();
  });

  test('reports write-error when a coordinated upstream asset write fails', async () => {
    const testEnv = {
      ...createTestEnv(false, createCache(), {
        enabledFlags: ['asset-upstream-coordinator'],
      }),
      ASSET_RESOLUTION_COORDINATOR: fakeCoordinator({
        kind: 'asset',
        status: 200,
        data: new Uint8Array([8, 1]),
        contentType: 'image/png',
        extension: '.png',
        timestamp: Date.now(),
        upstreamStatus: 200,
        attempts: 1,
        queueTimeMs: 0,
        joined: false,
        origin: 'upstream',
        cacheWrite: 'failed',
      }),
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    try {
      const response = await worker.fetch(request('7253'), testEnv);

      expect(response.status).toBe(200);
      expect(response.headers.get('X-Cache-Status')).toBe('write-error');
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([8, 1]));
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  test('reports write-error when a coordinated upstream negative-cache write fails', async () => {
    const testEnv = {
      ...createTestEnv(false, createCache(), {
        enabledFlags: ['asset-upstream-coordinator'],
      }),
      ASSET_RESOLUTION_COORDINATOR: fakeCoordinator({
        kind: 'not-found',
        status: 404,
        error: 'Asset not found',
        timestamp: Date.now(),
        upstreamStatus: 404,
        attempts: 1,
        queueTimeMs: 0,
        joined: false,
        origin: 'upstream',
        cacheWrite: 'failed',
      }),
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    try {
      const response = await worker.fetch(request('7254'), testEnv);

      expect(response.status).toBe(404);
      expect(response.headers.get('X-Cache-Status')).toBe('write-error');
      expect(await response.json()).toEqual(
        expect.objectContaining({
          error: 'Asset not found',
        }),
      );
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  test('reports coordinated upstream writes as cache writes only when the coordinator writes succeeded', async () => {
    const timestamp = Date.now();
    const cases: Array<{ assetId: string; result: AssetResolutionResult; cacheStatus: string }> = [
      {
        assetId: '7255',
        cacheStatus: 'miss',
        result: {
          kind: 'asset',
          status: 200,
          data: new Uint8Array([8, 2]),
          contentType: 'image/png',
          extension: '.png',
          timestamp,
          upstreamStatus: 200,
          attempts: 1,
          queueTimeMs: 0,
          joined: false,
          origin: 'upstream',
          cacheWrite: 'written',
        },
      },
      {
        assetId: '7256',
        cacheStatus: 'negative-write',
        result: {
          kind: 'not-found',
          status: 404,
          error: 'Asset not found',
          timestamp,
          upstreamStatus: 404,
          attempts: 1,
          queueTimeMs: 0,
          joined: false,
          origin: 'upstream',
          cacheWrite: 'written',
        },
      },
    ];

    for (const testCase of cases) {
      const response = await worker.fetch(request(testCase.assetId), {
        ...createTestEnv(false, createCache(), {
          enabledFlags: ['asset-upstream-coordinator'],
        }),
        ASSET_RESOLUTION_COORDINATOR: fakeCoordinator(testCase.result),
      });

      expect(response.headers.get('X-Cache-Status')).toBe(testCase.cacheStatus);
    }
  });

  test('serves stale KV bytes without client limiting and refreshes in the background', async () => {
    const assetRequest = request('7301');
    const identity = await buildAssetResolutionIdentity('7301', assetRequest, false);
    await env.assetCache.delete(identity.physicalKey);
    await seedStaleAsset(env.assetCache, identity, new Uint8Array([3]));
    const limiter = vi.fn(async () => ({ success: true }));
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(new Uint8Array([4]), { headers: { 'Content-Type': 'image/png' } }));

    try {
      const context = createExecutionContext();
      const response = await sourceWorker.fetch(
        new IncomingRequest(assetRequest.clone()),
        createTestEnv(false, env.assetCache, {
          enabledFlags: ['asset-cache-layered', 'asset-cache-hit-exempt-limit'],
          rateLimit: limiter,
        }),
        context,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('X-Cache-Status')).toBe('stale-hit');
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([3]));
      expect(limiter).not.toHaveBeenCalled();
      await waitOnExecutionContext(context);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(
        new Uint8Array((await env.assetCache.get(identity.physicalKey, 'arrayBuffer')) ?? new ArrayBuffer(0)),
      ).toEqual(new Uint8Array([4]));
    } finally {
      fetchMock.mockRestore();
      await env.assetCache.delete(identity.physicalKey);
    }
  });

  test('coalesces stale refreshes through the coordinator when the coordinator rollout flag is off', async () => {
    const assetRequest = request('7302');
    const identity = await buildAssetResolutionIdentity('7302', assetRequest, false);
    await env.assetCache.delete(identity.physicalKey);
    await seedStaleAsset(env.assetCache, identity, new Uint8Array([3]));
    const limiter = vi.fn(async () => ({ success: true }));
    const testEnv = createTestEnv(false, env.assetCache, {
      enabledFlags: ['asset-cache-layered', 'asset-cache-hit-exempt-limit'],
      rateLimit: limiter,
    });
    let releaseRefresh: (() => void) | undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let refreshBytes = new Uint8Array([4]);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      await refreshGate;
      return new Response(refreshBytes, { headers: { 'Content-Type': 'image/png' } });
    });
    const contexts = Array.from({ length: 5 }, () => createExecutionContext());

    try {
      const responses = await Promise.all(
        contexts.map((context) => sourceWorker.fetch(new IncomingRequest(assetRequest.clone()), testEnv, context)),
      );

      for (const response of responses) {
        expect(response.status).toBe(200);
        expect(response.headers.get('X-Cache-Status')).toBe('stale-hit');
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([3]));
      }
      expect(limiter).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      releaseRefresh?.();
      await Promise.all(contexts.map((context) => waitOnExecutionContext(context)));
      expect(
        new Uint8Array((await env.assetCache.get(identity.physicalKey, 'arrayBuffer')) ?? new ArrayBuffer(0)),
      ).toEqual(new Uint8Array([4]));

      await seedStaleAsset(env.assetCache, identity, new Uint8Array([4]));
      const laterContext = createExecutionContext();
      refreshBytes = new Uint8Array([5]);
      const later = await sourceWorker.fetch(new IncomingRequest(assetRequest.clone()), testEnv, laterContext);
      expect(later.headers.get('X-Cache-Status')).toBe('stale-hit');
      expect(new Uint8Array(await later.arrayBuffer())).toEqual(new Uint8Array([4]));
      await waitOnExecutionContext(laterContext);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(
        new Uint8Array((await env.assetCache.get(identity.physicalKey, 'arrayBuffer')) ?? new ArrayBuffer(0)),
      ).toEqual(new Uint8Array([5]));
    } finally {
      releaseRefresh?.();
      fetchMock.mockRestore();
      await env.assetCache.delete(identity.physicalKey);
    }
  });

  test('cleans up stale refresh single-flight state after a failed refresh', async () => {
    const assetRequest = request('7303');
    const identity = await buildAssetResolutionIdentity('7303', assetRequest, false);
    await env.assetCache.delete(identity.physicalKey);
    await seedStaleAsset(env.assetCache, identity, new Uint8Array([6]));
    const testEnv = createTestEnv(false, env.assetCache, {
      enabledFlags: ['asset-cache-layered', 'asset-cache-hit-exempt-limit'],
    });
    let refreshAttempts = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      refreshAttempts += 1;
      if (refreshAttempts === 1) throw new Error('Roblox unavailable');
      return new Response(new Uint8Array([7]), { headers: { 'Content-Type': 'image/png' } });
    });

    try {
      const failedContext = createExecutionContext();
      const failed = await sourceWorker.fetch(new IncomingRequest(assetRequest.clone()), testEnv, failedContext);
      expect(failed.status).toBe(200);
      expect(failed.headers.get('X-Cache-Status')).toBe('stale-hit');
      expect(new Uint8Array(await failed.arrayBuffer())).toEqual(new Uint8Array([6]));
      await waitOnExecutionContext(failedContext);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const retryContext = createExecutionContext();
      const retry = await sourceWorker.fetch(new IncomingRequest(assetRequest.clone()), testEnv, retryContext);
      expect(retry.headers.get('X-Cache-Status')).toBe('stale-hit');
      expect(new Uint8Array(await retry.arrayBuffer())).toEqual(new Uint8Array([6]));
      await waitOnExecutionContext(retryContext);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(
        new Uint8Array((await env.assetCache.get(identity.physicalKey, 'arrayBuffer')) ?? new ArrayBuffer(0)),
      ).toEqual(new Uint8Array([7]));
    } finally {
      fetchMock.mockRestore();
      await env.assetCache.delete(identity.physicalKey);
    }
  });

  test('keeps stale coordinator refresh write failures non-blocking and observable', async () => {
    const assetRequest = request('7305');
    const identity = await buildAssetResolutionIdentity('7305', assetRequest, false);
    await env.assetCache.delete(identity.physicalKey);
    await seedStaleAsset(env.assetCache, identity, new Uint8Array([10]));
    const timestamp = Date.now();
    const coordinatorResolve = vi
      .fn<() => Promise<AssetResolutionResult>>()
      .mockResolvedValueOnce({
        kind: 'asset',
        status: 200,
        data: new Uint8Array([11]),
        contentType: 'image/png',
        extension: '.png',
        timestamp,
        upstreamStatus: 200,
        attempts: 1,
        queueTimeMs: 0,
        joined: false,
        origin: 'upstream',
        cacheWrite: 'failed',
      })
      .mockResolvedValueOnce({
        kind: 'asset',
        status: 200,
        data: new Uint8Array([12]),
        contentType: 'image/png',
        extension: '.png',
        timestamp: timestamp + 1,
        upstreamStatus: 200,
        attempts: 1,
        queueTimeMs: 0,
        joined: false,
        origin: 'upstream',
        cacheWrite: 'written',
      });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const testEnv = {
      ...createTestEnv(false, env.assetCache, {
        enabledFlags: ['asset-cache-layered', 'asset-upstream-coordinator'],
      }),
      OBSERVABILITY_REPORT_LEVEL: 'warn',
      ASSET_RESOLUTION_COORDINATOR: {
        getByName: () => ({
          resolve: coordinatorResolve,
        }),
      } as unknown as CloudflareBindings['ASSET_RESOLUTION_COORDINATOR'],
    } as unknown as CloudflareBindings;

    try {
      const failedContext = createExecutionContext();
      const failed = await sourceWorker.fetch(new IncomingRequest(assetRequest.clone()), testEnv, failedContext);
      expect(failed.status).toBe(200);
      expect(failed.headers.get('X-Cache-Status')).toBe('stale-hit');
      expect(new Uint8Array(await failed.arrayBuffer())).toEqual(new Uint8Array([10]));
      await waitOnExecutionContext(failedContext);
      expect(coordinatorResolve).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'asset.cache.stale_refresh_write_failed',
        }),
      );
      expect(
        new Uint8Array((await env.assetCache.get(identity.physicalKey, 'arrayBuffer')) ?? new ArrayBuffer(0)),
      ).toEqual(new Uint8Array([10]));

      const retryContext = createExecutionContext();
      const retry = await sourceWorker.fetch(new IncomingRequest(assetRequest.clone()), testEnv, retryContext);
      expect(retry.status).toBe(200);
      expect(retry.headers.get('X-Cache-Status')).toBe('stale-hit');
      expect(new Uint8Array(await retry.arrayBuffer())).toEqual(new Uint8Array([10]));
      await waitOnExecutionContext(retryContext);
      expect(coordinatorResolve).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
      await env.assetCache.delete(identity.physicalKey);
    }
  });

  test('refreshes stale assets through the coordinator without unverified backpressure during rollout', async () => {
    const assetRequest = request('7304');
    const identity = await buildAssetResolutionIdentity('7304', assetRequest, false);
    await env.assetCache.delete(identity.physicalKey);
    await seedStaleAsset(env.assetCache, identity, new Uint8Array([8]));
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(new Uint8Array([9]), { headers: { 'Content-Type': 'image/png' } }));

    try {
      const context = createExecutionContext();
      const response = await sourceWorker.fetch(
        new IncomingRequest(assetRequest.clone()),
        {
          ...createTestEnv(false, env.assetCache, {
            enabledFlags: ['asset-cache-layered', 'asset-upstream-backpressure'],
          }),
          //@ts-expect-error this is a test env override
          ASSET_COORDINATOR_BUDGET_VERIFIED: 'false',
        },
        context,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('X-Cache-Status')).toBe('stale-hit');
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([8]));
      await waitOnExecutionContext(context);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(
        new Uint8Array((await env.assetCache.get(identity.physicalKey, 'arrayBuffer')) ?? new ArrayBuffer(0)),
      ).toEqual(new Uint8Array([9]));
    } finally {
      fetchMock.mockRestore();
      await env.assetCache.delete(identity.physicalKey);
    }
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

  test('serves upstream asset bytes when the KV write fails', async () => {
    const cache = createCache();

    const putMock = vi.spyOn(cache, 'put').mockRejectedValue(new Error('KV write unavailable'));

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(new Uint8Array([21, 22, 23]), {
          headers: { 'Content-Type': 'image/png' },
        }),
    );

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const testEnv = {
      ...createTestEnv(false, cache),
      OBSERVABILITY_REPORT_LEVEL: 'warn',
    } as unknown as CloudflareBindings;

    try {
      const response = await worker.fetch(request('7601'), testEnv);

      expect(response.status).toBe(200);
      expect(response.headers.get('X-Cache-Status')).toBe('write-error');
      expect(response.headers.get('X-Cache-Hit')).toBe('false');
      expect(response.headers.get('X-Asset-Extension')).toBe('.png');

      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([21, 22, 23]));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(putMock).toHaveBeenCalledTimes(1);

      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'asset.cache.write_failed',
          assetBytes: 3,
        }),
      );
    } finally {
      fetchMock.mockRestore();
      putMock.mockRestore();
      warn.mockRestore();
    }
  });
  test('returns 404 when the negative-cache KV write fails', async () => {
    const cache = createCache();

    const putMock = vi.spyOn(cache, 'put').mockRejectedValue(new Error('KV write unavailable'));

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 404 }));

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const testEnv = {
      ...createTestEnv(false, cache),
      OBSERVABILITY_REPORT_LEVEL: 'warn',
    } as unknown as CloudflareBindings;

    try {
      const response = await worker.fetch(request('7602'), testEnv);
      const body = await response.json<{ error: string }>();

      expect(response.status).toBe(404);
      expect(response.headers.get('X-Cache-Status')).toBe('write-error');
      expect(response.headers.get('X-Cache-Hit')).toBe('false');

      expect(body.error).toBe('Asset not found');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(putMock).toHaveBeenCalledTimes(1);

      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'asset.cache.negative_write_failed',
        }),
      );
    } finally {
      fetchMock.mockRestore();
      putMock.mockRestore();
      warn.mockRestore();
    }
  });
  test('omits the extension header when a coordinator asset has no extension', async () => {
    const timestamp = Date.now();

    const testEnv = {
      ...createTestEnv(false, createCache(), {
        enabledFlags: ['asset-upstream-coordinator'],
      }),
      ASSET_RESOLUTION_COORDINATOR: fakeCoordinator({
        kind: 'asset',
        status: 200,
        data: new Uint8Array([41, 42]),
        contentType: 'application/octet-stream',
        timestamp,
        upstreamStatus: 200,
        attempts: 1,
        queueTimeMs: 0,
        joined: false,
        origin: 'upstream',
        cacheWrite: 'written',
      }),
    } as unknown as CloudflareBindings;

    const response = await worker.fetch(request('7801'), testEnv);

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Asset-Extension')).toBeNull();
    expect(response.headers.get('X-Cache-Hit')).toBe('false');
    expect(response.headers.get('X-Cache-Status')).toBe('miss');
    expect(response.headers.get('X-Cache-Timestamp')).toBe(String(timestamp));
  });

  test('preserves Retry-After and timestamp on a coordinator not-found result', async () => {
    const timestamp = Date.now();

    const testEnv = {
      ...createTestEnv(false, createCache(), {
        enabledFlags: ['asset-upstream-coordinator'],
      }),
      ASSET_RESOLUTION_COORDINATOR: fakeCoordinator({
        kind: 'not-found',
        status: 404,
        error: 'Asset not found',
        timestamp,
        retryAfter: 7,
        upstreamStatus: 404,
        attempts: 1,
        queueTimeMs: 0,
        joined: false,
        origin: 'upstream',
        cacheWrite: 'not-attempted',
      }),
    } as unknown as CloudflareBindings;

    const response = await worker.fetch(request('7802'), testEnv);

    expect(response.status).toBe(404);
    expect(response.headers.get('Retry-After')).toBe('7');
    expect(response.headers.get('X-Cache-Timestamp')).toBe(String(timestamp));
    expect(response.headers.get('X-Cache-Hit')).toBe('false');
  });

  test('returns a coordinator error body without converting it to JSON', async () => {
    const testEnv = {
      ...createTestEnv(false, createCache(), {
        enabledFlags: ['asset-upstream-coordinator'],
      }),
      ASSET_RESOLUTION_COORDINATOR: fakeCoordinator({
        kind: 'error',
        status: 503,
        error: 'Roblox unavailable',
        data: new Uint8Array([51, 52, 53]),
        contentType: 'application/octet-stream',
        upstreamStatus: 503,
        retryAfter: 4,
        attempts: 1,
        queueTimeMs: 0,
        joined: false,
        origin: 'upstream',
        cacheWrite: 'not-attempted',
      }),
    } as unknown as CloudflareBindings;

    const response = await worker.fetch(request('7803'), testEnv);

    expect(response.status).toBe(503);
    expect(response.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(response.headers.get('Retry-After')).toBe('4');

    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([51, 52, 53]));
  });

  test('logs a corrupt KV read and recovers through upstream resolution', async () => {
    const cache = createCache();
    const assetRequest = request('7901');

    const identity = await buildAssetResolutionIdentity('7901', assetRequest, false);

    cache.values.set(identity.physicalKey, {
      value: new Uint8Array([99]).buffer,
      metadata: undefined,
    });

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(new Uint8Array([1, 2]), {
          headers: {
            'Content-Type': 'image/png',
          },
        }),
    );

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const testEnv = {
      ...createTestEnv(false, cache),
      OBSERVABILITY_REPORT_LEVEL: 'warn',
    } as unknown as CloudflareBindings;

    try {
      const response = await worker.fetch(assetRequest, testEnv);

      expect(response.status).toBe(200);

      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2]));

      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'asset.cache.read_failed',
          assetId: '7901',
          errorName: 'TypeError',
        }),
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
      warn.mockRestore();
    }
  });

  test('serves a valid negative KV entry without contacting Roblox', async () => {
    const cache = createCache();
    const assetRequest = request('7902');

    const identity = await buildAssetResolutionIdentity('7902', assetRequest, false);

    const timestamp = Date.now();

    cache.values.set(identity.physicalKey, {
      value: new ArrayBuffer(0),
      metadata: {
        kind: 'not-found',
        timestamp,
      },
    });

    const fetchMock = vi.spyOn(globalThis, 'fetch');

    try {
      const response = await worker.fetch(assetRequest, createTestEnv(false, cache));

      expect(response.status).toBe(404);
      expect(response.headers.get('X-Cache-Hit')).toBe('true');
      expect(response.headers.get('X-Cache-Status')).toBe('negative-hit');
      expect(response.headers.get('X-Cache-Timestamp')).toBe(String(timestamp));

      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  test('keeps a rejected coordinator stale refresh non-blocking', async () => {
    const assetRequest = request('7903');

    const identity = await buildAssetResolutionIdentity('7903', assetRequest, false);

    await env.assetCache.delete(identity.physicalKey);

    await seedStaleAsset(env.assetCache, identity, new Uint8Array([7]));

    const coordinatorResolve = vi.fn(async () => {
      throw new Error('Coordinator unavailable');
    });

    const testEnv = {
      ...createTestEnv(false, env.assetCache, {
        enabledFlags: ['asset-cache-layered', 'asset-upstream-coordinator'],
      }),
      ASSET_RESOLUTION_COORDINATOR: {
        getByName: () => ({
          resolve: coordinatorResolve,
        }),
      } as unknown as CloudflareBindings['ASSET_RESOLUTION_COORDINATOR'],
    } as unknown as CloudflareBindings;

    try {
      const context = createExecutionContext();

      const response = await sourceWorker.fetch(new IncomingRequest(assetRequest.clone()), testEnv, context);

      expect(response.status).toBe(200);
      expect(response.headers.get('X-Cache-Status')).toBe('stale-hit');

      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([7]));

      await waitOnExecutionContext(context);

      expect(coordinatorResolve).toHaveBeenCalledTimes(1);
    } finally {
      await env.assetCache.delete(identity.physicalKey);
    }
  });

  test('maps a lazy asset rate-limit rejection into batch results', async () => {
    const limiter = vi.fn(async () => ({ success: false }));

    const fetchMock = vi.spyOn(globalThis, 'fetch');

    try {
      const response = await worker.fetch(
        batchRequest({
          assetIds: ['7910', '7911'],
        }),
        createTestEnv(false, createCache(), {
          enabledFlags: ['asset-cache-hit-exempt-limit'],
          rateLimit: limiter,
        }),
      );

      expect(response.status).toBe(200);

      const body = (await response.json()) as {
        results: Array<{
          assetId: string;
          status: number;
        }>;
      };

      expect(body.results).toEqual([
        expect.objectContaining({
          assetId: '7910',
          status: 429,
        }),
        expect.objectContaining({
          assetId: '7911',
          status: 429,
        }),
      ]);

      expect(limiter).toHaveBeenCalledTimes(1);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  test('maps an unexpected lazy-limit failure into a batch 500 result', async () => {
    const limiter = vi.fn(async () => {
      throw new Error('Limiter unavailable');
    });

    const fetchMock = vi.spyOn(globalThis, 'fetch');

    try {
      const response = await worker.fetch(
        batchRequest({
          assetIds: ['7912'],
        }),
        createTestEnv(false, createCache(), {
          enabledFlags: ['asset-cache-hit-exempt-limit'],
          rateLimit: limiter,
        }),
      );

      expect(response.status).toBe(200);

      const body = (await response.json()) as {
        results: Array<{
          assetId: string;
          status: number;
          error: string;
        }>;
      };

      expect(body.results).toEqual([
        expect.objectContaining({
          assetId: '7912',
          status: 500,
          error: 'Internal server error',
        }),
      ]);

      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  test('returns coordinator error bytes without optional response headers', async () => {
    const testEnv = {
      ...createTestEnv(false, createCache(), {
        enabledFlags: ['asset-upstream-coordinator'],
      }),
      ASSET_RESOLUTION_COORDINATOR: fakeCoordinator({
        kind: 'error',
        status: 502,
        error: 'Gateway failure',
        data: new Uint8Array([4, 5, 6]),
        attempts: 1,
        queueTimeMs: 0,
        joined: false,
        origin: 'upstream',
        cacheWrite: 'not-attempted',
      }),
    } as unknown as CloudflareBindings;

    const response = await worker.fetch(request('7913'), testEnv);

    expect(response.status).toBe(502);
    expect(response.headers.get('Retry-After')).toBeNull();

    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([4, 5, 6]));
  });

  test('omits optional headers from a coordinator not-found result when absent', async () => {
    const testEnv = {
      ...createTestEnv(false, createCache(), {
        enabledFlags: ['asset-upstream-coordinator'],
      }),
      ASSET_RESOLUTION_COORDINATOR: fakeCoordinator({
        kind: 'not-found',
        status: 404,
        error: 'Asset not found',
        attempts: 1,
        queueTimeMs: 0,
        joined: false,
        origin: 'upstream',
        cacheWrite: 'not-attempted',
      }),
    } as unknown as CloudflareBindings;

    const response = await worker.fetch(request('7914'), testEnv);

    expect(response.status).toBe(404);
    expect(response.headers.get('Retry-After')).toBeNull();
    expect(response.headers.get('X-Cache-Timestamp')).toBeNull();
    expect(response.headers.get('X-Cache-Hit')).toBe('false');
  });

  test('ignores a response-body cancellation failure on a direct 404', async () => {
    const cache = createCache();

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        throw new Error('body cancellation failed');
      },
    });

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(body, {
          status: 404,
        }),
    );

    try {
      const response = await worker.fetch(request('7920'), createTestEnv(false, cache));

      expect(response.status).toBe(404);
      expect(response.headers.get('X-Cache-Status')).toBe('negative-write');

      const payload = await response.json<{
        error: string;
      }>();

      expect(payload.error).toBe('Asset not found');

      expect(fetchMock).toHaveBeenCalledTimes(1);

      // The failed body cancellation must not prevent the
      // negative-cache entry from being written.
      expect(cache.values.size).toBe(1);
    } finally {
      fetchMock.mockRestore();
    }
  });

  test('ignores an L1 population failure after a fresh KV hit', async () => {
    const cache = createCache();
    const assetRequest = request('7921');

    const identity = await buildAssetResolutionIdentity('7921', assetRequest, false);

    const timestamp = Date.now();

    cache.values.set(identity.physicalKey, {
      value: new Uint8Array([21, 22]).buffer,
      metadata: {
        kind: 'asset',
        version: 2,
        timestamp,
        storedAt: timestamp,
        freshUntil: timestamp + 60_000,
        staleUntil: timestamp + 120_000,
        contentType: 'image/png',
        extension: '.png',
      },
    });

    const l1PutMock = vi.spyOn(caches.default, 'put').mockImplementation(async () => {
      throw new Error('Cache API write failed');
    });

    const fetchMock = vi.spyOn(globalThis, 'fetch');

    try {
      const context = createExecutionContext();

      const response = await sourceWorker.fetch(
        new IncomingRequest(assetRequest.clone()),
        createTestEnv(false, cache, {
          enabledFlags: ['asset-cache-layered'],
        }),
        context,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('X-Cache-Status')).toBe('kv-fresh-hit');
      expect(response.headers.get('X-Cache-Hit')).toBe('true');

      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([21, 22]));

      await waitOnExecutionContext(context);

      expect(l1PutMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      l1PutMock.mockRestore();
      fetchMock.mockRestore();
    }
  });

  test('ignores an L1 population failure after an upstream asset miss', async () => {
    const cache = createCache();
    const assetRequest = request('7922');

    const l1PutMock = vi.spyOn(caches.default, 'put').mockImplementation(async () => {
      throw new Error('Cache API write failed');
    });

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(new Uint8Array([31, 32, 33]), {
          headers: {
            'Content-Type': 'image/png',
          },
        }),
    );

    try {
      const context = createExecutionContext();

      const response = await sourceWorker.fetch(
        new IncomingRequest(assetRequest.clone()),
        createTestEnv(false, cache, {
          enabledFlags: ['asset-cache-layered'],
        }),
        context,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('X-Cache-Status')).toBe('miss');
      expect(response.headers.get('X-Cache-Hit')).toBe('false');
      expect(response.headers.get('X-Asset-Extension')).toBe('.png');

      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([31, 32, 33]));

      await waitOnExecutionContext(context);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(l1PutMock).toHaveBeenCalledTimes(1);

      // The normal KV write should still have succeeded even
      // though population of the L1 Cache API failed.
      expect(cache.values.size).toBe(1);
    } finally {
      fetchMock.mockRestore();
      l1PutMock.mockRestore();
    }
  });
});
