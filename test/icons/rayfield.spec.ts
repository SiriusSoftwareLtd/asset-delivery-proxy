/*
 * Copyright (c) 2026 Corridon Capital
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { describe, expect, test, vi } from 'vitest';
import { fetchRayfieldIcon } from '../../src/services/icons/rayfield';

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

describe('Rayfield icon delivery', () => {
  test('ignores a non-numeric upstream Content-Length', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(png, {
        headers: {
          'Content-Type': 'image/png',
          'Content-Length': 'unknown',
        },
      }),
    );

    try {
      const result = await fetchRayfieldIcon('125626312718314');

      expect(result).toEqual(png);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
    }
  });
});
