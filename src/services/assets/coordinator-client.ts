import type { AssetResolutionIdentity, AssetResolutionResult } from '../../types/app';

function readInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

export function coordinatorShard(identity: AssetResolutionIdentity, shardCount: number): number {
  const prefix = Number.parseInt(identity.shardKey.slice(0, 8), 16);
  return prefix % shardCount;
}

export async function resolveThroughCoordinator(
  env: CloudflareBindings,
  identity: AssetResolutionIdentity,
  backpressure: boolean,
): Promise<{ result: AssetResolutionResult; shard: number }> {
  if (backpressure && String(env.ASSET_COORDINATOR_BUDGET_VERIFIED) !== 'true') {
    return {
      shard: -1,
      result: {
        kind: 'error',
        status: 503,
        error: 'Asset coordinator capacity is not calibrated',
        retryAfter: 60,
        attempts: 0,
        queueTimeMs: 0,
        joined: false,
        origin: 'admission',
      },
    };
  }

  const shardCount = readInteger(env.ASSET_COORDINATOR_SHARDS, 16, 1, 1_024);
  const deadlineMs = readInteger(env.ASSET_COORDINATOR_OPERATION_DEADLINE_MS, 25_000, 1_000, 120_000);
  const shard = coordinatorShard(identity, shardCount);
  const stub = env.ASSET_RESOLUTION_COORDINATOR.getByName(`asset-shard-${shard}`);
  const result = await stub.resolve({ identity, deadline: Date.now() + deadlineMs, backpressure });
  return { result, shard };
}
