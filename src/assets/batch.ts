/*
 * Copyright (c) 2026 Corridon Capital
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { HTTPException } from 'hono/http-exception';
import type { AppContext } from '../http/context';
import { bytesToBase64 } from '../http/encoding';
import { mapWithConcurrency } from '../shared/concurrency';
import { type AssetDeliveryResult, fetchAsset, prepareAssetIdentity, shouldUseAssetDeliveryV2 } from './delivery';

export const MAX_BATCH_ASSETS = 25;
export const MAX_BATCH_CONCURRENCY = 6;

export function assetResultToBatchItem(result: AssetDeliveryResult) {
  if (result.kind === 'asset')
    return {
      assetId: result.assetId,
      status: result.status,
      contentType: result.contentType,
      ...(result.extension ? { extension: result.extension } : {}),
      cacheStatus: result.cacheStatus,
      cacheHit: result.cacheHit,
      dataBase64: bytesToBase64(result.data),
    };
  return {
    assetId: result.assetId,
    status: result.status,
    cacheStatus: result.cacheStatus,
    cacheHit: result.cacheHit,
    error: result.error,
  };
}

export async function deliverAssetBatch(assetIds: string[], c: AppContext) {
  const useV2 = await shouldUseAssetDeliveryV2(c);
  const prepared = await Promise.all(
    assetIds.map(async (assetId) => ({ assetId, identity: await prepareAssetIdentity(assetId, c, c.req.raw, useV2) })),
  );
  const inFlight = new Map<string, Promise<AssetDeliveryResult>>();
  return mapWithConcurrency(prepared, MAX_BATCH_CONCURRENCY, async ({ assetId, identity }) => {
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
}
