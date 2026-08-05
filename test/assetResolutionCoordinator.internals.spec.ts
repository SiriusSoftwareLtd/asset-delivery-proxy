import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, test, vi } from 'vitest';
import { buildAssetResolutionIdentity } from '../src/services/assets/cache';
import type { AssetCoordinatorRequest, AssetResolutionResult } from '../src/types/app';

type Permit = {
  queueTimeMs: number;
};

type PermitWaiter = {
  enqueuedAt: number;
  deadline: number;
  resolve: (permit: Permit) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  settled: boolean;
};

type CoordinatorInternals = {
  active: number;
  cooldownUntil: number;
  nextPermitAt: number;
  queue: PermitWaiter[];

  resolveUncoalesced(request: AssetCoordinatorRequest): Promise<AssetResolutionResult>;

  acquirePermit(deadline: number): Promise<Permit>;

  grantPermit(enqueuedAt: number, deadline: number): Promise<Permit>;

  enterCooldown(retryAfter: number): Promise<void>;

  dispatchQueuedPermit(): void;

  expireQueuedWaiters(now?: number): void;

  expireWaiter(waiter: PermitWaiter): void;

  settleWaiter(waiter: PermitWaiter): boolean;
};

function createStub(label: string) {
  return env.ASSET_RESOLUTION_COORDINATOR.getByName(`${label}-${crypto.randomUUID()}`);
}

function createWaiter(
  deadline: number,
  settled = false,
): {
  waiter: PermitWaiter;
  resolve: ReturnType<typeof vi.fn>;
  reject: ReturnType<typeof vi.fn>;
} {
  const resolve = vi.fn((_permit: Permit) => {});
  const reject = vi.fn((_error: Error) => {});

  return {
    waiter: {
      enqueuedAt: Date.now(),
      deadline,
      resolve,
      reject,
      timeout: setTimeout(() => {}, 60_000),
      settled,
    },
    resolve,
    reject,
  };
}

