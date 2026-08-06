import { afterEach, describe, expect, test, vi } from 'vitest';
import { populateIconL1, readIconCache, readIconL1 } from '../../src/icons/cache';
import { createInMemoryKv as createCache } from '../helpers/in-memory-kv';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('icon cache layers', () => {
  test('round-trips a positive icon through the Cache API L1', async () => {
    const cache = createCache() as unknown as KVNamespace;
    const png = new Uint8Array([1, 2, 3]);

    await populateIconL1(cache, 'icon-key', png, 123);

    await expect(readIconL1(cache, 'icon-key')).resolves.toEqual({
      value: expect.any(ArrayBuffer),
      metadata: { kind: 'icon', timestamp: 123 },
      status: 'l1-hit',
    });
  });

  test.each([
    new Response(new Uint8Array([1]), { headers: { 'X-Icon-Timestamp': 'invalid' } }),
    new Response(new Uint8Array(), { headers: { 'X-Icon-Timestamp': '123' } }),
  ])('treats malformed L1 entries as misses', async (response) => {
    vi.spyOn(caches.default, 'match').mockResolvedValue(response);
    const cache = createCache() as unknown as KVNamespace;

    await expect(readIconL1(cache, 'malformed')).resolves.toEqual({ value: null, metadata: null, status: 'miss' });
  });

  test('degrades when Cache API reads fail', async () => {
    vi.spyOn(caches.default, 'match').mockRejectedValue(new Error('cache unavailable'));
    const cache = createCache() as unknown as KVNamespace;

    await expect(readIconL1(cache, 'failed')).resolves.toEqual({ value: null, metadata: null, status: 'miss' });
  });

  test('reports KV read failures without throwing', async () => {
    const onError = vi.fn();
    const cache = {
      getWithMetadata: vi.fn(async () => {
        throw new Error('KV unavailable');
      }),
    } as unknown as KVNamespace;

    await expect(readIconCache(cache, 'key', onError)).resolves.toEqual({
      value: null,
      metadata: null,
      status: 'read-error',
    });
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
