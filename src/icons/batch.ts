/*
 * Copyright (c) 2026 Corridon Capital
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { CacheStatus } from '../assets/types';
import type { AppContext } from '../http/context';
import { bytesToBase64 } from '../http/encoding';
import { parseIconConfig } from '../services/icons/config';
import { mapWithConcurrency } from '../shared/concurrency';
import { iconCacheKey } from './cache';
import { fetchIcon, type IconDeliveryResult } from './delivery';

export const MAX_ICON_BATCH_SIZE = 50;
export const MAX_ICON_BATCH_CONCURRENCY = 6;

export type IconBatchItem = { iconPack: string; iconName: string; options: Record<string, string> };

export type IconBatchResult =
  | {
      iconPack: string;
      iconName: string;
      status: 200;
      contentType: 'image/png';
      cacheStatus: CacheStatus;
      cacheHit: boolean;
      dataBase64: string;
    }
  | { iconPack: string; iconName: string; status: 400 | 404 | 502 | 504; error: string };

export type IconBatchDeliveryResult =
  | { kind: 'success'; results: IconBatchResult[] }
  | { kind: 'invalid'; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidBatchItem(value: unknown): value is IconBatchItem {
  return (
    isRecord(value) &&
    typeof value.iconPack === 'string' &&
    typeof value.iconName === 'string' &&
    isRecord(value.options) &&
    Object.values(value.options).every((option) => typeof option === 'string')
  );
}

function iconResultToBatchItem(
  result: IconDeliveryResult,
  encodedData: Map<Uint8Array, string>,
  identity: Pick<IconBatchItem, 'iconPack' | 'iconName'>,
): IconBatchResult {
  const { iconPack, iconName } = identity;
  if (result.kind === 'icon') {
    let dataBase64 = encodedData.get(result.data);
    if (dataBase64 === undefined) {
      dataBase64 = bytesToBase64(result.data);
      encodedData.set(result.data, dataBase64);
    }
    return {
      iconPack,
      iconName,
      status: result.status,
      contentType: result.contentType,
      cacheStatus: result.cacheStatus,
      cacheHit: result.cacheHit,
      dataBase64,
    };
  }
  return { iconPack, iconName, status: result.status, error: result.error };
}

function iconBatchIdentity(item: IconBatchItem, query: URLSearchParams): string {
  let key = `${item.iconPack}\0${item.iconName}\0${query.toString()}`;
  try {
    const parsed = parseIconConfig(item.iconPack, item.iconName, query);
    key = iconCacheKey(item.iconPack, parsed.normalizedOptions, parsed.cacheIdentity);
  } catch {
    // Keep invalid requests locally coalesced by their original fields.
  }
  return key;
}

export async function deliverIconBatch(items: readonly unknown[], c: AppContext): Promise<IconBatchDeliveryResult> {
  if (items.length === 0) return { kind: 'invalid', error: 'icons must be a non-empty array' };
  if (items.length > MAX_ICON_BATCH_SIZE)
    return { kind: 'invalid', error: `A maximum of ${MAX_ICON_BATCH_SIZE} icons is allowed` };
  if (!items.every(isValidBatchItem))
    return { kind: 'invalid', error: 'Each icon must include string iconPack, iconName, and options fields' };

  const inFlight = new Map<string, Promise<IconDeliveryResult>>();
  const encodedData = new Map<Uint8Array, string>();
  const results = await mapWithConcurrency(items, MAX_ICON_BATCH_CONCURRENCY, async (item) => {
    const query = new URLSearchParams(Object.entries(item.options));
    const key = iconBatchIdentity(item, query);
    let operation = inFlight.get(key);
    if (!operation) {
      operation = fetchIcon(item.iconPack, item.iconName, query, c);
      inFlight.set(key, operation);
    }
    return iconResultToBatchItem(await operation, encodedData, item);
  });

  return { kind: 'success', results };
}
