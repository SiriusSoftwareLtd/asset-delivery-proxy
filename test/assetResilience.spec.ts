import { env } from 'cloudflare:test';
import { describe, expect, test, vi } from 'vitest';
import { buildAssetResolutionIdentity } from '../src/services/assets/cache';
import { parseRetryAfter } from '../src/services/assets/roblox';

let assetIdSequence = 0;

function uniqueAssetId(): string {
  assetIdSequence += 1;
  return `${Date.now()}${assetIdSequence.toString().padStart(4, '0')}`;
}

describe('asset resilience primitives', () => {
  test('parses Retry-After delta seconds and HTTP dates', () => {
    const now = Date.parse('2026-08-03T12:00:00.000Z');
    expect(parseRetryAfter('12', now)).toBe(12);
    expect(parseRetryAfter('Mon, 03 Aug 2026 12:00:09 GMT', now)).toBe(9);
    expect(parseRetryAfter('invalid', now)).toBeUndefined();
  });

  test('coalesces 100 simultaneous same-key coordinator requests', async () => {
    const assetId = uniqueAssetId();
    const request = new Request(`https://proxy.test/assets/${assetId}`);
    const identity = await buildAssetResolutionIdentity(assetId, request, false);
    await env.assetCache.delete(identity.physicalKey);
    const stub = env.ASSET_RESOLUTION_COORDINATOR.getByName(`coalescing-${assetId}`);
    let releaseFetch: (() => void) | undefined;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      await fetchGate;
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } });
    });

    const calls = Array.from({ length: 100 }, () =>
      stub.resolve({ identity, deadline: Date.now() + 10_000, backpressure: false }),
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    releaseFetch?.();
    const results = await Promise.all(calls);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results.every((result) => result.kind === 'asset' && result.status === 200)).toBe(true);
    expect(results.filter((result) => result.joined).length).toBeGreaterThan(0);
    expect(results.filter((result) => !result.joined && result.attempts === 1)).toHaveLength(1);
    expect(results.filter((result) => result.joined || result.origin === 'kv')).toHaveLength(99);
    fetchMock.mockRestore();
    await env.assetCache.delete(identity.physicalKey);
  });

  test('persists a 429 cooldown and suppresses the next cold resolution', async () => {
    const assetId = uniqueAssetId();
    const request = new Request(`https://proxy.test/assets/${assetId}`);
    const identity = await buildAssetResolutionIdentity(assetId, request, false);
    await env.assetCache.delete(identity.physicalKey);
    const stub = env.ASSET_RESOLUTION_COORDINATOR.getByName(`cooldown-${assetId}`);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(null, { status: 429, headers: { 'Retry-After': '5' } }));

    const first = await stub.resolve({ identity, deadline: Date.now() + 10_000, backpressure: true });
    const second = await stub.resolve({ identity, deadline: Date.now() + 10_000, backpressure: true });

    expect(first).toEqual(
      expect.objectContaining({ kind: 'error', status: 429, retryAfter: 5, attempts: 1, origin: 'upstream' }),
    );
    expect(second).toEqual(
      expect.objectContaining({ kind: 'error', status: 429, retryAfter: 5, attempts: 0, origin: 'admission' }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockRestore();
  });

  test('retries one transient upstream response after a new permit', async () => {
    const assetId = uniqueAssetId();
    const request = new Request(`https://proxy.test/assets/${assetId}`);
    const identity = await buildAssetResolutionIdentity(assetId, request, false);
    await env.assetCache.delete(identity.physicalKey);
    const stub = env.ASSET_RESOLUTION_COORDINATOR.getByName(`retry-${assetId}`);
    let attempt = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      attempt += 1;
      return attempt === 1
        ? new Response(null, { status: 503 })
        : new Response(new Uint8Array([5]), { headers: { 'Content-Type': 'image/png' } });
    });

    const result = await stub.resolve({ identity, deadline: Date.now() + 5_000, backpressure: true });

    expect(result).toEqual(expect.objectContaining({ kind: 'asset', status: 200, attempts: 2, origin: 'upstream' }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockRestore();
    await env.assetCache.delete(identity.physicalKey);
  });

  test('marks an already-expired coordinator request as admission without fetching upstream', async () => {
    const assetId = uniqueAssetId();
    const request = new Request(`https://proxy.test/assets/${assetId}`);
    const identity = await buildAssetResolutionIdentity(assetId, request, false);
    await env.assetCache.delete(identity.physicalKey);
    const stub = env.ASSET_RESOLUTION_COORDINATOR.getByName(`expired-${assetId}`);
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    const result = await stub.resolve({ identity, deadline: Date.now() - 1, backpressure: false });

    expect(result).toEqual(
      expect.objectContaining({
        kind: 'error',
        status: 504,
        error: 'Roblox asset delivery timed out',
        attempts: 0,
        origin: 'admission',
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  test('expires a queued coordinator request before it receives a permit', async () => {
    const activeAssetId = uniqueAssetId();
    const expiredAssetId = uniqueAssetId();
    const laterAssetId = uniqueAssetId();
    const activeIdentity = await buildAssetResolutionIdentity(
      activeAssetId,
      new Request(`https://proxy.test/assets/${activeAssetId}`),
      false,
    );
    const expiredIdentity = await buildAssetResolutionIdentity(
      expiredAssetId,
      new Request(`https://proxy.test/assets/${expiredAssetId}`),
      false,
    );
    const laterIdentity = await buildAssetResolutionIdentity(
      laterAssetId,
      new Request(`https://proxy.test/assets/${laterAssetId}`),
      false,
    );
    await Promise.all([
      env.assetCache.delete(activeIdentity.physicalKey),
      env.assetCache.delete(expiredIdentity.physicalKey),
      env.assetCache.delete(laterIdentity.physicalKey),
    ]);
    const stub = env.ASSET_RESOLUTION_COORDINATOR.getByName(`queue-deadline-${activeAssetId}`);
    let releaseFetch: (() => void) | undefined;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      if (fetchMock.mock.calls.length === 1) await fetchGate;
      return new Response(new Uint8Array([7]), { headers: { 'Content-Type': 'image/png' } });
    });

    const active = stub.resolve({ identity: activeIdentity, deadline: Date.now() + 10_000, backpressure: true });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const expired = await stub.resolve({ identity: expiredIdentity, deadline: Date.now() + 50, backpressure: true });

    expect(expired).toEqual(
      expect.objectContaining({
        kind: 'error',
        status: 504,
        error: 'Roblox asset delivery timed out',
        attempts: 0,
        origin: 'admission',
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const later = stub.resolve({ identity: laterIdentity, deadline: Date.now() + 10_000, backpressure: true });
    releaseFetch?.();
    const [activeResult, laterResult] = await Promise.all([active, later]);

    expect(activeResult).toEqual(expect.objectContaining({ kind: 'asset', status: 200, attempts: 1 }));
    expect(laterResult).toEqual(expect.objectContaining({ kind: 'asset', status: 200, attempts: 1 }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockRestore();
    await Promise.all([
      env.assetCache.delete(activeIdentity.physicalKey),
      env.assetCache.delete(expiredIdentity.physicalKey),
      env.assetCache.delete(laterIdentity.physicalKey),
    ]);
  });
  test('negative-caches a coordinator 404 and serves the next request from KV', async () => {
    const assetId = uniqueAssetId();
    const request = new Request(`https://proxy.test/assets/${assetId}`);
    const identity = await buildAssetResolutionIdentity(assetId, request, false);
    await env.assetCache.delete(identity.physicalKey);

    const stub = env.ASSET_RESOLUTION_COORDINATOR.getByName(`negative-cache-${assetId}`);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));

    try {
      const first = await stub.resolve({
        identity,
        deadline: Date.now() + 10_000,
        backpressure: false,
      });

      const second = await stub.resolve({
        identity,
        deadline: Date.now() + 10_000,
        backpressure: false,
      });

      expect(first).toEqual(
        expect.objectContaining({
          kind: 'not-found',
          status: 404,
          attempts: 1,
          origin: 'upstream',
          cacheWrite: 'written',
        }),
      );

      expect(second).toEqual(
        expect.objectContaining({
          kind: 'not-found',
          status: 404,
          attempts: 0,
          origin: 'kv',
          cacheWrite: 'not-attempted',
        }),
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
      await env.assetCache.delete(identity.physicalKey);
    }
  });

  test('uses the fallback cooldown when Roblox omits Retry-After', async () => {
    const assetId = uniqueAssetId();
    const request = new Request(`https://proxy.test/assets/${assetId}`);
    const identity = await buildAssetResolutionIdentity(assetId, request, false);
    await env.assetCache.delete(identity.physicalKey);

    const stub = env.ASSET_RESOLUTION_COORDINATOR.getByName(`fallback-cooldown-${assetId}`);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 429 }));

    try {
      const first = await stub.resolve({
        identity,
        deadline: Date.now() + 10_000,
        backpressure: true,
      });

      const second = await stub.resolve({
        identity,
        deadline: Date.now() + 10_000,
        backpressure: true,
      });

      expect(first).toEqual(
        expect.objectContaining({
          kind: 'error',
          status: 429,
          retryAfter: 30,
          attempts: 1,
          origin: 'upstream',
        }),
      );

      expect(second).toEqual(
        expect.objectContaining({
          kind: 'error',
          status: 429,
          attempts: 0,
          origin: 'admission',
        }),
      );

      if (second.kind !== 'error' || second.status !== 429) {
        throw new Error('Expected coordinator admission cooldown response');
      }

      expect(second.retryAfter).toBeGreaterThan(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
    }
  });

  test('rejects an empty successful upstream asset', async () => {
    const assetId = uniqueAssetId();
    const request = new Request(`https://proxy.test/assets/${assetId}`);
    const identity = await buildAssetResolutionIdentity(assetId, request, false);

    await env.assetCache.delete(identity.physicalKey);

    const stub = env.ASSET_RESOLUTION_COORDINATOR.getByName(`empty-${assetId}`);

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(null, {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        }),
    );

    try {
      const result = await stub.resolve({
        identity,
        deadline: Date.now() + 10_000,
        backpressure: false,
      });

      expect(result).toEqual(
        expect.objectContaining({
          kind: 'error',
          status: 502,
          error: 'Roblox returned an empty asset',
          attempts: 1,
          origin: 'upstream',
          upstreamStatus: 200,
        }),
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
      await env.assetCache.delete(identity.physicalKey);
    }
  });

  test('does not retry a retryable status when backpressure is disabled', async () => {
    const assetId = uniqueAssetId();
    const request = new Request(`https://proxy.test/assets/${assetId}`);
    const identity = await buildAssetResolutionIdentity(assetId, request, false);

    await env.assetCache.delete(identity.physicalKey);

    const stub = env.ASSET_RESOLUTION_COORDINATOR.getByName(`no-retry-${assetId}`);

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('unavailable', { status: 503 }));

    try {
      const result = await stub.resolve({
        identity,
        deadline: Date.now() + 10_000,
        backpressure: false,
      });

      expect(result).toEqual(
        expect.objectContaining({
          kind: 'error',
          status: 503,
          upstreamStatus: 503,
          attempts: 1,
          origin: 'upstream',
        }),
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
      await env.assetCache.delete(identity.physicalKey);
    }
  });

  test('rejects excess callers when the coordinator queue is full', async () => {
    const assetIds = Array.from({ length: 34 }, () => uniqueAssetId());

    const identities = await Promise.all(
      assetIds.map((assetId) =>
        buildAssetResolutionIdentity(assetId, new Request(`https://proxy.test/assets/${assetId}`), false),
      ),
    );

    await Promise.all(identities.map((identity) => env.assetCache.delete(identity.physicalKey)));

    const firstAssetId = assetIds[0];

    if (!firstAssetId) {
      throw new Error('Expected at least one asset ID');
    }

    const stub = env.ASSET_RESOLUTION_COORDINATOR.getByName(`queue-full-${firstAssetId}`);

    let releaseFetch: (() => void) | undefined;

    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      await fetchGate;

      return new Response(new Uint8Array([1]), {
        headers: { 'Content-Type': 'image/png' },
      });
    });

    try {
      const firstIdentity = identities[0];

      if (!firstIdentity) {
        throw new Error('Expected at least one asset identity');
      }

      const active = stub.resolve({
        identity: firstIdentity,
        deadline: Date.now() + 10_000,
        backpressure: true,
      });

      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      const queueDeadline = Date.now() + 1_000;

      const contenders = identities.slice(1).map((identity) =>
        stub.resolve({
          identity,
          deadline: queueDeadline,
          backpressure: true,
        }),
      );

      const results = await Promise.all(contenders);

      expect(results.filter((result) => result.status === 503)).toHaveLength(1);
      expect(results.filter((result) => result.status === 504)).toHaveLength(32);

      // No queued caller should reach Roblox.
      expect(fetchMock).toHaveBeenCalledTimes(1);

      releaseFetch?.();

      expect(await active).toEqual(
        expect.objectContaining({
          kind: 'asset',
          status: 200,
        }),
      );
    } finally {
      releaseFetch?.();
      fetchMock.mockRestore();

      await Promise.all(identities.map((identity) => env.assetCache.delete(identity.physicalKey)));
    }
  });
});
