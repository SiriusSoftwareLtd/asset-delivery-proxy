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
      kind: 'asset';
      timestamp: number;
      contentType: string;
      extension?: string;
      version?: 1;
      storedAt?: number;
      freshUntil?: number;
      staleUntil?: number;
    }
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
    };

export type AssetCoordinatorRequest = {
  identity: AssetResolutionIdentity;
  deadline: number;
  backpressure: boolean;
};
