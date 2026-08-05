/*
 * Copyright (c) 2026 Corridon Capital
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { deliverAssetBatch, MAX_BATCH_ASSETS } from '../../assets/batch';
import { type AssetDeliveryResult, fetchAsset, isValidAssetId } from '../../assets/delivery';
import type { AppContext } from '../context';
import { errorResponse } from '../responses';

function resultToResponse(c: AppContext, result: AssetDeliveryResult): Response {
  c.set('cacheStatus', result.cacheStatus);
  if (result.upstreamStatus !== undefined) c.set('upstreamStatus', result.upstreamStatus);
  if (result.kind === 'asset')
    return c.body(result.data, 200, {
      'Content-Type': result.contentType,
      ...(result.extension ? { 'X-Asset-Extension': result.extension } : {}),
      'X-Cache-Hit': result.cacheHit ? 'true' : 'false',
      'X-Cache-Status': result.cacheStatus,
      ...(result.retryAfter !== undefined ? { 'Retry-After': result.retryAfter.toString() } : {}),
      ...(result.timestamp !== undefined ? { 'X-Cache-Timestamp': result.timestamp.toString() } : {}),
    });
  if (result.kind === 'not-found')
    return c.json({ error: result.error, requestId: c.get('requestId') }, 404, {
      'X-Cache-Hit': result.cacheHit ? 'true' : 'false',
      'X-Cache-Status': result.cacheStatus,
      ...(result.retryAfter !== undefined ? { 'Retry-After': result.retryAfter.toString() } : {}),
      ...(result.timestamp !== undefined ? { 'X-Cache-Timestamp': result.timestamp.toString() } : {}),
    });
  const response =
    result.data === undefined
      ? errorResponse(c, result.error, result.status as ContentfulStatusCode)
      : new Response(result.data, {
          status: result.status,
          headers: { ...(result.contentType ? { 'Content-Type': result.contentType } : {}) },
        });
  response.headers.set('X-Cache-Hit', 'false');
  response.headers.set('X-Cache-Status', result.cacheStatus);
  if (result.retryAfter !== undefined) response.headers.set('Retry-After', result.retryAfter.toString());
  return response;
}

export async function handleAssetDelivery(c: AppContext): Promise<Response> {
  return resultToResponse(c, await fetchAsset(c.req.param('assetId') ?? '', c, c.req.raw));
}

export async function handleAssetBatchRequest(c: AppContext): Promise<Response> {
  if (c.req.header('X-Rayfield-Secure-Mode') !== 'true') {
    c.set('cacheStatus', 'bypass');
    return errorResponse(c, 'Secure mode is required', 403);
  }
  let body: { assetIds: unknown };
  try {
    body = await c.req.json<{ assetIds: unknown }>();
  } catch {
    return errorResponse(c, 'Request body must be valid JSON', 400);
  }
  if (!body || typeof body !== 'object' || !Array.isArray(body.assetIds) || body.assetIds.length === 0)
    return errorResponse(c, 'assetIds must be a non-empty array', 400);
  if (body.assetIds.length > MAX_BATCH_ASSETS)
    return errorResponse(c, `A maximum of ${MAX_BATCH_ASSETS} asset IDs is allowed`, 400);
  if (!body.assetIds.every(isValidAssetId)) return errorResponse(c, 'Invalid Roblox asset ID', 400);
  const results = await deliverAssetBatch(body.assetIds, c);
  c.set('cacheStatus', 'unknown');
  return c.json({ requestId: c.get('requestId'), results }, 200);
}
