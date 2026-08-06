/*
 * Copyright (c) 2026 Corridon Capital
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { iconCacheKey } from '../../icons/cache';
import { fetchIcon, type IconDeliveryResult } from '../../icons/delivery';
import { parseIconConfig } from '../../services/icons/config';
import { mapWithConcurrency } from '../../shared/concurrency';
import type { AppContext } from '../context';
import { bytesToBase64 } from '../encoding';
import { errorResponse } from '../responses';

function iconResultToBatchItem(
  result: IconDeliveryResult,
  encodedData: Map<Uint8Array, string>,
  identity: Pick<IconBatchItem, 'iconPack' | 'iconName'>,
) {
  const iconPack = identity.iconPack;
  const iconName = identity.iconName;
  if (result.kind === 'icon') {
    let dataBase64 = encodedData.get(result.data);
    if (dataBase64 === undefined) {
      dataBase64 = bytesToBase64(result.data);
      encodedData.set(result.data, dataBase64);
    }
    return {
      iconPack,
      iconName,
      status: result.status,
      contentType: result.contentType,
      cacheStatus: result.cacheStatus,
      cacheHit: result.cacheHit,
      dataBase64,
    };
  }
  return { iconPack, iconName, status: result.status, error: result.error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type IconBatchItem = { iconPack: string; iconName: string; options: Record<string, string> };
function isValidBatchItem(value: unknown): value is IconBatchItem {
  return (
    isRecord(value) &&
    typeof value.iconPack === 'string' &&
    typeof value.iconName === 'string' &&
    isRecord(value.options) &&
    Object.values(value.options).every((option) => typeof option === 'string')
  );
}

export async function handleIconRequest(c: AppContext): Promise<Response> {
  const iconPack = c.req.param('iconPack') as string;
  const iconName = c.req.param('iconName') as string;

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

export async function handleIconBatchRequest(c: AppContext): Promise<Response> {
  const requestId = c.get('requestId');
  let body: { icons: unknown };
  try {
    body = await c.req.json<{ icons: unknown }>();
  } catch {
    return errorResponse(c, 'Request body must be valid JSON', 400);
  }
  if (!isRecord(body) || !Array.isArray(body.icons) || body.icons.length === 0)
    return errorResponse(c, 'icons must be a non-empty array', 400);
  if (body.icons.length > 50) return errorResponse(c, 'A maximum of 50 icons is allowed', 400);
  if (!body.icons.every(isValidBatchItem))
    return errorResponse(c, 'Each icon must include string iconPack, iconName, and options fields', 400);
  const inFlight = new Map<string, Promise<IconDeliveryResult>>();
  const encodedData = new Map<Uint8Array, string>();
  const results = await mapWithConcurrency(body.icons, 6, async (item) => {
    const query = new URLSearchParams(Object.entries(item.options));
    let key = `${item.iconPack}\0${item.iconName}\0${query.toString()}`;
    try {
      const parsed = parseIconConfig(item.iconPack, item.iconName, query);
      key = iconCacheKey(item.iconPack, parsed.normalizedOptions, parsed.cacheIdentity);
    } catch {
      // Keep invalid requests locally coalesced by their original fields.
    }
    let operation = inFlight.get(key);
    if (!operation) {
      operation = fetchIcon(item.iconPack, item.iconName, query, c);
      inFlight.set(key, operation);
    }
    return iconResultToBatchItem(await operation, encodedData, item);
  });
  c.set('cacheStatus', 'unknown');
  return c.json({ requestId, results }, 200);
}
