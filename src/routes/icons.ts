import { errorResponse } from '../http/responses';
import { enterTraceSpan, getErrorFields, logEvent } from '../middleware/observability';
import { parseIconConfig } from '../services/icons/config';
import { getPngFromSvgIcon, IconError } from '../services/icons/generator';
import type { AppContext, CacheStatus } from '../types/app';
import { bytesToBase64, mapWithConcurrency } from '../utils/batch';

const ICON_CACHE_TTL_SECONDS = 24 * 60 * 60;

function asArrayBufferBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

type CachedIconMetadata = {
  kind: 'icon' | 'not-found';
  timestamp: number;
};

function iconCacheKey(iconPack: string, normalizedOptions: string, iconName: string): string {
  return `icon:v1:${encodeURIComponent(iconPack)}:${encodeURIComponent(normalizedOptions)}:${encodeURIComponent(iconName)}`;
}

function errorStatus(error: IconError): 400 | 404 | 502 | 504 {
  if (error.code === 'ICON_NOT_FOUND') return 404;
  if (error.code === 'UPSTREAM_TIMEOUT') return 504;
  if (error.stage === 'validation') return 400;
  return 502;
}

function errorMessage(error: IconError): string {
  if (error.code === 'ICON_NOT_FOUND') return 'Icon not found';
  if (error.stage === 'validation') return error.message;
  if (error.code === 'UPSTREAM_TIMEOUT') return 'Icon source timed out';
  return 'Unable to generate icon';
}

export type IconDeliveryResult =
  | {
      iconPack: string;
      iconName: string;
      kind: 'icon';
      status: 200;
      data: Uint8Array<ArrayBuffer>;
      contentType: 'image/png';
      cacheStatus: CacheStatus;
      cacheHit: boolean;
      timestamp: number;
    }
  | {
      iconPack: string;
      iconName: string;
      kind: 'error';
      status: 400 | 404 | 502 | 504;
      error: string;
    };

export async function fetchIcon(
  iconPack: string,
  iconName: string,
  query: URLSearchParams,
  c: AppContext,
): Promise<IconDeliveryResult> {
  return enterTraceSpan(
    'icon.delivery',
    async (span) => {
      const requestId = c.get('requestId');
      let parsed: ReturnType<typeof parseIconConfig>;

      try {
        parsed = parseIconConfig(iconPack, iconName, query);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid icon request';
        return { iconPack, iconName, kind: 'error', status: 400, error: message };
      }

      span.setAttribute('icon.provider', iconPack);

      const cacheKey = iconCacheKey(iconPack, parsed.normalizedOptions, iconName);
      let cached: { value: ArrayBuffer | null; metadata: CachedIconMetadata | null } | undefined;
      let cacheStatus: CacheStatus = 'unknown';

      try {
        cached = await c.env.assetCache.getWithMetadata<CachedIconMetadata>(cacheKey, 'arrayBuffer');
      } catch (error) {
        cacheStatus = 'read-error';
        logEvent('warn', 'icon.cache.read_failed', { requestId, ...getErrorFields(error) }, c.env);
      }

      if (cached?.value !== null && cached?.value !== undefined && cached.metadata?.kind === 'icon') {
        return {
          iconPack,
          iconName,
          kind: 'icon',
          status: 200,
          data: new Uint8Array(cached.value),
          contentType: 'image/png',
          cacheStatus: 'hit',
          cacheHit: true,
          timestamp: cached.metadata.timestamp,
        };
      }

      if (cacheStatus === 'unknown') cacheStatus = 'miss';

      try {
        const png = asArrayBufferBytes(
          await getPngFromSvgIcon(parsed.config, {}, { requestId, reportLevel: c.env.OBSERVABILITY_REPORT_LEVEL }),
        );
        const timestamp = Date.now();

        try {
          await c.env.assetCache.put(cacheKey, png.buffer, {
            expirationTtl: ICON_CACHE_TTL_SECONDS,
            metadata: { kind: 'icon', timestamp } satisfies CachedIconMetadata,
          });
        } catch (error) {
          cacheStatus = 'write-error';
          logEvent('warn', 'icon.cache.write_failed', { requestId, ...getErrorFields(error) }, c.env);
        }

        return {
          iconPack,
          iconName,
          kind: 'icon',
          status: 200,
          data: png,
          contentType: 'image/png',
          cacheStatus,
          cacheHit: false,
          timestamp,
        };
      } catch (error) {
        const iconError =
          error instanceof IconError
            ? error
            : new IconError('UNEXPECTED_ERROR', 'An unexpected icon-generation error occurred', {
                stage: 'render',
                retryable: false,
                cause: error,
              });

        if (iconError.upstreamStatus !== undefined) c.set('upstreamStatus', iconError.upstreamStatus);
        logEvent(
          'warn',
          'icon.delivery.failed',
          { requestId, iconPack, iconName, ...getErrorFields(iconError) },
          c.env,
        );

        return {
          iconPack,
          iconName,
          kind: 'error',
          status: errorStatus(iconError),
          error: errorMessage(iconError),
        };
      }
    },
    c.env,
  );
}

