import { describe, expect, test, vi } from 'vitest';
import { writeAssetMetric } from '../../src/observability/assetMetrics';

describe('asset metrics', () => {
  test('uses defaults for optional metric fields', () => {
    const writeDataPoint = vi.fn();

    writeAssetMetric(
      {
        ASSET_METRICS: {
          writeDataPoint,
        },
      } as unknown as CloudflareBindings,
      {
        resolutionPath: 'upstream',
        cacheOutcome: 'miss',
        protocol: 'v1',
        durationMs: 12,
      },
    );

    expect(writeDataPoint).toHaveBeenCalledWith({
      blobs: ['upstream', 'miss', 'v1', 'none', 'none', 'none', 'none'],
      doubles: [12, 0, 0, 0, 0],
      indexes: ['none'],
    });
  });

  test('writes all optional metric fields when present', () => {
    const writeDataPoint = vi.fn();

    writeAssetMetric(
      {
        ASSET_METRICS: {
          writeDataPoint,
        },
      } as unknown as CloudflareBindings,
      {
        resolutionPath: 'coordinator',
        cacheOutcome: 'stale',
        protocol: 'v2',
        upstreamStatusClass: '2xx',
        retryOutcome: 'retried',
        limiterOutcome: 'allowed',
        coordinatorShard: 'shard-3',
        durationMs: 42,
        queueTimeMs: 7,
        upstreamAttempts: 2,
        joinedCallers: 3,
        assetBytes: 512,
      },
    );

    expect(writeDataPoint).toHaveBeenCalledWith({
      blobs: ['coordinator', 'stale', 'v2', '2xx', 'retried', 'allowed', 'shard-3'],
      doubles: [42, 7, 2, 3, 512],
      indexes: ['shard-3'],
    });
  });

  test('is a no-op when the Analytics Engine binding is absent', () => {
    expect(() =>
      writeAssetMetric({} as CloudflareBindings, {
        resolutionPath: 'upstream',
        cacheOutcome: 'miss',
        protocol: 'v1',
        durationMs: 1,
      }),
    ).not.toThrow();
  });
});
