import type { Context } from 'hono';
import type { BlankInput } from 'hono/types';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { parseIconConfig } from '../iconPacks';
import { getPngFromSvgIcon, IconError } from '../icons';
import { enterTraceSpan, getErrorFields, logEvent } from '../observability';
import type { AppEnvironment } from '../types';

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

function errorStatus(error: IconError): ContentfulStatusCode {
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

export async function handleIconRequest(c: Context<AppEnvironment, '/icons/:iconPack/:iconName', BlankInput>) {
  return enterTraceSpan(
    'icon.delivery',
    async (span) => {
      const requestId = c.get('requestId');
      const iconPack = c.req.param('iconPack');
      const iconName = c.req.param('iconName');
      const query = new URL(c.req.url).searchParams;
      let parsed: ReturnType<typeof parseIconConfig>;

      try {
        parsed = parseIconConfig(iconPack, iconName, query);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid icon request';
        return c.json({ error: message, requestId }, 400);
      }

      c.header('X-Icon-Pack', iconPack);
      span.setAttribute('icon.provider', iconPack);

      const cacheKey = iconCacheKey(iconPack, parsed.normalizedOptions, iconName);
      let cached: { value: ArrayBuffer | null; metadata: CachedIconMetadata | null } | undefined;

      try {
        cached = await c.env.assetCache.getWithMetadata<CachedIconMetadata>(cacheKey, 'arrayBuffer');
      } catch (error) {
        c.set('cacheStatus', 'read-error');
        logEvent('warn', 'icon.cache.read_failed', { requestId, ...getErrorFields(error) }, c.env);
      }

      if (cached?.value !== null && cached?.value !== undefined && cached.metadata?.kind === 'icon') {
        c.set('cacheStatus', 'hit');
        return c.body(new Uint8Array(cached.value), 200, {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=86400, stale-while-revalidate=300',
          'X-Cache-Hit': 'true',
          'X-Cache-Status': 'hit',
          'X-Cache-Timestamp': String(cached.metadata.timestamp),
        });
      }

      if (c.get('cacheStatus') === 'unknown') c.set('cacheStatus', 'miss');

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
          c.set('cacheStatus', 'write-error');
          logEvent('warn', 'icon.cache.write_failed', { requestId, ...getErrorFields(error) }, c.env);
        }

        return c.body(png, 200, {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=86400, stale-while-revalidate=300',
          'X-Cache-Hit': 'false',
          'X-Cache-Status': c.get('cacheStatus'),
          'X-Cache-Timestamp': String(timestamp),
        });
      } catch (error) {
        const iconError =
          error instanceof IconError
            ? error
            : new IconError('UNEXPECTED_ERROR', 'An unexpected icon-generation error occurred', {
                stage: 'render',
                retryable: false,
                cause: error,
              });

        c.set('upstreamStatus', iconError.upstreamStatus);
        logEvent(
          'warn',
          'icon.delivery.failed',
          { requestId, iconPack, iconName, ...getErrorFields(iconError) },
          c.env,
        );

        return c.json({ error: errorMessage(iconError), requestId }, errorStatus(iconError));
      }
    },
    c.env,
  );
}
