import { HTTPException } from 'hono/http-exception';
import { enterTraceSpan, getErrorFields, logEvent } from '../../middleware/observability';
import { limitAssetMiss } from '../../middleware/rateLimiter';
import { writeAssetMetric } from '../../observability/assetMetrics';
import type { AppContext, AssetResolutionIdentity, AssetResolutionResult, CacheStatus } from '../../types/app';
import {
  type AssetCacheEntry,
  buildAssetResolutionIdentity,
  populateL1,
  readKv,
  readL1,
  writeAssetToKv,
  writeNotFoundToKv,
} from './cache';
import { resolveThroughCoordinator } from './coordinator-client';
import { resolveAssetExtension } from './extension';
import { fetchRobloxAsset, parseRetryAfter } from './roblox';

const ASSET_ID_PATTERN = /^\d{1,20}$/;

export type AssetDeliveryResult =
  | {
      assetId: string;
      kind: 'asset';
      status: 200;
      data: Uint8Array<ArrayBuffer>;
      contentType: string;
      extension?: string;
      cacheStatus: CacheStatus;
      cacheHit: boolean;
      timestamp?: number;
      upstreamStatus?: number;
      retryAfter?: number;
    }
  | {
      assetId: string;
      kind: 'not-found' | 'error';
      status: number;
      error: string;
      cacheStatus: CacheStatus;
      cacheHit: boolean;
      contentType?: string;
      data?: Uint8Array<ArrayBuffer>;
      timestamp?: number;
      upstreamStatus?: number;
      retryAfter?: number;
    };

async function evaluateFlag(c: AppContext, name: string, fallback = false): Promise<boolean> {
  try {
    return await c.env.FLAGS.getBooleanValue(name, fallback);
  } catch (error) {
    logEvent(
      'warn',
      'asset.flag.evaluation_failed',
      { requestId: c.get('requestId'), flag: name, ...getErrorFields(error) },
      c.env,
    );
    return fallback;
  }
}

export async function prepareAssetIdentity(
  assetId: string,
  c: AppContext,
  request: Request,
  useAssetDeliveryV2?: boolean,
): Promise<AssetResolutionIdentity> {
  const useV2 = useAssetDeliveryV2 ?? (await evaluateFlag(c, 'use-asset-delivery-v2'));
  return buildAssetResolutionIdentity(assetId, request, useV2);
}

export async function shouldUseAssetDeliveryV2(c: AppContext): Promise<boolean> {
  return evaluateFlag(c, 'use-asset-delivery-v2');
}

function cachedAssetResult(assetId: string, entry: AssetCacheEntry, cacheStatus: CacheStatus): AssetDeliveryResult {
  return {
    assetId,
    kind: 'asset',
    status: 200,
    data: entry.data,
    contentType: entry.metadata.contentType,
    extension: entry.metadata.extension,
    cacheStatus,
    cacheHit: true,
    timestamp: entry.metadata.timestamp,
  };
}

async function resolveDirect(
  c: AppContext,
  identity: AssetResolutionIdentity,
): Promise<{ result: AssetResolutionResult; cacheStatus: CacheStatus }> {
  const resolution = await fetchRobloxAsset(
    identity.protocol,
    identity.upstreamUrl,
    identity.upstreamHeaders,
    c.env.ROBLOX_API_KEY,
  );

  if (resolution.kind === 'rejection') {
    return {
      cacheStatus: 'bypass',
      result: {
        kind: 'error',
        status: resolution.status,
        error: resolution.error,
        upstreamStatus: resolution.upstreamStatus,
        attempts: 1,
        queueTimeMs: 0,
        joined: false,
      },
    };
  }

  const response = resolution.response;
  const contentType = response.headers.get('Content-Type') ?? 'application/octet-stream';
  if (!response.ok) {
    if (response.status === 404) {
      const timestamp = Date.now();
      await response.body?.cancel().catch(() => undefined);
      let cacheStatus: CacheStatus = 'negative-write';
      try {
        await writeNotFoundToKv(c.env.assetCache, identity, timestamp);
      } catch (error) {
        cacheStatus = 'write-error';
        logEvent(
          'warn',
          'asset.cache.negative_write_failed',
          { requestId: c.get('requestId'), ...getErrorFields(error) },
          c.env,
        );
      }
      return {
        cacheStatus,
        result: {
          kind: 'not-found',
          status: 404,
          error: 'Asset not found',
          timestamp,
          upstreamStatus: 404,
          attempts: 1,
          queueTimeMs: 0,
          joined: false,
        },
      };
    }

    return {
      cacheStatus: 'bypass',
      result: {
        kind: 'error',
        status: response.status,
        error: response.statusText || 'Roblox asset delivery failed',
        data: new Uint8Array(await response.arrayBuffer()),
        contentType,
        upstreamStatus: response.status,
        retryAfter: response.status === 429 ? parseRetryAfter(response.headers.get('Retry-After')) : undefined,
        attempts: 1,
        queueTimeMs: 0,
        joined: false,
      },
    };
  }

  const resolved = await resolveAssetExtension(contentType, response.body, resolution.assetTypeId);
  const data = new Uint8Array(await new Response(resolved.body).arrayBuffer());
  if (data.byteLength === 0) throw new HTTPException(502, { message: 'Roblox returned an empty asset' });
  const timestamp = Date.now();
  let cacheStatus: CacheStatus = 'miss';
  try {
    await writeAssetToKv(c.env.assetCache, identity, data, contentType, resolved.extension, timestamp);
  } catch (error) {
    cacheStatus = 'write-error';
    logEvent(
      'warn',
      'asset.cache.write_failed',
      { requestId: c.get('requestId'), assetBytes: data.byteLength, ...getErrorFields(error) },
      c.env,
    );
  }
  return {
    cacheStatus,
    result: {
      kind: 'asset',
      status: 200,
      data,
      contentType,
      extension: resolved.extension,
      timestamp,
      upstreamStatus: response.status,
      attempts: 1,
      queueTimeMs: 0,
      joined: false,
    },
  };
}

