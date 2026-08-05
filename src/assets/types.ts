/*
 * Copyright (c) 2026 Corridon Capital
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

export type CacheStatus =
  | 'unknown'
  | 'bypass'
  | 'hit'
  | 'l1-hit'
  | 'kv-fresh-hit'
  | 'stale-hit'
  | 'miss'
  | 'negative-hit'
  | 'negative-write'
  | 'read-error'
  | 'corrupt'
  | 'write-error';

export type CachedAssetMetadata = { kind: 'not-found'; timestamp: number } | CurrentCachedAssetMetadata;
export type CurrentCachedAssetMetadata = {
  kind: 'asset';
  version: 2;
  timestamp: number;
  storedAt: number;
  freshUntil: number;
  staleUntil: number;
  contentType: string;
  extension?: string;
};
export type AssetProtocol = 'v1' | 'v2';
export type AssetResolutionOrigin = 'kv' | 'upstream' | 'admission';
export type AssetCacheWriteOutcome = 'written' | 'failed' | 'not-attempted';
export type AssetResolutionIdentity = {
  assetId: string;
  canonicalKey: string;
  physicalKey: string;
  shardKey: string;
  protocol: AssetProtocol;
  upstreamUrl: string;
  upstreamHeaders: Record<string, string>;
};
export type AssetResolutionResult =
  | {
      kind: 'asset';
      status: 200;
      data: Uint8Array<ArrayBuffer>;
      contentType: string;
      extension?: string;
      timestamp: number;
      upstreamStatus?: number;
      attempts: number;
      queueTimeMs: number;
      joined: boolean;
      origin: AssetResolutionOrigin;
      cacheWrite?: AssetCacheWriteOutcome;
    }
  | {
      kind: 'not-found' | 'error';
      status: number;
      error: string;
      contentType?: string;
      data?: Uint8Array<ArrayBuffer>;
      timestamp?: number;
      upstreamStatus?: number;
      retryAfter?: number;
      attempts: number;
      queueTimeMs: number;
      joined: boolean;
      origin: AssetResolutionOrigin;
      cacheWrite?: AssetCacheWriteOutcome;
    };
export type AssetCoordinatorRequest = { identity: AssetResolutionIdentity; deadline: number; backpressure: boolean };
