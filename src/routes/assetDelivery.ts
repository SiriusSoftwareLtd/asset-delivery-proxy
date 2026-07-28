import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { BlankInput } from 'hono/types';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { resolveAssetExtension } from '../assetExtension';
import { enterTraceSpan, getErrorFields, isTimeoutError, logEvent } from '../observability';
import {
  buildRobloxV1Url,
  buildRobloxV2Request,
  MalformedRobloxV2ResponseError,
  parseRobloxV2Discovery,
} from '../robloxAssetDelivery';
import type { AppEnvironment, CachedAssetMetadata, CacheStatus } from '../types';

const ROBLOX_TIMEOUT_MS = 10_000;
const ASSET_ID_PATTERN = /^\d{1,20}$/;
const NEGATIVE_CACHE_TTL_SECONDS = 5 * 60;
const ASSET_EXTENSION_HEADER = 'X-Asset-Extension';

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
    };

type AssetContext = Context<AppEnvironment, string, BlankInput>;

export async function fetchAsset(assetId: string, c: AssetContext, request: Request): Promise<AssetDeliveryResult> {
  return enterTraceSpan(
    'asset.delivery',
    async (span) => {
      const requestId = c.get('requestId');
      const assetCache = c.env.assetCache;
      let cacheStatus: CacheStatus = 'unknown';
      let assetExtension: string | undefined;
      let assetTypeId: number | undefined;
      let useAssetDeliveryV2 = false;

      /* assetId is intentionally excluded from trace attributes because it has high cardinality. */
      span.setAttribute('asset.secure_mode', request.headers.get('X-Rayfield-Secure-Mode') === 'true');

      if (!ASSET_ID_PATTERN.test(assetId)) {
        throw new HTTPException(400, { message: 'Invalid Roblox asset ID' });
      }

      if (request.headers.get('X-Rayfield-Secure-Mode') !== 'true') {
        cacheStatus = 'bypass';
        span.setAttribute('cache.status', cacheStatus);
        logEvent('warn', 'asset.access.denied', { requestId, assetId, reason: 'secure-mode-required' }, c.env);
        return {
          assetId,
          kind: 'error',
          status: 403,
          error: 'Secure mode is required',
          cacheStatus,
          cacheHit: false,
        };
      }

      try {
        useAssetDeliveryV2 = await c.env.FLAGS.getBooleanValue('use-asset-delivery-v2', false);
      } catch (error) {
        logEvent(
          'warn',
          'asset.flag.evaluation_failed',
          { requestId, assetId, flag: 'use-asset-delivery-v2', ...getErrorFields(error) },
          c.env,
        );
      }

      const v2Request = useAssetDeliveryV2 ? buildRobloxV2Request(assetId, request) : null;
      const cacheKey = v2Request?.cacheKey ?? assetId;
      let cachedValue: ArrayBuffer | null = null;
      let cachedMetadata: CachedAssetMetadata | null = null;

      try {
        const cached = await assetCache.getWithMetadata<CachedAssetMetadata>(cacheKey, 'arrayBuffer');
        cachedValue = cached.value;
        cachedMetadata = cached.metadata;
      } catch (error) {
        cacheStatus = 'read-error';
        span.setAttribute('cache.status', cacheStatus);
        logEvent('warn', 'asset.cache.read_failed', { requestId, assetId, ...getErrorFields(error) }, c.env);
      }

      if (cachedValue !== null) {
        try {
          if (!cachedMetadata) throw new TypeError('Cached asset metadata is missing');
          if (cachedMetadata.kind !== 'asset' && cachedMetadata.kind !== 'not-found') {
            throw new TypeError('Cached asset kind is invalid');
          }
          if (typeof cachedMetadata.timestamp !== 'number' || !Number.isFinite(cachedMetadata.timestamp)) {
            throw new TypeError('Cached asset timestamp is invalid');
          }

          if (cachedMetadata.kind === 'not-found') {
            cacheStatus = 'negative-hit';
            span.setAttribute('cache.status', cacheStatus);
            return {
              assetId,
              kind: 'not-found',
              status: 404,
              error: 'Asset not found',
              cacheStatus,
              cacheHit: true,
              timestamp: cachedMetadata.timestamp,
            };
          }

          if (typeof cachedMetadata.contentType !== 'string' || cachedMetadata.contentType.length === 0) {
            throw new TypeError('Cached asset content type is invalid');
          }
          if (cachedValue.byteLength === 0) throw new TypeError('Cached asset is empty');

          const data: Uint8Array<ArrayBuffer> = new Uint8Array(cachedValue);
          cacheStatus = 'hit';
          span.setAttribute('cache.status', cacheStatus);
          span.setAttribute('asset.bytes', data.byteLength);
          return {
            assetId,
            kind: 'asset',
            status: 200,
            data,
            contentType: cachedMetadata.contentType,
            extension: cachedMetadata.extension,
            cacheStatus,
            cacheHit: true,
            timestamp: cachedMetadata.timestamp,
          };
        } catch (error) {
          cacheStatus = 'corrupt';
          span.setAttribute('cache.status', cacheStatus);
          logEvent('warn', 'asset.cache.corrupt', { requestId, assetId, ...getErrorFields(error) }, c.env);
          try {
            await assetCache.delete(cacheKey);
          } catch (deleteError) {
            logEvent(
              'warn',
              'asset.cache.delete_failed',
              { requestId, assetId, ...getErrorFields(deleteError) },
              c.env,
            );
          }
        }
      } else if (cacheStatus !== 'read-error') {
        cacheStatus = 'miss';
        span.setAttribute('cache.status', cacheStatus);
      }

      let robloxResponse: Response;
      try {
        const discoveryResponse = await fetch(v2Request?.url ?? buildRobloxV1Url(assetId), {
          ...(v2Request?.init ?? {}),
          signal: AbortSignal.timeout(ROBLOX_TIMEOUT_MS),
        });

        if (!useAssetDeliveryV2 || !discoveryResponse.ok) {
          robloxResponse = discoveryResponse;
        } else {
          const discovery = await parseRobloxV2Discovery(discoveryResponse);
          assetTypeId = discovery.assetTypeId;
          robloxResponse = await fetch(discovery.location, { signal: AbortSignal.timeout(ROBLOX_TIMEOUT_MS) });
        }
      } catch (error) {
        if (error instanceof MalformedRobloxV2ResponseError) {
          throw new HTTPException(502, { message: error.message, cause: error });
        }
        const timedOut = isTimeoutError(error);
        throw new HTTPException(timedOut ? 504 : 502, {
          message: timedOut ? 'Roblox asset delivery timed out' : 'Unable to reach Roblox asset delivery',
          cause: error,
        });
      }

      const upstreamStatus = robloxResponse.status;
      span.setAttribute('http.response.status_code', upstreamStatus);
      const contentType = robloxResponse.headers.get('Content-Type') ?? 'application/octet-stream';

      if (!robloxResponse.ok) {
        logEvent(
          'warn',
          'asset.upstream.rejected',
          { requestId, assetId, upstreamStatus, upstreamStatusText: robloxResponse.statusText },
          c.env,
        );

        if (upstreamStatus === 404) {
          const timestamp = Date.now();
          let negativeCacheStatus: CacheStatus = 'negative-write';
          try {
            await robloxResponse.body?.cancel();
          } catch {
            // Body cancellation failure does not affect the response.
          }
          try {
            await assetCache.put(cacheKey, new ArrayBuffer(0), {
              expirationTtl: NEGATIVE_CACHE_TTL_SECONDS,
              metadata: { kind: 'not-found', timestamp } satisfies CachedAssetMetadata,
            });
            cacheStatus = 'negative-write';
            span.setAttribute('cache.status', cacheStatus);
            logEvent(
              'info',
              'asset.cache.negative_written',
              { requestId, assetId, expirationTtl: NEGATIVE_CACHE_TTL_SECONDS },
              c.env,
            );
          } catch (error) {
            negativeCacheStatus = 'write-error';
            cacheStatus = negativeCacheStatus;
            span.setAttribute('cache.status', cacheStatus);
            logEvent(
              'warn',
              'asset.cache.negative_write_failed',
              { requestId, assetId, ...getErrorFields(error) },
              c.env,
            );
          }
          return {
            assetId,
            kind: 'not-found',
            status: 404,
            error: 'Asset not found',
            cacheStatus: negativeCacheStatus,
            cacheHit: false,
            timestamp,
            upstreamStatus,
          };
        }

        const errorBuffer = await robloxResponse.arrayBuffer();
        return {
          assetId,
          kind: 'error',
          status: upstreamStatus,
          error: robloxResponse.statusText || 'Roblox asset delivery failed',
          data: new Uint8Array(errorBuffer),
          contentType,
          cacheStatus: 'bypass',
          cacheHit: false,
          upstreamStatus,
        };
      }

      const resolvedExtension = await resolveAssetExtension(contentType, robloxResponse.body, assetTypeId);
      assetExtension = resolvedExtension.extension;
      const robloxBuffer = await new Response(resolvedExtension.body).arrayBuffer();
      const data: Uint8Array<ArrayBuffer> = new Uint8Array(robloxBuffer);
      if (data.byteLength === 0) throw new HTTPException(502, { message: 'Roblox returned an empty asset' });
      span.setAttribute('asset.bytes', data.byteLength);

      const timestamp = Date.now();
      try {
        await assetCache.put(cacheKey, robloxBuffer, {
          metadata: { kind: 'asset', timestamp, contentType, extension: assetExtension } satisfies CachedAssetMetadata,
        });
      } catch (error) {
        cacheStatus = 'write-error';
        span.setAttribute('cache.status', cacheStatus);
        logEvent(
          'warn',
          'asset.cache.write_failed',
          { requestId, assetId, assetBytes: data.byteLength, ...getErrorFields(error) },
          c.env,
        );
      }

      return {
        assetId,
        kind: 'asset',
        status: 200,
        data,
        contentType,
        extension: assetExtension,
        cacheStatus,
        cacheHit: false,
        timestamp,
        upstreamStatus,
      };
    },
    c.env,
  );
}

