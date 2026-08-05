import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, test, vi } from 'vitest';
import { buildAssetResolutionIdentity } from '../src/assets/cache';
import type { AssetCoordinatorRequest, AssetResolutionResult } from '../src/assets/types';

type Permit = {
  queueTimeMs: number;
};

type CoordinatorInternals = {
  resolveUncoalesced(request: AssetCoordinatorRequest): Promise<AssetResolutionResult>;

  acquirePermit(deadline: number): Promise<Permit>;

  releasePermit(): void;
};

function createStub(label: string) {
  return env.ASSET_RESOLUTION_COORDINATOR.getByName(`${label}-${crypto.randomUUID()}`);
}

describe('asset resolution coordinator internals', () => {
  test('reports a failed coordinator asset KV write without failing resolution', async () => {
    const assetId = `9${Date.now()}`;

    const identity = await buildAssetResolutionIdentity(
      assetId,
      new Request(`https://proxy.test/v1/assets/${assetId}`),
      false,
    );

    // Workers KV rejects an empty key. readKv() treats the
    // initial read as a recoverable miss, while writeAssetToKv()
    // fails and exercises the coordinator's cacheWrite fallback.
    const invalidIdentity = {
      ...identity,
      physicalKey: '',
    };

    const stub = createStub('asset-write-failure');

    await runInDurableObject(stub, async (instance) => {
      const coordinator = instance as unknown as CoordinatorInternals;

      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
        async () =>
          new Response(new Uint8Array([1, 2, 3]), {
            headers: {
              'Content-Type': 'image/png',
            },
          }),
      );

      try {
        const result = await coordinator.resolveUncoalesced({
          identity: invalidIdentity,
          deadline: Date.now() + 10_000,
          backpressure: false,
        });

        expect(result).toEqual(
          expect.objectContaining({
            kind: 'asset',
            status: 200,
            origin: 'upstream',
            cacheWrite: 'failed',
          }),
        );
      } finally {
        fetchMock.mockRestore();
      }
    });
  });

  test('ignores a response-body cancellation failure on upstream 429', async () => {
    const assetId = `8${Date.now()}`;

    const identity = await buildAssetResolutionIdentity(
      assetId,
      new Request(`https://proxy.test/v1/assets/${assetId}`),
      false,
    );

    await env.assetCache.delete(identity.physicalKey);

    const stub = createStub('cancel-failure');

    try {
      await runInDurableObject(stub, async (instance) => {
        const coordinator = instance as unknown as CoordinatorInternals;

        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

        const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
          const response = new Response(new Uint8Array([1]), {
            status: 429,
            headers: {
              'Retry-After': '5',
            },
          });

          reader = response.body?.getReader();

          return response;
        });

        try {
          const result = await coordinator.resolveUncoalesced({
            identity,
            deadline: Date.now() + 10_000,
            backpressure: false,
          });

          expect(result).toEqual(
            expect.objectContaining({
              kind: 'error',
              status: 429,
              retryAfter: 5,
              attempts: 1,
              origin: 'upstream',
            }),
          );
        } finally {
          reader?.releaseLock();
          fetchMock.mockRestore();
        }
      });
    } finally {
      await env.assetCache.delete(identity.physicalKey);
    }
  });

  test('returns a timeout when the deadline expires immediately after permit admission', async () => {
    const assetId = `7${Date.now()}`;

    const identity = await buildAssetResolutionIdentity(
      assetId,
      new Request(`https://proxy.test/v1/assets/${assetId}`),
      false,
    );

    await env.assetCache.delete(identity.physicalKey);

    const stub = createStub('deadline-after-permit');

    try {
      await runInDurableObject(stub, async (instance) => {
        const coordinator = instance as unknown as CoordinatorInternals;

        const deadline = 10_000;
        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000);

        const originalAcquirePermit = coordinator.acquirePermit.bind(coordinator);
        const originalReleasePermit = coordinator.releasePermit.bind(coordinator);

        const acquirePermitMock = vi.fn(async () => {
          // Admission succeeds, but the request expires before
          // the upstream fetch begins.
          nowSpy.mockReturnValue(deadline);

          return {
            queueTimeMs: 17,
          };
        });

        const releasePermitMock = vi.fn();

        coordinator.acquirePermit = acquirePermitMock;
        coordinator.releasePermit = releasePermitMock;

        const fetchMock = vi.spyOn(globalThis, 'fetch');

        try {
          const result = await coordinator.resolveUncoalesced({
            identity,
            deadline,
            backpressure: true,
          });

          expect(result).toEqual(
            expect.objectContaining({
              kind: 'error',
              status: 504,
              error: 'Roblox asset delivery timed out',
              attempts: 0,
              queueTimeMs: 17,
              origin: 'admission',
            }),
          );

          expect(acquirePermitMock).toHaveBeenCalledTimes(1);
          expect(releasePermitMock).toHaveBeenCalledTimes(1);
          expect(fetchMock).not.toHaveBeenCalled();
        } finally {
          coordinator.acquirePermit = originalAcquirePermit;
          coordinator.releasePermit = originalReleasePermit;
          fetchMock.mockRestore();
          nowSpy.mockRestore();
        }
      });
    } finally {
      await env.assetCache.delete(identity.physicalKey);
    }
  });

  test('reports a failed negative-cache KV write without failing resolution', async () => {
    const assetId = `6${Date.now()}`;

    const identity = await buildAssetResolutionIdentity(
      assetId,
      new Request(`https://proxy.test/v1/assets/${assetId}`),
      false,
    );

    // As in the asset-write failure test, the empty physical key makes
    // the KV write fail while the initial cache read remains recoverable.
    const invalidIdentity = {
      ...identity,
      physicalKey: '',
    };

    const stub = createStub('not-found-write-failure');

    await runInDurableObject(stub, async (instance) => {
      const coordinator = instance as unknown as CoordinatorInternals;

      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(null, {
          status: 404,
          statusText: 'Not Found',
        }),
      );

      try {
        const result = await coordinator.resolveUncoalesced({
          identity: invalidIdentity,
          deadline: Date.now() + 10_000,
          backpressure: false,
        });

        expect(result).toEqual(
          expect.objectContaining({
            kind: 'not-found',
            status: 404,
            upstreamStatus: 404,
            origin: 'upstream',
            cacheWrite: 'failed',
          }),
        );
      } finally {
        fetchMock.mockRestore();
      }
    });
  });
});
