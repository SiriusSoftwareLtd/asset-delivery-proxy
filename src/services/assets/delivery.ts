import { HTTPException } from 'hono/http-exception';
import { enterTraceSpan, getErrorFields, isTimeoutError, logEvent } from '../../middleware/observability';
import type { AppContext, CachedAssetMetadata, CacheStatus } from '../../types/app';
import { resolveAssetExtension } from './extension';
import {
  buildRobloxV1Url,
  buildRobloxV2Request,
  MalformedRobloxV2ResponseError,
  parseRobloxV2Discovery,
  RobloxV2RejectedError,
  rejectionStatus,
} from './roblox';

const ROBLOX_TIMEOUT_MS = 10_000;
const ASSET_ID_PATTERN = /^\d{1,20}$/;
const NEGATIVE_CACHE_TTL_SECONDS = 5 * 60;

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

export async function fetchAsset(assetId: string, c: AppContext, request: Request): Promise<AssetDeliveryResult> {
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
        const robloxHeaders = new Headers(v2Request?.init.headers);
        if (c.env.ROBLOX_API_KEY) {
          robloxHeaders.set('x-api-key', c.env.ROBLOX_API_KEY);
        }
        const discoveryResponse = await fetch(v2Request?.url ?? buildRobloxV1Url(assetId), {
          ...(v2Request?.init ?? {}),
          headers: robloxHeaders,
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
        if (error instanceof RobloxV2RejectedError) {
          logEvent(
            'warn',
            'asset.upstream.rejected',
            { requestId, assetId, upstreamStatus: error.upstreamCode, reason: error.message },
            c.env,
          );
          throw new HTTPException(rejectionStatus(error.upstreamCode), { message: error.message, cause: error });
        }
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

export function isValidAssetId(assetId: unknown): assetId is string {
  return typeof assetId === 'string' && ASSET_ID_PATTERN.test(assetId);
}
