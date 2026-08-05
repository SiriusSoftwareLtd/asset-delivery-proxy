/*
 * Copyright (c) 2026 Corridon Capital
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { env } from 'cloudflare:test';
import { describe, expect, test, vi } from 'vitest';
import { buildAssetResolutionIdentity } from '../src/services/assets/cache';

let assetIdSequence = 0;

function uniqueAssetId(): string {
  assetIdSequence += 1;
  return `${Date.now()}${assetIdSequence.toString().padStart(4, '0')}`;
}

describe('asset resilience primitives', () => {
  test('coalesces 100 simultaneous same-key coordinator requests', async () => {
    const assetId = uniqueAssetId();
    const request = new Request(`https://proxy.test/v1/assets/${assetId}`);
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
    const request = new Request(`https://proxy.test/v1/assets/${assetId}`);
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
    const request = new Request(`https://proxy.test/v1/assets/${assetId}`);
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

  test('retries once when the upstream fetch fails before receiving a response', async () => {
    const assetId = uniqueAssetId();
    const request = new Request(`https://proxy.test/v1/assets/${assetId}`);
    const identity = await buildAssetResolutionIdentity(assetId, request, false);

    await env.assetCache.delete(identity.physicalKey);

    const stub = env.ASSET_RESOLUTION_COORDINATOR.getByName(`fetch-retry-${assetId}`);

    let attempt = 0;

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      attempt += 1;

      if (attempt === 1) {
        throw new Error('upstream connection failed');
      }

      return new Response(new Uint8Array([5]), {
        headers: {
          'Content-Type': 'image/png',
        },
      });
    });

    try {
      const result = await stub.resolve({
        identity,
        deadline: Date.now() + 5_000,
        backpressure: true,
      });

      expect(result).toEqual(
        expect.objectContaining({
          kind: 'asset',
          status: 200,
          attempts: 2,
          origin: 'upstream',
        }),
      );

      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      fetchMock.mockRestore();
      await env.assetCache.delete(identity.physicalKey);
    }
  });

  test('marks an already-expired coordinator request as admission without fetching upstream', async () => {
    const assetId = uniqueAssetId();
    const request = new Request(`https://proxy.test/v1/assets/${assetId}`);
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

  test('negative-caches a coordinator 404 and serves the next request from KV', async () => {
    const assetId = uniqueAssetId();
    const request = new Request(`https://proxy.test/v1/assets/${assetId}`);
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
    const request = new Request(`https://proxy.test/v1/assets/${assetId}`);
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
    const request = new Request(`https://proxy.test/v1/assets/${assetId}`);
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

  test.each([
    {
      name: 'the fallback error message',
      statusText: '',
      expectedError: 'Roblox asset delivery failed',
    },
    {
      name: 'the upstream status text',
      statusText: 'Service Unavailable',
      expectedError: 'Service Unavailable',
    },
  ])(
    'does not retry a retryable status when backpressure is disabled and uses $name',
    async ({ statusText, expectedError }) => {
      const assetId = uniqueAssetId();

      const request = new Request(`https://proxy.test/v1/assets/${assetId}`);

      const identity = await buildAssetResolutionIdentity(assetId, request, false);

      await env.assetCache.delete(identity.physicalKey);

      const stub = env.ASSET_RESOLUTION_COORDINATOR.getByName(`no-retry-${assetId}`);

      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
        async () =>
          new Response('unavailable', {
            status: 503,
            statusText,
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
            status: 503,
            error: expectedError,
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
    },
  );

  test('serves a sequential coordinator request from fresh KV', async () => {
    const assetId = uniqueAssetId();
    const request = new Request(`https://proxy.test/v1/assets/${assetId}`);
    const identity = await buildAssetResolutionIdentity(assetId, request, false);

    await env.assetCache.delete(identity.physicalKey);

    const stub = env.ASSET_RESOLUTION_COORDINATOR.getByName(`fresh-kv-${assetId}`);

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: {
            'Content-Type': 'image/png',
          },
        }),
    );

    try {
      const first = await stub.resolve({
        identity,
        deadline: Date.now() + 10_000,
        backpressure: false,
      });

      expect(first).toEqual(
        expect.objectContaining({
          kind: 'asset',
          status: 200,
          attempts: 1,
          origin: 'upstream',
          cacheWrite: 'written',
        }),
      );

      const second = await stub.resolve({
        identity,
        deadline: Date.now() + 10_000,
        backpressure: false,
      });

      expect(second).toEqual(
        expect.objectContaining({
          kind: 'asset',
          status: 200,
          attempts: 0,
          origin: 'kv',
          cacheWrite: 'not-attempted',
        }),
      );

      if (second.kind !== 'asset') {
        throw new Error('Expected cached asset result');
      }

      expect(second.data).toEqual(new Uint8Array([1, 2, 3]));
      expect(second.contentType).toBe('image/png');

      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
      await env.assetCache.delete(identity.physicalKey);
    }
  });

  test('rejects queued callers when an active request enters cooldown', async () => {
    const assetIds = Array.from({ length: 34 }, () => uniqueAssetId());

    const identities = await Promise.all(
      assetIds.map((assetId) =>
        buildAssetResolutionIdentity(assetId, new Request(`https://proxy.test/v1/assets/${assetId}`), false),
      ),
    );

    await Promise.all(identities.map((identity) => env.assetCache.delete(identity.physicalKey)));

    const firstIdentity = identities[0];

    if (!firstIdentity) {
      throw new Error('Expected an active asset identity');
    }

    const stub = env.ASSET_RESOLUTION_COORDINATOR.getByName(`queued-cooldown-${firstIdentity.assetId}`);

    let releaseFetch: (() => void) | undefined;

    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      await fetchGate;

      return new Response(null, {
        status: 429,
        headers: {
          'Retry-After': '5',
        },
      });
    });

    try {
      const active = stub.resolve({
        identity: firstIdentity,
        deadline: Date.now() + 15_000,
        backpressure: true,
      });

      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      const contenderPromises = identities.slice(1).map((identity) =>
        stub.resolve({
          identity,
          deadline: Date.now() + 10_000,
          backpressure: true,
        }),
      );

      // 32 callers fit in the queue and one caller should fail immediately
      // because the configured queue limit is 32.
      const firstSettled = await Promise.race(contenderPromises);

      expect(firstSettled).toEqual(
        expect.objectContaining({
          kind: 'error',
          status: 503,
          origin: 'admission',
        }),
      );

      // The queue is now populated. Let the active request receive its 429.
      releaseFetch?.();

      const [activeResult, contenderResults] = await Promise.all([active, Promise.all(contenderPromises)]);

      expect(activeResult).toEqual(
        expect.objectContaining({
          kind: 'error',
          status: 429,
          retryAfter: 5,
          attempts: 1,
          origin: 'upstream',
        }),
      );

      expect(contenderResults.filter((result) => result.status === 503)).toHaveLength(1);

      expect(
        contenderResults.filter(
          (result) => result.kind === 'error' && result.status === 429 && result.origin === 'admission',
        ),
      ).toHaveLength(32);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      releaseFetch?.();
      fetchMock.mockRestore();

      await Promise.all(identities.map((identity) => env.assetCache.delete(identity.physicalKey)));
    }
  });

  test('returns a single upstream rejection when backpressure is disabled', async () => {
    const assetId = uniqueAssetId();
    const request = new Request(`https://proxy.test/v1/assets/${assetId}`);
    const identity = await buildAssetResolutionIdentity(assetId, request, false);

    await env.assetCache.delete(identity.physicalKey);

    const stub = env.ASSET_RESOLUTION_COORDINATOR.getByName(`network-rejection-${assetId}`);

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network unavailable'));

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
          error: 'Unable to reach Roblox asset delivery',
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
});
