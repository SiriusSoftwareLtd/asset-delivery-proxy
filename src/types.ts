import type { Context } from 'hono';

export type CacheStatus =
  | 'unknown'
  | 'bypass'
  | 'hit'
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
  };
};

export type AppContext = Context<AppEnvironment>;

export type CachedAssetMetadata =
  | {
      kind: 'asset';
      timestamp: number;
      contentType: string;
      extension?: string;
    }
  | {
      kind: 'not-found';
      timestamp: number;
    };

export type TraceSpan = {
  setAttribute(name: string, value: unknown): void;
};