function resultToResponse(c: AssetContext, result: AssetDeliveryResult): Response {
  c.set('cacheStatus', result.cacheStatus);
  if (result.upstreamStatus !== undefined) c.set('upstreamStatus', result.upstreamStatus);

  if (result.kind === 'asset') {
    return c.body(result.data, 200, {
      'Content-Type': result.contentType,
      ...(result.extension ? { [ASSET_EXTENSION_HEADER]: result.extension } : {}),
      'X-Cache-Hit': result.cacheHit ? 'true' : 'false',
      'X-Cache-Status': result.cacheStatus,
      ...(result.timestamp !== undefined ? { 'X-Cache-Timestamp': result.timestamp.toString() } : {}),
    });
  }

  if (result.kind === 'not-found') {
    return c.json({ error: result.error, requestId: c.get('requestId') }, 404, {
      'X-Cache-Hit': result.cacheHit ? 'true' : 'false',
      'X-Cache-Status': result.cacheStatus,
      ...(result.timestamp !== undefined ? { 'X-Cache-Timestamp': result.timestamp.toString() } : {}),
    });
  }

  if (result.status === 403) {
    return c.json({ error: result.error, requestId: c.get('requestId') }, 403);
  }

  return c.body(result.data ?? new Uint8Array(), result.status as ContentfulStatusCode, {
    ...(result.contentType ? { 'Content-Type': result.contentType } : {}),
    'X-Cache-Hit': 'false',
    'X-Cache-Status': result.cacheStatus,
  });
}

