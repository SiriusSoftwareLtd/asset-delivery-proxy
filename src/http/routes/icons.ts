/*
 * Copyright (c) 2026 Corridon Capital
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { deliverIconBatch } from '../../icons/batch';
import { fetchIcon } from '../../icons/delivery';
import type { AppContext } from '../context';
import { errorResponse } from '../responses';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return errorResponse(c, 'Request body must be valid JSON', 400);
  }
  if (!isRecord(body) || !Array.isArray(body.icons)) return errorResponse(c, 'icons must be a non-empty array', 400);
  const batch = await deliverIconBatch(body.icons, c);
  if (batch.kind === 'invalid') return errorResponse(c, batch.error, 400);
  c.set('cacheStatus', 'unknown');
  return c.json({ requestId, results: batch.results }, 200);
}
