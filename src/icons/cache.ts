/*
 * Copyright (c) 2026 Corridon Capital
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { CacheStatus } from '../assets/types';

export const ICON_CACHE_TTL_SECONDS = 24 * 60 * 60;
export type CachedIconMetadata = { kind: 'icon' | 'not-found'; timestamp: number };

export function iconCacheKey(iconPack: string, normalizedOptions: string, iconName: string): string {
  return `icon:v1:${encodeURIComponent(iconPack)}:${encodeURIComponent(normalizedOptions)}:${encodeURIComponent(iconName)}`;
}

export type IconCacheRead = { value: ArrayBuffer | null; metadata: CachedIconMetadata | null; status: CacheStatus };

export async function readIconCache(
  cache: KVNamespace,
  key: string,
  onError: (error: unknown) => void,
): Promise<IconCacheRead> {
  try {
    const result = await cache.getWithMetadata<CachedIconMetadata>(key, 'arrayBuffer');
    if (result.value !== null && result.metadata?.kind === 'icon') return { ...result, status: 'hit' };
    return { ...result, status: 'miss' };
  } catch (error) {
    onError(error);
    return { value: null, metadata: null, status: 'read-error' };
  }
}

export async function writeIconCache(
  cache: KVNamespace,
  key: string,
  png: Uint8Array<ArrayBuffer>,
  timestamp: number,
): Promise<void> {
  await cache.put(key, png.buffer, {
    expirationTtl: ICON_CACHE_TTL_SECONDS,
    metadata: { kind: 'icon', timestamp } satisfies CachedIconMetadata,
  });
}