export async function handleAssetDelivery(c: AssetContext) {
  const result = await fetchAsset(c.req.param('assetId') ?? '', c, c.req.raw);
  return resultToResponse(c, result);
}

const MAX_BATCH_ASSETS = 25;
const MAX_BATCH_CONCURRENCY = 6;

type BatchBody = { assetIds: unknown };

export async function handleAssetBatchRequest(c: Context<AppEnvironment>) {
  const requestId = c.get('requestId');

  if (c.req.header('X-Rayfield-Secure-Mode') !== 'true') {
    c.set('cacheStatus', 'bypass');
    return c.json({ error: 'Secure mode is required', requestId }, 403);
  }

  let body: BatchBody;
  try {
    body = await c.req.json<BatchBody>();
  } catch {
    return c.json({ error: 'Request body must be valid JSON', requestId }, 400);
  }

  if (!body || typeof body !== 'object' || !Array.isArray(body.assetIds)) {
    return c.json({ error: 'assetIds must be a non-empty array', requestId }, 400);
  }

  if (body.assetIds.length === 0) {
    return c.json({ error: 'assetIds must be a non-empty array', requestId }, 400);
  }
  if (body.assetIds.length > MAX_BATCH_ASSETS) {
    return c.json({ error: `A maximum of ${MAX_BATCH_ASSETS} asset IDs is allowed`, requestId }, 400);
  }
  if (!body.assetIds.every(isValidAssetId)) {
    return c.json({ error: 'Invalid Roblox asset ID', requestId }, 400);
  }

  const assetIds = body.assetIds.filter((assetId): assetId is string => isValidAssetId(assetId));
  const inFlight = new Map<string, Promise<AssetDeliveryResult>>();
  const results = await mapWithConcurrency(assetIds, MAX_BATCH_CONCURRENCY, async (assetId) => {
    let operation = inFlight.get(assetId);
    if (!operation) {
      operation = fetchAsset(assetId, c as AssetContext, c.req.raw).catch((error: unknown) => {
        const status = error instanceof HTTPException ? error.status : 500;
        const message = error instanceof HTTPException ? error.message : 'Internal server error';
        return {
          assetId,
          kind: 'error',
          status,
          error: message,
          cacheStatus: 'bypass',
          cacheHit: false,
        } satisfies AssetDeliveryResult;
      });
      inFlight.set(assetId, operation);
    }
    return assetResultToBatchItem(await operation);
  });

  c.set('cacheStatus', 'unknown');
  return c.json({ requestId, results }, 200);
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, callback: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await callback(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

export function isValidAssetId(assetId: unknown): assetId is string {
  return typeof assetId === 'string' && ASSET_ID_PATTERN.test(assetId);
}

export function assetResultToBatchItem(result: AssetDeliveryResult) {
  if (result.kind === 'asset') {
    return {
      assetId: result.assetId,
      status: result.status,
      contentType: result.contentType,
      ...(result.extension ? { extension: result.extension } : {}),
      cacheStatus: result.cacheStatus,
      cacheHit: result.cacheHit,
      dataBase64: bytesToBase64(result.data),
    };
  }

  return {
    assetId: result.assetId,
    status: result.status,
    cacheStatus: result.cacheStatus,
    cacheHit: result.cacheHit,
    error: result.error,
  };
}

function bytesToBase64(data: Uint8Array<ArrayBuffer>): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    binary += String.fromCharCode(...data.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}
