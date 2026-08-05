/*
 * Copyright (c) 2026 Corridon Capital
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { CacheStatus } from '../assets/types';
import type { AppContext } from '../http/context';
import { getErrorFields, logEvent } from '../observability/logging';
import { enterTraceSpan } from '../observability/tracing';
import { parseIconConfig } from '../services/icons/config';
import { IconError } from '../services/icons/errors';
import { getPngFromSvgIcon } from '../services/icons/generator';
import { fetchRayfieldIcon } from '../services/icons/rayfield';
import { iconCacheKey, readIconCache, writeIconCache } from './cache';

function asArrayBufferBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
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
  | { iconPack: string; iconName: string; kind: 'error'; status: 400 | 404 | 502 | 504; error: string };

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
        const iconError =
          error instanceof IconError
            ? error
            : new IconError('INVALID_CONFIG', error instanceof Error ? error.message : 'Invalid config request', {
                stage: 'validation',
                retryable: false,
                cause: error,
              });
        return { iconPack, iconName, kind: 'error', status: errorStatus(iconError), error: errorMessage(iconError) };
      }
      span.setAttribute('icon.provider', iconPack);
      const key = iconCacheKey(iconPack, parsed.normalizedOptions, parsed.cacheIdentity);
      const cached = await readIconCache(c.env.assetCache, key, (error) =>
        logEvent('warn', 'icon.cache.read_failed', { requestId, ...getErrorFields(error) }, c.env),
      );
      if (cached.value !== null && cached.metadata?.kind === 'icon') {
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
      try {
        const png =
          parsed.config.iconType === 'rayfield'
            ? await fetchRayfieldIcon(parsed.config.assetId)
            : asArrayBufferBytes(
                await getPngFromSvgIcon(
                  parsed.config,
                  {},
                  { requestId, reportLevel: c.env.OBSERVABILITY_REPORT_LEVEL },
                ),
              );
        const timestamp = Date.now();
        let cacheStatus: CacheStatus = cached.status === 'read-error' ? 'read-error' : 'miss';
        try {
          await writeIconCache(c.env.assetCache, key, png, timestamp);
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
        return { iconPack, iconName, kind: 'error', status: errorStatus(iconError), error: errorMessage(iconError) };
      }
    },
    c.env,
  );
}
