import { describe, expect, it, vi } from 'vitest';
import {
  AssetResolutionPermitDeadlineError,
  AssetResolutionPermitQueue,
  AssetResolutionQueueFullError,
} from '../src/durable-objects/assetResolutionPermitQueue';

describe('AssetResolutionPermitQueue', () => {
  it('grants permits and releases queued work', async () => {
    const queue = new AssetResolutionPermitQueue(1, 1, 0);
    const first = await queue.acquire(Date.now() + 1_000);
    const second = queue.acquire(Date.now() + 1_000);
    expect(queue.activeCount).toBe(1);
    queue.release();
    await expect(second).resolves.toMatchObject({ queueTimeMs: expect.any(Number) });
    expect(first.queueTimeMs).toBeGreaterThanOrEqual(0);
    queue.release();
  });

  it('rejects a full queue', async () => {
    const queue = new AssetResolutionPermitQueue(1, 0, 0);
    await queue.acquire(Date.now() + 1_000);
    await expect(queue.acquire(Date.now() + 1_000)).rejects.toBeInstanceOf(AssetResolutionQueueFullError);
  });

  it('does not retain expired waiters', async () => {
    const queue = new AssetResolutionPermitQueue(1, 1, 0);
    await queue.acquire(Date.now() + 1_000);
    const deadline = Date.now() + 10;
    const queued = queue.acquire(deadline);
    await expect(queued).rejects.toBeInstanceOf(AssetResolutionPermitDeadlineError);
    queue.release();
    expect(queue.queuedCount).toBe(0);
  });

  it('restores persisted permit timing and rejects queued callers', async () => {
    const values = new Map<string, number>([['nextPermitAt', Date.now() - 1]]);
    const storage = {
      get: async (key: string) => values.get(key),
      put: async (key: string, value: number) => {
        values.set(key, value);
      },
    } as unknown as DurableObjectStorage;
    const queue = new AssetResolutionPermitQueue(1, 1, 1, storage);
    await queue.restore();
    await queue.acquire(Date.now() + 1_000);
    const queued = queue.acquire(Date.now() + 1_000);
    const error = new Error('cooldown');
    queue.rejectQueued(error);
    await expect(queued).rejects.toBe(error);
    queue.release();
    expect(values.has('nextPermitAt')).toBe(true);
  });

  it('waits for a scheduled interval before granting the next permit', async () => {
    const queue = new AssetResolutionPermitQueue(1, 1, 5);
    await queue.acquire(Date.now() + 1_000);
    queue.release();
    const started = Date.now();
    await queue.acquire(Date.now() + 1_000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4);
    queue.release();
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

  it('expires queued work during dispatch when its deadline has passed', async () => {
    vi.useFakeTimers();

    try {
      vi.setSystemTime(new Date(1_000));

      const queue = new AssetResolutionPermitQueue(1, 1, 0);

      await queue.acquire(2_000);

      const queued = queue.acquire(1_100);

      // Move Date.now() past the deadline without running the waiter's timer.
      vi.setSystemTime(new Date(1_200));

      queue.release();

      await expect(queued).rejects.toBeInstanceOf(AssetResolutionPermitDeadlineError);

      expect(queue.queuedCount).toBe(0);
      expect(queue.activeCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a deadline that has already been reached', async () => {
    const queue = new AssetResolutionPermitQueue(1, 1, 0);

    await expect(queue.acquire(Date.now())).rejects.toBeInstanceOf(AssetResolutionPermitDeadlineError);

    expect(queue.activeCount).toBe(0);
    expect(queue.queuedCount).toBe(0);
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
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases a permit when its deadline expires while persisting permit timing', async () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);

    const storage = {
      get: async () => 0,
      put: async () => {
        // Simulate the storage write taking long enough for the
        // request deadline to expire.
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
});