describe('asset resolution coordinator internals', () => {
  test('releases a permit when its deadline expires after scheduling', async () => {
    const stub = createStub('permit-expired-after-scheduling');

    await runInDurableObject(stub, async (instance) => {
      const coordinator = instance as unknown as CoordinatorInternals;

      const nowSpy = vi.spyOn(Date, 'now');

      nowSpy.mockReturnValueOnce(1_000).mockReturnValueOnce(1_000).mockReturnValueOnce(1_200);

      try {
        await expect(coordinator.grantPermit(900, 1_100)).rejects.toThrow('Asset resolution deadline reached');

        expect(coordinator.active).toBe(0);
      } finally {
        nowSpy.mockRestore();
      }
    });
  });

  test('releases a scheduled permit when cooldown begins before grant', async () => {
    const stub = createStub('permit-cooldown-after-scheduling');

    await runInDurableObject(stub, async (instance) => {
      const coordinator = instance as unknown as CoordinatorInternals;

      coordinator.cooldownUntil = 1_500;

      const nowSpy = vi.spyOn(Date, 'now');

      nowSpy.mockReturnValueOnce(1_000).mockReturnValueOnce(1_000).mockReturnValueOnce(1_100);

      try {
        await expect(coordinator.grantPermit(900, 2_000)).rejects.toThrow('Roblox asset delivery is cooling down');

        expect(coordinator.active).toBe(0);
      } finally {
        nowSpy.mockRestore();
        coordinator.cooldownUntil = 0;
      }
    });
  });

  test('skips an already-settled queued waiter during dispatch', async () => {
    const stub = createStub('settled-dispatch');

    await runInDurableObject(stub, async (instance) => {
      const coordinator = instance as unknown as CoordinatorInternals;

      const { waiter, resolve, reject } = createWaiter(Date.now() + 60_000, true);

      coordinator.queue.push(waiter);

      try {
        coordinator.dispatchQueuedPermit();

        expect(coordinator.queue).toHaveLength(0);
        expect(resolve).not.toHaveBeenCalled();
        expect(reject).not.toHaveBeenCalled();
      } finally {
        clearTimeout(waiter.timeout);
      }
    });
  });

  test('dispatches again when a queued permit cannot meet its deadline', async () => {
    const stub = createStub('dispatch-expired-permit');

    await runInDurableObject(stub, async (instance) => {
      const coordinator = instance as unknown as CoordinatorInternals;

      const now = Date.now();

      coordinator.active = 0;
      coordinator.nextPermitAt = now + 10_000;

      const { waiter, resolve, reject } = createWaiter(now + 1_000);

      coordinator.queue.push(waiter);
      coordinator.dispatchQueuedPermit();

      await vi.waitFor(() => {
        expect(reject).toHaveBeenCalledTimes(1);
      });

      expect(resolve).not.toHaveBeenCalled();

      const error = reject.mock.calls[0]?.[0];

      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toBe('Asset resolution deadline reached');

      expect(coordinator.queue).toHaveLength(0);
    });
  });

  test('removes expired waiters while preserving future waiters', async () => {
    const stub = createStub('expire-queued-waiters');

    await runInDurableObject(stub, async (instance) => {
      const coordinator = instance as unknown as CoordinatorInternals;

      const now = Date.now();

      const expired = createWaiter(now - 1);
      const future = createWaiter(now + 60_000);

      coordinator.queue.push(expired.waiter, future.waiter);

      try {
        coordinator.expireQueuedWaiters(now);

        expect(expired.reject).toHaveBeenCalledTimes(1);
        expect(expired.resolve).not.toHaveBeenCalled();

        expect(future.reject).not.toHaveBeenCalled();
        expect(future.resolve).not.toHaveBeenCalled();

        expect(coordinator.queue).toEqual([future.waiter]);
      } finally {
        clearTimeout(expired.waiter.timeout);
        clearTimeout(future.waiter.timeout);
      }
    });
  });

  test('does not settle the same waiter twice', async () => {
    const stub = createStub('settle-once');

    await runInDurableObject(stub, async (instance) => {
      const coordinator = instance as unknown as CoordinatorInternals;

      const { waiter } = createWaiter(Date.now() + 60_000);

      try {
        expect(coordinator.settleWaiter(waiter)).toBe(true);

        expect(waiter.settled).toBe(true);

        expect(coordinator.settleWaiter(waiter)).toBe(false);
      } finally {
        clearTimeout(waiter.timeout);
      }
    });
  });

  test('does not reject an already-settled waiter when entering cooldown', async () => {
    const stub = createStub('cooldown-settled-waiter');

    await runInDurableObject(stub, async (instance) => {
      const coordinator = instance as unknown as CoordinatorInternals;

      const { waiter, reject } = createWaiter(Date.now() + 60_000, true);

      coordinator.queue.push(waiter);

      try {
        await coordinator.enterCooldown(5);

        expect(coordinator.queue).toHaveLength(0);
        expect(reject).not.toHaveBeenCalled();
      } finally {
        clearTimeout(waiter.timeout);
      }
    });
  });

  test('expires a waiter that is no longer present in the queue', async () => {
    const stub = createStub('expire-detached-waiter');

    await runInDurableObject(stub, async (instance) => {
      const coordinator = instance as unknown as CoordinatorInternals;

      const { waiter, reject } = createWaiter(Date.now() - 1);

      coordinator.expireWaiter(waiter);

      expect(reject).toHaveBeenCalledTimes(1);
      expect(coordinator.queue).toHaveLength(0);
    });
  });

  test('reports a failed coordinator asset KV write without failing resolution', async () => {
    const assetId = `9${Date.now()}`;

    const identity = await buildAssetResolutionIdentity(
      assetId,
      new Request(`https://proxy.test/assets/${assetId}`),
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
      new Request(`https://proxy.test/assets/${assetId}`),
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
      new Request(`https://proxy.test/assets/${assetId}`),
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

        const acquirePermitMock = vi.fn(async () => {
          // Mirror the real grantPermit() admission accounting so
          // the test verifies that the admitted permit is released.
          coordinator.active += 1;

          // Admission succeeds, but the request expires before
          // the upstream fetch begins.
          nowSpy.mockReturnValue(deadline);

          return {
            queueTimeMs: 17,
          };
        });

        coordinator.acquirePermit = acquirePermitMock;

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
          expect(fetchMock).not.toHaveBeenCalled();

          // The mocked admission increments active to 1. The
          // resolveUncoalesced() cleanup path must release it.
          expect(coordinator.active).toBe(0);
        } finally {
          coordinator.acquirePermit = originalAcquirePermit;
          fetchMock.mockRestore();
          nowSpy.mockRestore();
        }
      });
    } finally {
      await env.assetCache.delete(identity.physicalKey);
    }
  });
});