function resolutionToDelivery(
  assetId: string,
  result: AssetResolutionResult,
  cacheStatus: CacheStatus,
): AssetDeliveryResult {
  if (result.kind === 'asset') {
    return {
      assetId,
      kind: 'asset',
      status: 200,
      data: result.data,
      contentType: result.contentType,
      extension: result.extension,
      timestamp: result.timestamp,
      upstreamStatus: result.upstreamStatus,
      cacheStatus,
      cacheHit: result.attempts === 0,
    };
  }
  return {
    assetId,
    kind: result.kind,
    status: result.status,
    error: result.error,
    data: result.data,
    contentType: result.contentType,
    timestamp: result.timestamp,
    upstreamStatus: result.upstreamStatus,
    retryAfter: result.retryAfter,
    cacheStatus,
    cacheHit: result.attempts === 0,
  };
}

async function resolveMiss(
  c: AppContext,
  identity: AssetResolutionIdentity,
  coordinatorEnabled: boolean,
  backpressureEnabled: boolean,
  applyClientLimit = true,
): Promise<{ delivery: AssetDeliveryResult; shard?: number; resolution: AssetResolutionResult }> {
  if (applyClientLimit && c.get('assetLazyLimitEnabled')) await limitAssetMiss(c);

  if (coordinatorEnabled) {
    const coordinated = await resolveThroughCoordinator(c.env, identity, backpressureEnabled);
    const cacheStatus: CacheStatus = coordinated.result.kind === 'not-found' ? 'negative-write' : 'miss';
    return {
      delivery: resolutionToDelivery(identity.assetId, coordinated.result, cacheStatus),
      shard: coordinated.shard,
      resolution: coordinated.result,
    };
  }

  const direct = await resolveDirect(c, identity);
  return {
    delivery: resolutionToDelivery(identity.assetId, direct.result, direct.cacheStatus),
    resolution: direct.result,
  };
}

