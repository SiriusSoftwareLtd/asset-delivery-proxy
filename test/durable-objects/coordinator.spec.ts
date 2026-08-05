import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, test, vi } from 'vitest';
import type { AssetCoordinatorRequest, AssetResolutionResult } from '../../src/assets/types';
import type { Permit } from '../../src/durable-objects/assetResolutionCoordinator';
import { AssetResolutionPermitDeadlineError } from '../../src/durable-objects/assetResolutionPermitQueue';
import { buildAssetResolutionIdentity } from '../../src/services/assets/cache';

type CoordinatorInternals = {
  cooldownUntil: number;
  retryBaseMs: number;

  inFlight: Map<string, Promise<AssetResolutionResult>>;

  resolve(request: AssetCoordinatorRequest): Promise<AssetResolutionResult>;
  resolveUncoalesced(request: AssetCoordinatorRequest): Promise<AssetResolutionResult>;

  acquirePermit(deadline: number): Promise<Permit>;
  releasePermit(): void;

  permitQueue: {
    acquire(deadline: number): Promise<Permit>;
  };
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

    // Workers KV rejects an empty key. readKv() treats the initial read
    // as a recoverable miss, while writeAssetToKv() fails and exercises
    // the coordinator's cacheWrite fallback.
    const invalidIdentity = {
      ...identity,
      physicalKey: '',
    };

    const stub = createStub('asset-write-failure');

    await runInDurableObject(stub, async (instance) => {
      const coordinator = instance as unknown as CoordinatorInternals;

      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
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

        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        fetchMock.mockRestore();
      }
    });
  });

  test('reports a failed negative-cache KV write without failing resolution', async () => {
    const assetId = `8${Date.now()}`;

    const identity = await buildAssetResolutionIdentity(
      assetId,
      new Request(`https://proxy.test/v1/assets/${assetId}`),
      false,
    );

    // The empty physical key makes the negative-cache write fail while
    // preserving the successful upstream not-found resolution.
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

        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        fetchMock.mockRestore();
      }
    });
  });

  test.each([
    {
      name: 'the fallback error message',
      statusText: '',
      expectedError: 'Too Many Requests',
    },
    {
      name: 'the upstream status text',
      statusText: 'Rate Limited',
      expectedError: 'Rate Limited',
    },
  ])(
    'ignores a response-body cancellation failure on upstream 429 and uses $name',
    async ({ statusText, expectedError }) => {
      const assetId = `${statusText ? '7' : '6'}${Date.now()}`;

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
              statusText,
              headers: {
                'Retry-After': '5',
              },
            });

            // Locking the body causes response.body.cancel() to reject.
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
                error: expectedError,
                retryAfter: 5,
                attempts: 1,
                origin: 'upstream',
              }),
            );

            expect(fetchMock).toHaveBeenCalledTimes(1);
          } finally {
            reader?.releaseLock();
            fetchMock.mockRestore();
          }
        });
      } finally {
        await env.assetCache.delete(identity.physicalKey);
      }
    },
  );

  test('returns a timeout when the deadline expires immediately after permit admission', async () => {
    const assetId = `6${Date.now()}`;

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
          // Admission succeeds, but the deadline expires before the
          // coordinator starts the upstream request.
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

  test('maps a permit queue deadline during retry admission to an upstream timeout', async () => {
    const assetId = `5${Date.now()}`;

    const identity = await buildAssetResolutionIdentity(
      assetId,
      new Request(`https://proxy.test/v1/assets/${assetId}`),
      false,
    );

    await env.assetCache.delete(identity.physicalKey);

    const stub = createStub('permit-deadline-after-retry');

    try {
      await runInDurableObject(stub, async (instance) => {
        const coordinator = instance as unknown as CoordinatorInternals;

        const originalRetryBaseMs = coordinator.retryBaseMs;
        coordinator.retryBaseMs = 1;

        const acquireMock = vi
          .spyOn(coordinator.permitQueue, 'acquire')
          .mockResolvedValueOnce({
            queueTimeMs: 0,
          })
          .mockRejectedValueOnce(new AssetResolutionPermitDeadlineError());

        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
          new Response(null, {
            status: 503,
          }),
        );

        try {
          const result = await coordinator.resolveUncoalesced({
            identity,
            deadline: Date.now() + 10_000,
            backpressure: true,
          });

          expect(result).toEqual(
            expect.objectContaining({
              kind: 'error',
              status: 504,
              error: 'Roblox asset delivery timed out',
              attempts: 1,
              queueTimeMs: 0,
              origin: 'upstream',
            }),
          );

          expect(acquireMock).toHaveBeenCalledTimes(2);
          expect(fetchMock).toHaveBeenCalledTimes(1);
        } finally {
          coordinator.retryBaseMs = originalRetryBaseMs;

          acquireMock.mockRestore();
          fetchMock.mockRestore();
        }
      });
    } finally {
      await env.assetCache.delete(identity.physicalKey);
    }
  });

  test.each([
    {
      name: 'a failed upstream request',
      mockFetch: () => Promise.reject(new Error('upstream connection failed')),
    },
    {
      name: 'a retryable upstream response',
      mockFetch: () =>
        Promise.resolve(
          new Response(null, {
            status: 503,
            statusText: 'Service Unavailable',
          }),
        ),
    },
  ])('does not retry $name when the deadline expires during retry backoff', async ({ mockFetch }) => {
    const assetId = `4${Date.now()}`;

    const identity = await buildAssetResolutionIdentity(
      assetId,
      new Request(`https://proxy.test/v1/assets/${assetId}`),
      false,
    );

    await env.assetCache.delete(identity.physicalKey);

    const stub = createStub('retry-backoff-deadline');

    try {
      await runInDurableObject(stub, async (instance) => {
        const coordinator = instance as unknown as CoordinatorInternals;

        let now = 1_000;
        const deadline = 2_000;

        const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);

        const originalAcquirePermit = coordinator.acquirePermit.bind(coordinator);
        const originalReleasePermit = coordinator.releasePermit.bind(coordinator);

        const acquirePermitMock = vi.fn(async () => ({
          queueTimeMs: 0,
        }));

        const releasePermitMock = vi.fn(() => {
          now = deadline;
        });

        coordinator.acquirePermit = acquirePermitMock;
        coordinator.releasePermit = releasePermitMock;

        const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(mockFetch);

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
              attempts: 1,
              queueTimeMs: 0,
              origin: 'upstream',
            }),
          );

          expect(acquirePermitMock).toHaveBeenCalledTimes(1);
          expect(releasePermitMock).toHaveBeenCalledTimes(1);
          expect(fetchMock).toHaveBeenCalledTimes(1);
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

  test('releases a scheduled permit when cooldown begins before grant', async () => {
    const stub = createStub('permit-cooldown-after-scheduling');

    await runInDurableObject(stub, async (instance) => {
      const coordinator = instance as unknown as CoordinatorInternals;

      const originalAcquire = coordinator.permitQueue.acquire.bind(coordinator.permitQueue);
      const releasePermit = vi.spyOn(coordinator, 'releasePermit');

      coordinator.cooldownUntil = 0;

      vi.spyOn(coordinator.permitQueue, 'acquire').mockImplementation(async () => {
        // Simulate another request receiving a 429 while this
        // permit is waiting for its scheduled grant.
        coordinator.cooldownUntil = Date.now() + 5_000;

        return {
          queueTimeMs: 100,
        };
      });

      try {
        await expect(coordinator.acquirePermit(Date.now() + 10_000)).rejects.toThrow(
          'Roblox asset delivery is cooling down',
        );

        expect(releasePermit).toHaveBeenCalledTimes(1);
      } finally {
        coordinator.permitQueue.acquire = originalAcquire;
        coordinator.cooldownUntil = 0;
      }
    });
  });

  test('rejects permit acquisition when the deadline has already expired', async () => {
    const stub = createStub('expired-permit-deadline');

    await runInDurableObject(stub, async (instance) => {
      const coordinator = instance as unknown as CoordinatorInternals;

      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000);
      const acquireMock = vi.spyOn(coordinator.permitQueue, 'acquire');

      try {
        await expect(coordinator.acquirePermit(1_000)).rejects.toThrow('Asset resolution deadline reached');

        expect(acquireMock).not.toHaveBeenCalled();
      } finally {
        acquireMock.mockRestore();
        nowSpy.mockRestore();
      }
    });
  });

  test('does not remove a replacement in-flight operation when an older operation finishes', async () => {
    const assetId = `3${Date.now()}`;

    const identity = await buildAssetResolutionIdentity(
      assetId,
      new Request(`https://proxy.test/v1/assets/${assetId}`),
      false,
    );

    const stub = createStub('in-flight-replacement');

    await runInDurableObject(stub, async (instance) => {
      const coordinator = instance as unknown as CoordinatorInternals;

      let releaseOperation!: () => void;

      const operationGate = new Promise<void>((resolve) => {
        releaseOperation = resolve;
      });

      const result: AssetResolutionResult = {
        kind: 'error',
        status: 503,
        error: 'test result',
        attempts: 0,
        queueTimeMs: 0,
        joined: false,
        origin: 'admission',
        cacheWrite: 'not-attempted',
      };

      const resolveMock = vi.spyOn(coordinator, 'resolveUncoalesced').mockImplementation(async () => {
        await operationGate;
        return result;
      });

      try {
        const operation = coordinator.resolve({
          identity,
          deadline: Date.now() + 10_000,
          backpressure: false,
        });

        await vi.waitFor(() => {
          expect(resolveMock).toHaveBeenCalledTimes(1);
        });

        const replacement = Promise.resolve(result);

        coordinator.inFlight.set(identity.canonicalKey, replacement);

        releaseOperation();

        await operation;

        expect(coordinator.inFlight.get(identity.canonicalKey)).toBe(replacement);
      } finally {
        releaseOperation();
        coordinator.inFlight.delete(identity.canonicalKey);
        resolveMock.mockRestore();
      }
    });
  });
});
