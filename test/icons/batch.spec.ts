/*
 * Copyright (c) 2026 Corridon Capital
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import type { AppContext } from '../../src/http/context';
import type { IconDeliveryResult } from '../../src/icons/delivery';

const mocks = vi.hoisted(() => ({
  fetchIcon: vi.fn(),
  bytesToBase64: vi.fn(() => 'encoded-png'),
}));

vi.mock('../../src/icons/delivery', () => ({ fetchIcon: mocks.fetchIcon }));
vi.mock('../../src/http/encoding', () => ({ bytesToBase64: mocks.bytesToBase64 }));

import { deliverIconBatch, MAX_ICON_BATCH_SIZE } from '../../src/icons/batch';

function createContext(): AppContext {
  return {} as AppContext;
}

function iconResult(iconPack: string, iconName: string, data = new Uint8Array([1, 2, 3])): IconDeliveryResult {
  return {
    iconPack,
    iconName,
    kind: 'icon',
    status: 200,
    data,
    contentType: 'image/png',
    cacheStatus: 'miss',
    cacheHit: false,
    timestamp: 1,
  };
}

function errorResult(iconPack: string, iconName: string): IconDeliveryResult {
  return { iconPack, iconName, kind: 'error', status: 502, error: 'Unable to generate icon' };
}

afterEach(() => {
  mocks.fetchIcon.mockReset();
  mocks.bytesToBase64.mockClear();
});

describe('deliverIconBatch', () => {
  test('delivers a valid single-item batch', async () => {
    mocks.fetchIcon.mockResolvedValue(iconResult('lucide', 'check'));

    const result = await deliverIconBatch([{ iconPack: 'lucide', iconName: 'check', options: {} }], createContext());

    expect(result).toEqual({
      kind: 'success',
      results: [
        expect.objectContaining({
          iconPack: 'lucide',
          iconName: 'check',
          status: 200,
          contentType: 'image/png',
          cacheStatus: 'miss',
          cacheHit: false,
          dataBase64: 'encoded-png',
        }),
      ],
    });
    expect(mocks.fetchIcon).toHaveBeenCalledTimes(1);
  });

  test('preserves input order while unique icons resolve concurrently', async () => {
    mocks.fetchIcon.mockImplementation(async (iconPack: string, iconName: string) => {
      await new Promise((resolve) => setTimeout(resolve, iconName === 'slow' ? 10 : 0));
      return iconResult(iconPack, iconName);
    });

    const result = await deliverIconBatch(
      [
        { iconPack: 'lucide', iconName: 'slow', options: {} },
        { iconPack: 'lucide', iconName: 'fast', options: {} },
      ],
      createContext(),
    );

    expect(result.kind).toBe('success');
    if (result.kind === 'success') expect(result.results.map(({ iconName }) => iconName)).toEqual(['slow', 'fast']);
    expect(mocks.fetchIcon).toHaveBeenCalledTimes(2);
  });

  test('coalesces equivalent duplicate requests and preserves all positions', async () => {
    mocks.fetchIcon.mockResolvedValue(iconResult('lucide', 'duplicate'));

    const result = await deliverIconBatch(
      [
        { iconPack: 'lucide', iconName: 'duplicate', options: { size: '64' } },
        { iconPack: 'lucide', iconName: 'duplicate', options: { size: '064' } },
        { iconPack: 'lucide', iconName: 'duplicate', options: { size: '64' } },
      ],
      createContext(),
    );

    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.results).toHaveLength(3);
      expect(result.results[0]).toEqual(result.results[1]);
      expect(result.results[1]).toEqual(result.results[2]);
    }
    expect(mocks.fetchIcon).toHaveBeenCalledTimes(1);
  });

  test('reuses base64 encoding for duplicate byte payloads', async () => {
    const data = new Uint8Array([9, 8, 7]);
    mocks.fetchIcon.mockImplementation(async (iconPack: string, iconName: string) =>
      iconResult(iconPack, iconName, data),
    );

    await deliverIconBatch(
      [
        { iconPack: 'lucide', iconName: 'one', options: {} },
        { iconPack: 'lucide', iconName: 'two', options: {} },
      ],
      createContext(),
    );

    expect(mocks.bytesToBase64).toHaveBeenCalledTimes(1);
  });

  test('coalesces equivalent invalid requests without colliding unrelated requests', async () => {
    mocks.fetchIcon.mockImplementation(async (iconPack: string, iconName: string) => errorResult(iconPack, iconName));

    const result = await deliverIconBatch(
      [
        { iconPack: 'unknown', iconName: 'same', options: {} },
        { iconPack: 'unknown', iconName: 'same', options: {} },
        { iconPack: 'unknown', iconName: 'other', options: {} },
      ],
      createContext(),
    );

    expect(result.kind).toBe('success');
    if (result.kind === 'success')
      expect(result.results.map(({ iconName }) => iconName)).toEqual(['same', 'same', 'other']);
    expect(mocks.fetchIcon).toHaveBeenCalledTimes(2);
  });

  test('returns errors from fetchIcon as per-item results', async () => {
    mocks.fetchIcon.mockResolvedValue(errorResult('lucide', 'broken'));

    const result = await deliverIconBatch([{ iconPack: 'lucide', iconName: 'broken', options: {} }], createContext());

    expect(result).toEqual({
      kind: 'success',
      results: [{ iconPack: 'lucide', iconName: 'broken', status: 502, error: 'Unable to generate icon' }],
    });
  });

  test('rejects invalid items and enforces the batch size boundary', async () => {
    await expect(
      deliverIconBatch([{ iconPack: 'lucide', iconName: 'check', options: { size: 64 } }], createContext()),
    ).resolves.toEqual({
      kind: 'invalid',
      error: 'Each icon must include string iconPack, iconName, and options fields',
    });
    mocks.fetchIcon.mockResolvedValue(iconResult('lucide', 'check'));
    await expect(
      deliverIconBatch(
        Array.from({ length: MAX_ICON_BATCH_SIZE }, () => ({ iconPack: 'lucide', iconName: 'check', options: {} })),
        createContext(),
      ),
    ).resolves.toEqual({ kind: 'success', results: expect.any(Array) });
    await expect(
      deliverIconBatch(
        Array.from({ length: MAX_ICON_BATCH_SIZE + 1 }, () => ({ iconPack: 'lucide', iconName: 'check', options: {} })),
        createContext(),
      ),
    ).resolves.toEqual({ kind: 'invalid', error: 'A maximum of 50 icons is allowed' });
  });
});
