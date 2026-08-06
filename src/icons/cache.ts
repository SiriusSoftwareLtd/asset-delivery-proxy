/*
 * Copyright (c) 2026 Corridon Capital
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { CacheStatus } from '../assets/types';

export const ICON_CACHE_TTL_SECONDS = 24 * 60 * 60;
const ICON_L1_ORIGIN = 'https://icon-cache.internal';
const l1Namespaces = new WeakMap<object, string>();
let nextL1Namespace = 0;
export type CachedIconMetadata = { kind: 'icon' | 'not-found'; timestamp: number };

export function iconCacheKey(iconPack: string, normalizedOptions: string, iconName: string): string {
  return `icon:v1:${encodeURIComponent(iconPack)}:${encodeURIComponent(normalizedOptions)}:${encodeURIComponent(iconName)}`;
}

export type IconCacheRead = { value: ArrayBuffer | null; metadata: CachedIconMetadata | null; status: CacheStatus };

function l1Namespace(cache: KVNamespace): string {
  const existing = l1Namespaces.get(cache);
  if (existing) return existing;
  const namespace = String(++nextL1Namespace);
  l1Namespaces.set(cache, namespace);
  return namespace;
}

function iconL1Request(cache: KVNamespace, key: string): Request {
  return new Request(`${ICON_L1_ORIGIN}/${l1Namespace(cache)}/${encodeURIComponent(key)}`);
}

export async function readIconL1(cache: KVNamespace, key: string): Promise<IconCacheRead> {
  try {
    const response = await caches.default.match(iconL1Request(cache, key));
    if (!response) return { value: null, metadata: null, status: 'miss' };
    const timestamp = Number(response.headers.get('X-Icon-Timestamp'));
    if (!Number.isFinite(timestamp)) return { value: null, metadata: null, status: 'miss' };
    const value = await response.arrayBuffer();
    if (value.byteLength === 0) return { value: null, metadata: null, status: 'miss' };
    return { value, metadata: { kind: 'icon', timestamp }, status: 'l1-hit' };
  } catch {
    return { value: null, metadata: null, status: 'miss' };
  }
}

export async function populateIconL1(
  cache: KVNamespace,
  key: string,
  png: Uint8Array<ArrayBuffer>,
  timestamp: number,
): Promise<void> {
  await caches.default.put(
    iconL1Request(cache, key),
    new Response(png, {
      headers: {
        'Cache-Control': `public, max-age=${ICON_CACHE_TTL_SECONDS}`,
        'Content-Type': 'image/png',
        'X-Icon-Timestamp': String(timestamp),
      },
    }),
  );
}

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
