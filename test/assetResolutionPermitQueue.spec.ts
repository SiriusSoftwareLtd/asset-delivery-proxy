import { describe, expect, it } from 'vitest';
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

  it('expires a waiter when admission is checked after its deadline', async () => {
    const queue = new AssetResolutionPermitQueue(1, 1, 0);
    await queue.acquire(Date.now() + 1_000);
    const queued = queue.acquire(Date.now() + 20);
    const rejection = expect(queued).rejects.toBeInstanceOf(AssetResolutionPermitDeadlineError);
    await new Promise((resolve) => setTimeout(resolve, 30));
    queue.release();
    await rejection;
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
});