export async function handleIconRequest(c: AppContext) {
  const iconPack = c.req.param('iconPack') ?? '';
  const iconName = c.req.param('iconName') ?? '';
  const result = await fetchIcon(iconPack, iconName, new URL(c.req.url).searchParams, c);

  c.header('X-Icon-Pack', iconPack);
  c.set('cacheStatus', result.kind === 'icon' ? result.cacheStatus : 'unknown');

  if (result.kind === 'icon') {
    return c.body(result.data, 200, {
      'Content-Type': result.contentType,
      'Cache-Control': 'public, max-age=86400, stale-while-revalidate=300',
      'X-Cache-Hit': result.cacheHit ? 'true' : 'false',
      'X-Cache-Status': result.cacheStatus,
      'X-Cache-Timestamp': String(result.timestamp),
    });
  }

  return errorResponse(c, result.error, result.status);
}

const MAX_BATCH_ICONS = 50;
const MAX_BATCH_CONCURRENCY = 6;

type IconBatchItem = {
  iconPack: string;
  iconName: string;
  options: Record<string, string>;
};

type IconBatchBody = { icons: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidBatchItem(value: unknown): value is IconBatchItem {
  if (!isRecord(value) || typeof value.iconPack !== 'string' || typeof value.iconName !== 'string') return false;
  if (!isRecord(value.options)) return false;
  if (!Object.values(value.options).every((option) => typeof option === 'string')) return false;
  return true;
}

function iconResultToBatchItem(result: IconDeliveryResult) {
  if (result.kind === 'icon') {
    return {
      iconPack: result.iconPack,
      iconName: result.iconName,
      status: result.status,
      contentType: result.contentType,
      cacheStatus: result.cacheStatus,
      cacheHit: result.cacheHit,
      dataBase64: bytesToBase64(result.data),
    };
  }

  return {
    iconPack: result.iconPack,
    iconName: result.iconName,
    status: result.status,
    error: result.error,
  };
}

export async function handleIconBatchRequest(c: AppContext) {
  const requestId = c.get('requestId');
  let body: IconBatchBody;

  try {
    body = await c.req.json<IconBatchBody>();
  } catch {
    return errorResponse(c, 'Request body must be valid JSON', 400);
  }

  if (!isRecord(body) || !Array.isArray(body.icons)) {
    return errorResponse(c, 'icons must be a non-empty array', 400);
  }
  if (body.icons.length === 0) return errorResponse(c, 'icons must be a non-empty array', 400);
  if (body.icons.length > MAX_BATCH_ICONS) {
    return errorResponse(c, `A maximum of ${MAX_BATCH_ICONS} icons is allowed`, 400);
  }
  if (!body.icons.every(isValidBatchItem)) {
    return errorResponse(c, 'Each icon must include string iconPack, iconName, and options fields', 400);
  }

  const results = await mapWithConcurrency(body.icons, MAX_BATCH_CONCURRENCY, async (item) => {
    const options = new URLSearchParams(Object.entries(item.options));
    const result = await fetchIcon(item.iconPack, item.iconName, options, c);
    return iconResultToBatchItem(result);
  });

  c.set('cacheStatus', 'unknown');
  return c.json({ requestId, results }, 200);
}
