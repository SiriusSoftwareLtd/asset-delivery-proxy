export type AssetMetric = {
  resolutionPath: string;
  cacheOutcome: string;
  protocol: 'v1' | 'v2';
  upstreamStatusClass?: string;
  retryOutcome?: string;
  limiterOutcome?: string;
  coordinatorShard?: string;
  durationMs: number;
  queueTimeMs?: number;
  upstreamAttempts?: number;
  joinedCallers?: number;
  assetBytes?: number;
};

/** Analytics Engine writes are non-blocking and deliberately exclude asset identifiers. */
export function writeAssetMetric(env: CloudflareBindings, metric: AssetMetric): void {
  env.ASSET_METRICS?.writeDataPoint({
    blobs: [
      metric.resolutionPath,
      metric.cacheOutcome,
      metric.protocol,
      metric.upstreamStatusClass ?? 'none',
      metric.retryOutcome ?? 'none',
      metric.limiterOutcome ?? 'none',
      metric.coordinatorShard ?? 'none',
    ],
    doubles: [
      metric.durationMs,
      metric.queueTimeMs ?? 0,
      metric.upstreamAttempts ?? 0,
      metric.joinedCallers ?? 0,
      metric.assetBytes ?? 0,
    ],
    indexes: [metric.coordinatorShard ?? 'none'],
  });
}
