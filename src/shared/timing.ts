/*
 * Copyright (c) 2026 Corridon Capital
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function sleepWithinDeadline(milliseconds: number, deadline: number): Promise<boolean> {
  const remainingMs = deadline - Date.now();

  if (remainingMs <= 0) {
    return false;
  }

  await sleep(Math.min(milliseconds, remainingMs));

  return Date.now() < deadline;
}

export function jitter(milliseconds: number): number {
  const bytes = crypto.getRandomValues(new Uint8Array(1));
  const random = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint8(0);

  return Math.floor(milliseconds * (0.5 + random / 255));
}
