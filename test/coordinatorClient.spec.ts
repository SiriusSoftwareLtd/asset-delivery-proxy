import { describe, expect, test, vi } from 'vitest';
import { buildAssetResolutionIdentity } from '../src/services/assets/cache';
import { coordinatorShard, resolveThroughCoordinator } from '../src/services/assets/coordinator-client';
import type { AssetResolutionIdentity, AssetResolutionResult } from '../src/types/app';

type CoordinatorRequest = {
  identity: AssetResolutionIdentity;
  deadline: number;
  backpressure: boolean;
};

const coordinatorResult: AssetResolutionResult = {
  kind: 'error',
  status: 503,
  error: 'test result',
  attempts: 0,
  queueTimeMs: 0,
  joined: false,
  origin: 'admission',
};

function createCoordinatorEnv(options: { shards?: string; deadlineMs?: string; budgetVerified?: string } = {}) {
  const resolve = vi.fn(async (_request: CoordinatorRequest): Promise<AssetResolutionResult> => coordinatorResult);

  const getByName = vi.fn(() => ({
    resolve,
  }));

  const testEnv = {
    ASSET_COORDINATOR_SHARDS: options.shards,
    ASSET_COORDINATOR_OPERATION_DEADLINE_MS: options.deadlineMs,
    ASSET_COORDINATOR_BUDGET_VERIFIED: options.budgetVerified ?? 'true',
    ASSET_RESOLUTION_COORDINATOR: {
      getByName,
    },
  } as unknown as CloudflareBindings;

  return {
    testEnv,
    resolve,
    getByName,
  };
}

async function createIdentity(): Promise<AssetResolutionIdentity> {
  return buildAssetResolutionIdentity('123456', new Request('https://proxy.test/v1/assets/123456'), false);
}

describe('asset coordinator client', () => {
  test('calculates a shard from the identity prefix', async () => {
    const identity = await createIdentity();
    const expected = Number.parseInt(identity.shardKey.slice(0, 8), 16) % 32;

    expect(coordinatorShard(identity, 32)).toBe(expected);
  });

  test('uses configured shard count and operation deadline', async () => {
    const identity = await createIdentity();

    const { testEnv, resolve, getByName } = createCoordinatorEnv({
      shards: '32',
      deadlineMs: '5000',
    });

    const startedAt = Date.now();

    const result = await resolveThroughCoordinator(testEnv, identity, false);

    const completedAt = Date.now();
    const expectedShard = coordinatorShard(identity, 32);

    expect(result).toEqual({
      result: coordinatorResult,
      shard: expectedShard,
    });

    expect(getByName).toHaveBeenCalledWith(`asset-shard-${expectedShard}`);

    const call = resolve.mock.calls[0]?.[0];

    if (!call) {
      throw new Error('Expected coordinator resolve call');
    }

    expect(call.identity).toBe(identity);
    expect(call.backpressure).toBe(false);
    expect(call.deadline).toBeGreaterThanOrEqual(startedAt + 5000);
    expect(call.deadline).toBeLessThanOrEqual(completedAt + 5000);
  });

  test.each([
    ['non-numeric', 'invalid', 'invalid'],
    ['below minimum', '0', '999'],
    ['above maximum', '1025', '120001'],
    ['non-integer', '1.5', '1000.5'],
  ])('falls back to coordinator defaults for %s configuration', async (_label, shards, deadlineMs) => {
    const identity = await createIdentity();

    const { testEnv, resolve, getByName } = createCoordinatorEnv({
      shards,
      deadlineMs,
    });

    const startedAt = Date.now();

    const result = await resolveThroughCoordinator(testEnv, identity, false);

    const completedAt = Date.now();
    const expectedShard = coordinatorShard(identity, 16);

    expect(result.shard).toBe(expectedShard);

    expect(getByName).toHaveBeenCalledWith(`asset-shard-${expectedShard}`);

    const call = resolve.mock.calls[0]?.[0];

    if (!call) {
      throw new Error('Expected coordinator resolve call');
    }

    expect(call.deadline).toBeGreaterThanOrEqual(startedAt + 25_000);
    expect(call.deadline).toBeLessThanOrEqual(completedAt + 25_000);
  });

  test('rejects backpressure when coordinator capacity is not verified', async () => {
    const identity = await createIdentity();

    const { testEnv, resolve, getByName } = createCoordinatorEnv({
      budgetVerified: 'false',
    });

    const result = await resolveThroughCoordinator(testEnv, identity, true);

    expect(result).toEqual({
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
    });

    expect(getByName).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  test('allows coordinator use when backpressure is disabled even if the budget is unverified', async () => {
    const identity = await createIdentity();

    const { testEnv, resolve } = createCoordinatorEnv({
      budgetVerified: 'false',
    });

    const result = await resolveThroughCoordinator(testEnv, identity, false);

    expect(result.shard).toBeGreaterThanOrEqual(0);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});
