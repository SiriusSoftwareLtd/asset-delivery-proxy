import { describe, expect, test, vi } from 'vitest';
import { logCacheError, readKv, readL1 } from '../src/services/assets/cache';
import type { AssetResolutionIdentity } from '../src/types/app';

const identity: AssetResolutionIdentity = {
  assetId: '123',
  canonicalKey: 'v1|123',
  physicalKey: 'asset:v2:test',
  shardKey: 'test',
  protocol: 'v1',
  upstreamUrl: 'https://assetdelivery.roblox.com/v1/asset/?id=123',
  upstreamHeaders: {},
};

function createKv(
  value: ArrayBuffer | null,
  metadata: unknown,
  deleteImplementation: () => Promise<void> = async () => {},
) {
  const deleteMock = vi.fn(deleteImplementation);

  const namespace = {
    async getWithMetadata() {
      return {
        value,
        metadata,
      };
    },
    delete: deleteMock,
  } as unknown as KVNamespace;

  return {
    namespace,
    deleteMock,
  };
}

function validMetadata(now = Date.now()) {
  return {
    kind: 'asset',
    version: 2,
    timestamp: now,
    storedAt: now,
    freshUntil: now + 60_000,
    staleUntil: now + 120_000,
    contentType: 'image/png',
    extension: '.png',
  };
}

describe('asset cache validation', () => {
  test('removes a negative-cache entry with an invalid timestamp', async () => {
    const { namespace, deleteMock } = createKv(new ArrayBuffer(0), {
      kind: 'not-found',
      timestamp: Number.NaN,
    });

    const onError = vi.fn();

    const result = await readKv(namespace, identity, { onError });

    expect(result).toEqual({ kind: 'miss' });
    expect(onError).toHaveBeenCalledWith(expect.any(TypeError));
    expect(deleteMock).toHaveBeenCalledWith(identity.physicalKey);
  });

  test.each([
    [
      'unsupported metadata version',
      {
        ...validMetadata(),
        version: 1,
      },
    ],
    [
      'missing content type',
      {
        ...validMetadata(),
        contentType: '',
      },
    ],
    [
      'fresh timestamp before stored timestamp',
      {
        ...validMetadata(),
        storedAt: 200,
        freshUntil: 100,
        staleUntil: 300,
      },
    ],
    [
      'stale timestamp before fresh timestamp',
      {
        ...validMetadata(),
        storedAt: 100,
        freshUntil: 300,
        staleUntil: 200,
      },
    ],
    [
      'expired stale timestamp',
      {
        ...validMetadata(),
        storedAt: Date.now() - 10_000,
        freshUntil: Date.now() - 5_000,
        staleUntil: Date.now() - 1,
      },
    ],
  ])('treats %s as a recoverable cache miss', async (_label, metadata) => {
    const { namespace, deleteMock } = createKv(new Uint8Array([1]).buffer, metadata);

    const onError = vi.fn();

    const result = await readKv(namespace, identity, { onError });

    expect(result).toEqual({ kind: 'miss' });
    expect(onError).toHaveBeenCalledWith(expect.any(TypeError));
    expect(deleteMock).toHaveBeenCalledWith(identity.physicalKey);
  });

  test('rejects an otherwise valid cached asset with an empty body', async () => {
    const { namespace, deleteMock } = createKv(new ArrayBuffer(0), validMetadata());

    const result = await readKv(namespace, identity);

    expect(result).toEqual({ kind: 'miss' });
    expect(deleteMock).toHaveBeenCalledWith(identity.physicalKey);
  });

  test('does not fail the request when corrupt-cache cleanup also fails', async () => {
    const cleanupError = new Error('KV delete unavailable');

    const { namespace, deleteMock } = createKv(new Uint8Array([1]).buffer, null, async () => {
      throw cleanupError;
    });

    const onError = vi.fn();

    const result = await readKv(namespace, identity, { onError });

    expect(result).toEqual({ kind: 'miss' });
    expect(onError).toHaveBeenCalledWith(expect.any(TypeError));
    expect(deleteMock).toHaveBeenCalledTimes(1);
  });

  test('logs cache errors with safe error fields', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      logCacheError(
        'asset.cache.read_failed',
        new Error('cache unavailable'),
        {
          operation: 'read',
        },
        {
          OBSERVABILITY_REPORT_LEVEL: 'warn',
        } as unknown as CloudflareBindings,
      );

      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'asset.cache.read_failed',
          operation: 'read',
          errorName: 'Error',
          errorMessage: 'cache unavailable',
        }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  test('treats an empty L1 cache body as a miss', async () => {
    const now = Date.now();

    const matchMock = vi.spyOn(caches.default, 'match').mockImplementation(
      async () =>
        new Response(null, {
          headers: {
            'X-Asset-Fresh-Until': String(now + 60_000),
            'X-Asset-Stale-Until': String(now + 120_000),
            'X-Asset-Stored-At': String(now),
            'X-Asset-Timestamp': String(now),
            'X-Asset-Content-Type': 'image/png',
          },
        }),
    );

    try {
      const result = await readL1(identity, now);

      expect(result).toEqual({ kind: 'miss' });
      expect(matchMock).toHaveBeenCalledTimes(1);
    } finally {
      matchMock.mockRestore();
    }
  });

  test('treats an L1 Cache API failure as a miss', async () => {
    const matchMock = vi.spyOn(caches.default, 'match').mockImplementation(async () => {
      throw new Error('Cache API unavailable');
    });

    try {
      const result = await readL1(identity);

      expect(result).toEqual({ kind: 'miss' });
      expect(matchMock).toHaveBeenCalledTimes(1);
    } finally {
      matchMock.mockRestore();
    }
  });

  test('rejects malformed L1 metadata without reading the body', async () => {
    const arrayBuffer = vi.fn(async () => new Uint8Array([1]).buffer);

    const response = new Response(new Uint8Array([1]), {
      headers: {
        'X-Asset-Fresh-Until': 'not-a-number',
        'X-Asset-Stored-At': '123',
        'X-Asset-Timestamp': '123',
        'X-Asset-Content-Type': 'image/png',
      },
    });

    Object.defineProperty(response, 'arrayBuffer', {
      value: arrayBuffer,
    });

    const matchMock = vi.spyOn(caches.default, 'match').mockImplementation(async () => response);

    try {
      const result = await readL1(identity);

      expect(result).toEqual({ kind: 'miss' });
      expect(arrayBuffer).not.toHaveBeenCalled();
    } finally {
      matchMock.mockRestore();
    }
  });
});
