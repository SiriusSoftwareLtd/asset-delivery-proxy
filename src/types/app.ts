import type { Context } from 'hono';
import type { BlankInput } from 'hono/types';

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

export type AppEnvironment = {
  Bindings: CloudflareBindings;
  Variables: {
    requestId: string;
    cacheStatus: CacheStatus;
    upstreamStatus?: number;
    assetMissLimit?: Promise<boolean>;
    assetLazyLimitEnabled: boolean;
    '.rateLimit'?: boolean;
  };
};

export type AppContext = Context<AppEnvironment, string, BlankInput>;

export type CachedAssetMetadata =
  | {
      kind: 'not-found';
      timestamp: number;
    }
  | CurrentCachedAssetMetadata;

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

/**
 * Describes where an asset resolution result came from.
 *
 * - `kv`: The coordinator returned an asset or negative result from Workers KV without contacting Roblox.
 * - `upstream`: The result came from a Roblox request, including upstream errors and timeouts.
 * - `admission`: The coordinator rejected the request before contacting Roblox, such as for cooldown, queue limits, or an expired deadline.
 */
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

export type AssetCoordinatorRequest = {
  identity: AssetResolutionIdentity;
  deadline: number;
  backpressure: boolean;
};
