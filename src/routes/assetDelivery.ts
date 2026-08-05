/*
 * Copyright (c) 2026 Corridon Capital
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { errorResponse } from '../http/responses';
import {
  type AssetDeliveryResult,
  fetchAsset,
  isValidAssetId,
  prepareAssetIdentity,
  shouldUseAssetDeliveryV2,
} from '../services/assets/delivery';
import type { AppContext } from '../types/app';
import { bytesToBase64, mapWithConcurrency } from '../utils/batch';

const ASSET_EXTENSION_HEADER = 'X-Asset-Extension';
const MAX_BATCH_ASSETS = 25;
const MAX_BATCH_CONCURRENCY = 6;

type BatchBody = { assetIds: unknown };

function resultToResponse(c: AppContext, result: AssetDeliveryResult): Response {
  c.set('cacheStatus', result.cacheStatus);
  if (result.upstreamStatus !== undefined) c.set('upstreamStatus', result.upstreamStatus);

  if (result.kind === 'asset') {
    return c.body(result.data, 200, {
      'Content-Type': result.contentType,
      ...(result.extension ? { [ASSET_EXTENSION_HEADER]: result.extension } : {}),
      'X-Cache-Hit': result.cacheHit ? 'true' : 'false',
      'X-Cache-Status': result.cacheStatus,
      ...(result.retryAfter !== undefined ? { 'Retry-After': result.retryAfter.toString() } : {}),
      ...(result.timestamp !== undefined ? { 'X-Cache-Timestamp': result.timestamp.toString() } : {}),
    });
  }

  if (result.kind === 'not-found') {
    return c.json({ error: result.error, requestId: c.get('requestId') }, 404, {
      'X-Cache-Hit': result.cacheHit ? 'true' : 'false',
      'X-Cache-Status': result.cacheStatus,
      ...(result.retryAfter !== undefined ? { 'Retry-After': result.retryAfter.toString() } : {}),
      ...(result.timestamp !== undefined ? { 'X-Cache-Timestamp': result.timestamp.toString() } : {}),
    });
  }

  if (result.data === undefined) {
    const response = errorResponse(c, result.error, result.status as ContentfulStatusCode);
    response.headers.set('X-Cache-Hit', 'false');
    response.headers.set('X-Cache-Status', result.cacheStatus);
    if (result.retryAfter !== undefined) response.headers.set('Retry-After', result.retryAfter.toString());
    return response;
  }

  return new Response(result.data ?? new Uint8Array(), {
    status: result.status,
    headers: {
      ...(result.contentType ? { 'Content-Type': result.contentType } : {}),
      'X-Cache-Hit': 'false',
      'X-Cache-Status': result.cacheStatus,
      ...(result.retryAfter !== undefined ? { 'Retry-After': result.retryAfter.toString() } : {}),
    },
  });
}

export async function handleAssetDelivery(c: AppContext): Promise<Response> {
  const result = await fetchAsset(c.req.param('assetId') ?? '', c, c.req.raw);
  return resultToResponse(c, result);
}

export async function handleAssetBatchRequest(c: AppContext): Promise<Response> {
  const requestId = c.get('requestId');

  if (c.req.header('X-Rayfield-Secure-Mode') !== 'true') {
    c.set('cacheStatus', 'bypass');
    return errorResponse(c, 'Secure mode is required', 403);
  }

  let body: BatchBody;
  try {
    body = await c.req.json<BatchBody>();
  } catch {
    return errorResponse(c, 'Request body must be valid JSON', 400);
  }

  if (!body || typeof body !== 'object' || !Array.isArray(body.assetIds) || body.assetIds.length === 0) {
    return errorResponse(c, 'assetIds must be a non-empty array', 400);
  }
  if (body.assetIds.length > MAX_BATCH_ASSETS) {
    return errorResponse(c, `A maximum of ${MAX_BATCH_ASSETS} asset IDs is allowed`, 400);
  }
  if (!body.assetIds.every(isValidAssetId)) {
    return errorResponse(c, 'Invalid Roblox asset ID', 400);
  }

  const assetIds = body.assetIds.filter(isValidAssetId);
  const useAssetDeliveryV2 = await shouldUseAssetDeliveryV2(c);
  const prepared = await Promise.all(
    assetIds.map(async (assetId) => ({
      assetId,
      identity: await prepareAssetIdentity(assetId, c, c.req.raw, useAssetDeliveryV2),
    })),
  );
  const inFlight = new Map<string, Promise<AssetDeliveryResult>>();
  const results = await mapWithConcurrency(prepared, MAX_BATCH_CONCURRENCY, async ({ assetId, identity }) => {
    let operation = inFlight.get(identity.canonicalKey);

    if (!operation) {
      operation = fetchAsset(assetId, c, c.req.raw, identity).catch((error: unknown) => {
        const status = error instanceof HTTPException ? error.status : 500;
        return {
          assetId,
          kind: 'error',
          status,
          error: error instanceof HTTPException ? error.message : 'Internal server error',
          cacheStatus: 'bypass',
          cacheHit: false,
        } satisfies AssetDeliveryResult;
      });
      inFlight.set(identity.canonicalKey, operation);
    }

    return assetResultToBatchItem(await operation);
  });

  c.set('cacheStatus', 'unknown');
  return c.json({ requestId, results }, 200);
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
