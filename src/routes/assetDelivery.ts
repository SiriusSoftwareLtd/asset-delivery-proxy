import { HTTPException } from 'hono/http-exception';
import { errorResponse } from '../http/responses';
import { type AssetDeliveryResult, fetchAsset, isValidAssetId } from '../services/assets/delivery';
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
    return errorResponse(c, result.error, 403);
  }

  return new Response(result.data ?? new Uint8Array(), {
    status: result.status,
    headers: {
      ...(result.contentType ? { 'Content-Type': result.contentType } : {}),
      'X-Cache-Hit': 'false',
      'X-Cache-Status': result.cacheStatus,
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
  const inFlight = new Map<string, Promise<AssetDeliveryResult>>();
  const results = await mapWithConcurrency(assetIds, MAX_BATCH_CONCURRENCY, async (assetId) => {
    let operation = inFlight.get(assetId);

    if (!operation) {
      operation = fetchAsset(assetId, c, c.req.raw).catch((error: unknown) => {
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
      inFlight.set(assetId, operation);
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
