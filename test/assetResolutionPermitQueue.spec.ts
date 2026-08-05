import { describe, expect, it, vi } from 'vitest';
import {
  AssetResolutionPermitDeadlineError,
  AssetResolutionPermitQueue,
  AssetResolutionQueueFullError,
} from '../src/durable-objects/assetResolutionPermitQueue';

type PermitQueueWaiter = {
  enqueuedAt: number;
  deadline: number;
  resolve: (permit: { queueTimeMs: number }) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  settled: boolean;
};

type PermitQueueInternals = {
  waiters: PermitQueueWaiter[];
  expireWaiter(waiter: PermitQueueWaiter): void;
};

describe('AssetResolutionPermitQueue', () => {
  it('grants a permit and dispatches the next queued caller after release', async () => {
    const queue = new AssetResolutionPermitQueue(1, 1, 0);

    const first = await queue.acquire(Date.now() + 1_000);
    const second = queue.acquire(Date.now() + 1_000);

    expect(first.queueTimeMs).toBeGreaterThanOrEqual(0);
    expect(queue.activeCount).toBe(1);
    expect(queue.queuedCount).toBe(1);

    queue.release();

    await expect(second).resolves.toMatchObject({
      queueTimeMs: expect.any(Number),
    });

    expect(queue.activeCount).toBe(1);
    expect(queue.queuedCount).toBe(0);

    queue.release();

    expect(queue.activeCount).toBe(0);
  });

  it('rejects a caller when the queue is full', async () => {
    const queue = new AssetResolutionPermitQueue(1, 0, 0);

    await queue.acquire(Date.now() + 1_000);

    await expect(queue.acquire(Date.now() + 1_000)).rejects.toBeInstanceOf(AssetResolutionQueueFullError);

    queue.release();
  });

  it('rejects a deadline that has already been reached', async () => {
    const queue = new AssetResolutionPermitQueue(1, 1, 0);

    await expect(queue.acquire(Date.now())).rejects.toBeInstanceOf(AssetResolutionPermitDeadlineError);

    expect(queue.activeCount).toBe(0);
    expect(queue.queuedCount).toBe(0);
  });

  it('expires a queued caller when its deadline is reached', async () => {
    vi.useFakeTimers();

    try {
      vi.setSystemTime(new Date(1_000));

      const queue = new AssetResolutionPermitQueue(1, 1, 0);

      await queue.acquire(2_000);

      const queued = queue.acquire(1_100);

      expect(queue.queuedCount).toBe(1);

      // Attach the rejection handler before advancing the timer that
      // causes the promise to reject.
      const rejection = expect(queued).rejects.toBeInstanceOf(AssetResolutionPermitDeadlineError);

      await vi.advanceTimersByTimeAsync(100);

      await rejection;

      expect(queue.queuedCount).toBe(0);

      queue.release();

      expect(queue.activeCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('expires queued work during dispatch when its deadline has passed', async () => {
    vi.useFakeTimers();

    try {
      vi.setSystemTime(new Date(1_000));

      const queue = new AssetResolutionPermitQueue(1, 1, 0);

      await queue.acquire(2_000);

      const queued = queue.acquire(1_100);

      // Move Date.now() past the deadline without running the waiter's timer.
      vi.setSystemTime(new Date(1_200));

      const rejection = expect(queued).rejects.toBeInstanceOf(AssetResolutionPermitDeadlineError);

      queue.release();

      await rejection;

      expect(queue.queuedCount).toBe(0);
      expect(queue.activeCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves a queued caller whose deadline has not expired', async () => {
    vi.useFakeTimers();

    try {
      vi.setSystemTime(new Date(1_000));

      const queue = new AssetResolutionPermitQueue(1, 1, 0);

      await queue.acquire(5_000);

      const queued = queue.acquire(4_000);

      expect(queue.queuedCount).toBe(1);

      // acquire() performs an expiration sweep. The existing waiter is
      // still valid, so it must remain queued and keep the queue full.
      await expect(queue.acquire(3_000)).rejects.toBeInstanceOf(AssetResolutionQueueFullError);

      expect(queue.queuedCount).toBe(1);

      queue.release();

      await expect(queued).resolves.toMatchObject({
        queueTimeMs: expect.any(Number),
      });

      expect(queue.queuedCount).toBe(0);
      expect(queue.activeCount).toBe(1);

      queue.release();

      expect(queue.activeCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects all queued callers when requested', async () => {
    const queue = new AssetResolutionPermitQueue(1, 2, 0);

    await queue.acquire(Date.now() + 1_000);

    const firstQueued = queue.acquire(Date.now() + 1_000);
    const secondQueued = queue.acquire(Date.now() + 1_000);

    expect(queue.queuedCount).toBe(2);

    const error = new Error('cooldown');

    const firstRejection = expect(firstQueued).rejects.toBe(error);
    const secondRejection = expect(secondQueued).rejects.toBe(error);

    queue.rejectQueued(error);

    await Promise.all([firstRejection, secondRejection]);

    expect(queue.queuedCount).toBe(0);
    expect(queue.activeCount).toBe(1);

    queue.release();

    expect(queue.activeCount).toBe(0);
  });

  it('does not allow the active permit count to become negative', () => {
    const queue = new AssetResolutionPermitQueue(1, 1, 0);

    expect(queue.activeCount).toBe(0);

    queue.release();
    queue.release();

    expect(queue.activeCount).toBe(0);
  });

  it('waits for the scheduled permit interval before granting another permit', async () => {
    vi.useFakeTimers();

    try {
      vi.setSystemTime(new Date(1_000));

      const queue = new AssetResolutionPermitQueue(1, 1, 50);

      await queue.acquire(2_000);
      queue.release();

      const second = queue.acquire(2_000);

      let settled = false;

      void second.finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(49);

      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);

      await expect(second).resolves.toMatchObject({
        queueTimeMs: 50,
      });

      queue.release();
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores persisted permit timing', async () => {
    vi.useFakeTimers();

    try {
      vi.setSystemTime(new Date(1_000));

      const values = new Map<string, number>([['nextPermitAt', 1_100]]);

      const storage = {
        get: async (key: string) => values.get(key),
        put: async (key: string, value: number) => {
          values.set(key, value);
        },
      } as unknown as DurableObjectStorage;

      const queue = new AssetResolutionPermitQueue(1, 1, 50, storage);

      await queue.restore();

      const permit = queue.acquire(2_000);

      let settled = false;

      void permit.finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(99);

      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);

      await expect(permit).resolves.toMatchObject({
        queueTimeMs: 100,
      });

      expect(values.get('nextPermitAt')).toBe(1_150);

      queue.release();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects when restored permit timing cannot meet the deadline', async () => {
    vi.useFakeTimers();

    try {
      vi.setSystemTime(new Date(1_000));

      const storage = {
        get: async () => 2_000,
        put: async () => {},
      } as unknown as DurableObjectStorage;

      const queue = new AssetResolutionPermitQueue(1, 1, 0, storage);

      await queue.restore();

      await expect(queue.acquire(1_500)).rejects.toBeInstanceOf(AssetResolutionPermitDeadlineError);

      expect(queue.activeCount).toBe(0);
      expect(queue.queuedCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases a permit when persisted timing cannot be written', async () => {
    const storage = {
      get: async () => 0,
      put: async () => {
        throw new Error('storage unavailable');
      },
    } as unknown as DurableObjectStorage;

    const queue = new AssetResolutionPermitQueue(1, 0, 0, storage);

    await expect(queue.acquire(Date.now() + 1_000)).rejects.toThrow('storage unavailable');

    expect(queue.activeCount).toBe(0);
  });

  it('releases a permit when its deadline expires while persisting permit timing', async () => {
    let now = 1_000;

    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);

    const storage = {
      get: async () => 0,
      put: async () => {
        // Simulate the storage write taking long enough for the request
        // deadline to expire.
        now = 1_200;
      },
    } as unknown as DurableObjectStorage;

    const queue = new AssetResolutionPermitQueue(1, 0, 0, storage);

    try {
      await expect(queue.acquire(1_100)).rejects.toBeInstanceOf(AssetResolutionPermitDeadlineError);

      expect(queue.activeCount).toBe(0);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('ignores a stale timeout callback after a queued caller has been dispatched', async () => {
    const queue = new AssetResolutionPermitQueue(1, 1, 0);

    await queue.acquire(Date.now() + 1_000);

    const queued = queue.acquire(Date.now() + 1_000);

    const internals = queue as unknown as PermitQueueInternals;

    const waiter = internals.waiters[0];

    if (!waiter) {
      throw new Error('Expected a queued permit waiter');
    }

    expect(queue.activeCount).toBe(1);
    expect(queue.queuedCount).toBe(1);
    expect(waiter.settled).toBe(false);

    // Dispatching removes and settles the waiter.
    queue.release();

    await expect(queued).resolves.toMatchObject({
      queueTimeMs: expect.any(Number),
    });

    expect(queue.activeCount).toBe(1);
    expect(queue.queuedCount).toBe(0);
    expect(waiter.settled).toBe(true);

    // Simulate a stale timeout callback arriving after the waiter has
    // already been granted. It must not reject or mutate queue state.
    internals.expireWaiter(waiter);

    expect(queue.activeCount).toBe(1);
    expect(queue.queuedCount).toBe(0);
    expect(waiter.settled).toBe(true);

    queue.release();

    expect(queue.activeCount).toBe(0);
  });

  it('continues dispatching after a queued caller cannot meet permit timing', async () => {
    vi.useFakeTimers();

    try {
      vi.setSystemTime(new Date(1_000));

      const queue = new AssetResolutionPermitQueue(1, 2, 100);

      await queue.acquire(5_000);

      const unschedulable = queue.acquire(1_050);
      const schedulable = queue.acquire(2_000);

      expect(queue.activeCount).toBe(1);
      expect(queue.queuedCount).toBe(2);

      const rejection = expect(unschedulable).rejects.toBeInstanceOf(AssetResolutionPermitDeadlineError);

      queue.release();

      await rejection;

      // The failed waiter must not leave the queue idle. The next waiter
      // should already own the active slot while it waits for t=1_100.
      expect(queue.activeCount).toBe(1);
      expect(queue.queuedCount).toBe(0);

      await vi.advanceTimersByTimeAsync(100);

      await expect(schedulable).resolves.toMatchObject({
        queueTimeMs: 100,
      });

      queue.release();

      expect(queue.activeCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
