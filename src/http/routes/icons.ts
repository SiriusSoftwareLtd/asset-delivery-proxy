/*
 * Copyright (c) 2026 Corridon Capital
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { fetchIcon, type IconDeliveryResult } from '../../icons/delivery';
import { mapWithConcurrency } from '../../shared/concurrency';
import type { AppContext } from '../context';
import { bytesToBase64 } from '../encoding';
import { errorResponse } from '../responses';

function iconResultToBatchItem(result: IconDeliveryResult) {
  if (result.kind === 'icon')
    return {
      iconPack: result.iconPack,
      iconName: result.iconName,
      status: result.status,
      contentType: result.contentType,
      cacheStatus: result.cacheStatus,
      cacheHit: result.cacheHit,
      dataBase64: bytesToBase64(result.data),
    };
  return { iconPack: result.iconPack, iconName: result.iconName, status: result.status, error: result.error };
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
  const iconPack = c.req.param('iconPack') ?? '';
  const iconName = c.req.param('iconName') ?? '';
  const result = await fetchIcon(iconPack, iconName, new URL(c.req.url).searchParams, c);
  c.header('X-Icon-Pack', iconPack);
  c.set('cacheStatus', result.kind === 'icon' ? result.cacheStatus : 'unknown');
  if (result.kind === 'icon')
    return c.body(result.data, 200, {
      'Content-Type': result.contentType,
      'Cache-Control': 'public, max-age=86400, stale-while-revalidate=300',
      'X-Cache-Hit': result.cacheHit ? 'true' : 'false',
      'X-Cache-Status': result.cacheStatus,
      'X-Cache-Timestamp': String(result.timestamp),
    });
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
  const results = await mapWithConcurrency(body.icons, 6, async (item) =>
    iconResultToBatchItem(
      await fetchIcon(item.iconPack, item.iconName, new URLSearchParams(Object.entries(item.options)), c),
    ),
  );
  c.set('cacheStatus', 'unknown');
  return c.json({ requestId, results }, 200);
}
