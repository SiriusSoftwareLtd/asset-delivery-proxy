/*
 * Copyright (c) 2026 Corridon Capital
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

const BASE64_CHUNK_SIZE = 0x8000;

export function bytesToBase64(data: Uint8Array<ArrayBuffer>): string {
  let binary = '';
  for (let offset = 0; offset < data.length; offset += BASE64_CHUNK_SIZE) {
    binary += String.fromCharCode(...data.subarray(offset, offset + BASE64_CHUNK_SIZE));
  }
  return btoa(binary);
}
