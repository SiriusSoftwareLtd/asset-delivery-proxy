/*
 * Copyright (c) 2026 Corridon Capital
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { AssetResolutionIdentity, CachedAssetMetadata, CurrentCachedAssetMetadata } from '../../assets/types';
import { getErrorFields, logEvent } from '../../observability/logging';
import { buildRobloxV1Url, buildRobloxV2Request } from './roblox';

export const ASSET_FRESH_TTL_MS = 24 * 60 * 60 * 1_000;
export const ASSET_RETENTION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const NEGATIVE_CACHE_TTL_SECONDS = 5 * 60;

const INTERNAL_CACHE_ORIGIN = 'https://asset-cache.internal';

export type AssetCacheEntry = {
  data: Uint8Array<ArrayBuffer>;
  metadata: CurrentCachedAssetMetadata;
  state: 'fresh' | 'stale';
};

export type AssetCacheRead =
  | { kind: 'asset'; entry: AssetCacheEntry; source: 'l1' | 'kv' }
  | { kind: 'not-found'; timestamp: number; source: 'kv' }
  | { kind: 'miss' };

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

export async function buildAssetResolutionIdentity(
  assetId: string,
  request: Request,
  useAssetDeliveryV2: boolean,
): Promise<AssetResolutionIdentity> {
  const v2Request = useAssetDeliveryV2 ? buildRobloxV2Request(assetId, request) : undefined;
  const canonicalKey = v2Request?.cacheKey ?? `v1|${assetId}`;
  const hash = await sha256(canonicalKey);
  const headers: Record<string, string> = {};
  new Headers(v2Request?.init.headers).forEach((value, name) => {
    headers[name] = value;
  });

  return {
    assetId,
    canonicalKey,
    physicalKey: `asset:v2:${hash}`,
    shardKey: hash,
    protocol: v2Request ? 'v2' : 'v1',
    upstreamUrl: v2Request?.url ?? buildRobloxV1Url(assetId),
    upstreamHeaders: headers,
  };
}

function currentMetadata(metadata: CachedAssetMetadata, now: number): CurrentCachedAssetMetadata | undefined {
  if (
    metadata.kind !== 'asset' ||
    metadata.version !== 2 ||
    typeof metadata.contentType !== 'string' ||
    metadata.contentType.length === 0
  ) {
    return undefined;
  }
  if (typeof metadata.timestamp !== 'number' || !Number.isFinite(metadata.timestamp)) return undefined;

  if (
    typeof metadata.storedAt !== 'number' ||
    typeof metadata.freshUntil !== 'number' ||
    typeof metadata.staleUntil !== 'number' ||
    !Number.isFinite(metadata.storedAt) ||
    !Number.isFinite(metadata.freshUntil) ||
    !Number.isFinite(metadata.staleUntil) ||
    metadata.freshUntil < metadata.storedAt ||
    metadata.staleUntil < metadata.freshUntil ||
    metadata.staleUntil <= now
  ) {
    return undefined;
  }

  return {
    kind: 'asset',
    version: 2,
    timestamp: metadata.timestamp,
    storedAt: metadata.storedAt,
    freshUntil: metadata.freshUntil,
    staleUntil: metadata.staleUntil,
    contentType: metadata.contentType,
    extension: metadata.extension,
  };
}

function l1Request(identity: AssetResolutionIdentity): Request {
  return new Request(`${INTERNAL_CACHE_ORIGIN}/${identity.physicalKey}`, { method: 'GET' });
}

export async function readL1(identity: AssetResolutionIdentity, now = Date.now()): Promise<AssetCacheRead> {
  try {
    const response = await caches.default.match(l1Request(identity));
    if (!response) return { kind: 'miss' };

    const freshUntil = Number(response.headers.get('X-Asset-Fresh-Until'));
    const storedAt = Number(response.headers.get('X-Asset-Stored-At'));
    const timestamp = Number(response.headers.get('X-Asset-Timestamp'));
    const contentType = response.headers.get('X-Asset-Content-Type');
    if (
      !Number.isFinite(freshUntil) ||
      freshUntil <= now ||
      !Number.isFinite(storedAt) ||
      !Number.isFinite(timestamp) ||
      !contentType
    ) {
      return { kind: 'miss' };
    }

    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength === 0) return { kind: 'miss' };
    return {
      kind: 'asset',
      source: 'l1',
      entry: {
        data,
        state: 'fresh',
        metadata: {
          kind: 'asset',
          version: 2,
          timestamp,
          storedAt,
          freshUntil,
          staleUntil: Number(response.headers.get('X-Asset-Stale-Until')),
          contentType,
          extension: response.headers.get('X-Asset-Extension') ?? undefined,
        },
      },
    };
  } catch {
    return { kind: 'miss' };
  }
}

export async function populateL1(identity: AssetResolutionIdentity, entry: AssetCacheEntry): Promise<void> {
  if (entry.state !== 'fresh') return;

  const ttl = Math.max(1, Math.floor((entry.metadata.freshUntil - Date.now()) / 1_000));
  const headers = new Headers({
    'Cache-Control': `public, max-age=${ttl}`,
    'Content-Type': 'application/octet-stream',
    'X-Asset-Content-Type': entry.metadata.contentType,
    'X-Asset-Fresh-Until': entry.metadata.freshUntil.toString(),
    'X-Asset-Stale-Until': entry.metadata.staleUntil.toString(),
    'X-Asset-Stored-At': entry.metadata.storedAt.toString(),
    'X-Asset-Timestamp': entry.metadata.timestamp.toString(),
  });
  if (entry.metadata.extension) headers.set('X-Asset-Extension', entry.metadata.extension);
  await caches.default.put(l1Request(identity), new Response(entry.data, { headers }));
}

async function readKvKey(
  assetCache: KVNamespace,
  identity: AssetResolutionIdentity,
  now: number,
): Promise<AssetCacheRead> {
  const cached = await assetCache.getWithMetadata<CachedAssetMetadata>(identity.physicalKey, 'arrayBuffer');
  if (cached.value === null) return { kind: 'miss' };
  if (!cached.metadata) throw new TypeError('Cached asset metadata is missing');

  if (cached.metadata.kind === 'not-found') {
    if (typeof cached.metadata.timestamp !== 'number' || !Number.isFinite(cached.metadata.timestamp)) {
      throw new TypeError('Cached asset timestamp is invalid');
    }
    return { kind: 'not-found', source: 'kv', timestamp: cached.metadata.timestamp };
  }

  const metadata = currentMetadata(cached.metadata, now);
  if (!metadata || cached.value.byteLength === 0) throw new TypeError('Cached asset is invalid or expired');
  return {
    kind: 'asset',
    source: 'kv',
    entry: {
      data: new Uint8Array(cached.value),
      metadata,
      state: metadata.freshUntil > now ? 'fresh' : 'stale',
    },
  };
}

export async function readKv(
  assetCache: KVNamespace,
  identity: AssetResolutionIdentity,
  options: { onError?: (error: unknown) => void } = {},
): Promise<AssetCacheRead> {
  const now = Date.now();
  try {
    return await readKvKey(assetCache, identity, now);
  } catch (error) {
    options.onError?.(error);
    try {
      await assetCache.delete(identity.physicalKey);
    } catch {
      // A failed cleanup must not turn a recoverable miss into a request failure.
    }
    return { kind: 'miss' };
  }
}

export async function writeAssetToKv(
  assetCache: KVNamespace,
  identity: AssetResolutionIdentity,
  data: Uint8Array<ArrayBuffer>,
  contentType: string,
  extension: string | undefined,
  timestamp = Date.now(),
): Promise<CurrentCachedAssetMetadata> {
  const metadata: CurrentCachedAssetMetadata = {
    kind: 'asset',
    version: 2,
    timestamp,
    storedAt: timestamp,
    freshUntil: timestamp + ASSET_FRESH_TTL_MS,
    staleUntil: timestamp + ASSET_RETENTION_TTL_SECONDS * 1_000,
    contentType,
    extension,
  };
  await assetCache.put(identity.physicalKey, data, {
    expirationTtl: ASSET_RETENTION_TTL_SECONDS,
    metadata,
  });
  return metadata;
}

export async function writeNotFoundToKv(
  assetCache: KVNamespace,
  identity: AssetResolutionIdentity,
  timestamp = Date.now(),
): Promise<void> {
  await assetCache.put(identity.physicalKey, new ArrayBuffer(0), {
    expirationTtl: NEGATIVE_CACHE_TTL_SECONDS,
    metadata: { kind: 'not-found', timestamp } satisfies CachedAssetMetadata,
  });
}

export function logCacheError(
  event: string,
  error: unknown,
  fields: Record<string, unknown>,
  env: CloudflareBindings,
): void {
  logEvent('warn', event, { ...fields, ...getErrorFields(error) }, env);
}