export async function fetchAsset(
  assetId: string,
  c: AppContext,
  request: Request,
  preparedIdentity?: AssetResolutionIdentity,
): Promise<AssetDeliveryResult> {
  return enterTraceSpan(
    'asset.delivery',
    async (span) => {
      const startedAt = performance.now();
      const requestId = c.get('requestId');
      span.setAttribute('asset.secure_mode', request.headers.get('X-Rayfield-Secure-Mode') === 'true');

      if (!ASSET_ID_PATTERN.test(assetId)) throw new HTTPException(400, { message: 'Invalid Roblox asset ID' });
      if (request.headers.get('X-Rayfield-Secure-Mode') !== 'true') {
        logEvent('warn', 'asset.access.denied', { requestId, assetId, reason: 'secure-mode-required' }, c.env);
        return {
          assetId,
          kind: 'error',
          status: 403,
          error: 'Secure mode is required',
          cacheStatus: 'bypass',
          cacheHit: false,
        };
      }

      const identity = preparedIdentity ?? (await prepareAssetIdentity(assetId, c, request));
      const [layeredCacheEnabled, coordinatorEnabled, backpressureEnabled] = await Promise.all([
        evaluateFlag(c, 'asset-cache-layered'),
        evaluateFlag(c, 'asset-upstream-coordinator'),
        evaluateFlag(c, 'asset-upstream-backpressure'),
      ]);

      if (layeredCacheEnabled) {
        const l1 = await readL1(identity);
        if (l1.kind === 'asset') {
          span.setAttribute('cache.status', 'l1-hit');
          writeAssetMetric(c.env, {
            resolutionPath: 'l1',
            cacheOutcome: 'fresh-hit',
            protocol: identity.protocol,
            durationMs: performance.now() - startedAt,
            assetBytes: l1.entry.data.byteLength,
          });
          return cachedAssetResult(assetId, l1.entry, 'l1-hit');
        }
      }

      const kv = await readKv(c.env.assetCache, identity, {
        allowLegacy: Date.now() < Date.parse(c.env.ASSET_LEGACY_V1_READ_UNTIL),
        onError: (error) =>
          logEvent('warn', 'asset.cache.read_failed', { requestId, assetId, ...getErrorFields(error) }, c.env),
      });
      if (kv.kind === 'not-found') {
        writeAssetMetric(c.env, {
          resolutionPath: 'kv',
          cacheOutcome: 'negative-hit',
          protocol: identity.protocol,
          durationMs: performance.now() - startedAt,
        });
        return {
          assetId,
          kind: 'not-found',
          status: 404,
          error: 'Asset not found',
          cacheStatus: 'negative-hit',
          cacheHit: true,
          timestamp: kv.timestamp,
        };
      }
      if (kv.kind === 'asset') {
        if (kv.entry.state === 'fresh') {
          if (layeredCacheEnabled) c.executionCtx.waitUntil(populateL1(identity, kv.entry).catch(() => undefined));
          writeAssetMetric(c.env, {
            resolutionPath: 'kv',
            cacheOutcome: 'fresh-hit',
            protocol: identity.protocol,
            durationMs: performance.now() - startedAt,
            assetBytes: kv.entry.data.byteLength,
          });
          return cachedAssetResult(assetId, kv.entry, layeredCacheEnabled ? 'kv-fresh-hit' : 'hit');
        }
        if (layeredCacheEnabled) {
          c.executionCtx.waitUntil(
            resolveMiss(c, identity, coordinatorEnabled, backpressureEnabled, false).then(
              () => undefined,
              () => undefined,
            ),
          );
          writeAssetMetric(c.env, {
            resolutionPath: 'kv',
            cacheOutcome: 'stale-hit',
            protocol: identity.protocol,
            durationMs: performance.now() - startedAt,
            assetBytes: kv.entry.data.byteLength,
          });
          return cachedAssetResult(assetId, kv.entry, 'stale-hit');
        }
      }

      const { delivery, resolution, shard } = await resolveMiss(c, identity, coordinatorEnabled, backpressureEnabled);
      if (delivery.kind === 'asset' && layeredCacheEnabled) {
        const entry: AssetCacheEntry = {
          data: delivery.data,
          state: 'fresh',
          metadata: {
            kind: 'asset',
            version: 2,
            timestamp: delivery.timestamp ?? Date.now(),
            storedAt: delivery.timestamp ?? Date.now(),
            freshUntil: (delivery.timestamp ?? Date.now()) + 24 * 60 * 60 * 1_000,
            staleUntil: (delivery.timestamp ?? Date.now()) + 7 * 24 * 60 * 60 * 1_000,
            contentType: delivery.contentType,
            extension: delivery.extension,
          },
        };
        c.executionCtx.waitUntil(populateL1(identity, entry).catch(() => undefined));
      }

      span.setAttribute('cache.status', delivery.cacheStatus);
      if (resolution.upstreamStatus !== undefined)
        span.setAttribute('http.response.status_code', resolution.upstreamStatus);
      writeAssetMetric(c.env, {
        resolutionPath: coordinatorEnabled ? (resolution.joined ? 'coordinator-joined' : 'coordinator') : 'direct',
        cacheOutcome: 'miss',
        protocol: identity.protocol,
        upstreamStatusClass:
          resolution.upstreamStatus === undefined ? 'none' : `${Math.floor(resolution.upstreamStatus / 100)}xx`,
        retryOutcome: resolution.attempts > 1 ? 'retried' : 'none',
        limiterOutcome: c.get('assetLazyLimitEnabled') ? 'allowed' : 'global',
        coordinatorShard: shard?.toString(),
        durationMs: performance.now() - startedAt,
        queueTimeMs: resolution.queueTimeMs,
        upstreamAttempts: resolution.attempts,
        joinedCallers: resolution.joined ? 1 : 0,
        assetBytes: delivery.kind === 'asset' ? delivery.data.byteLength : 0,
      });
      logEvent(
        'info',
        'asset.resolution.completed',
        {
          requestId,
          resolutionPath: coordinatorEnabled ? (resolution.joined ? 'coordinator-joined' : 'coordinator') : 'direct',
          protocol: identity.protocol,
          status: delivery.status,
          upstreamStatus: resolution.upstreamStatus,
          cacheStatus: delivery.cacheStatus,
          queueTimeMs: resolution.queueTimeMs,
          upstreamAttempts: resolution.attempts,
          coordinatorShard: shard,
        },
        c.env,
      );
      return delivery;
    },
    c.env,
  );
}

export function isValidAssetId(assetId: unknown): assetId is string {
  return typeof assetId === 'string' && ASSET_ID_PATTERN.test(assetId);
}
