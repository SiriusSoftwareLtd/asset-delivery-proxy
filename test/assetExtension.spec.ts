/*
 * Copyright (c) 2026 Corridon Capital
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { describe, expect, test, vi } from 'vitest';
import {
  extensionFromContentType,
  extensionFromPrefix,
  readPrefixAndRestoreBody,
  resolveAssetExtension,
} from '../src/services/assets/extension';

const bytes = (...values: number[]) => new Uint8Array(values);

function createEot(): Uint8Array {
  const data = new Uint8Array(36);
  const view = new DataView(data.buffer);

  view.setUint32(0, 36, true);
  view.setUint32(4, 1, true);
  view.setUint32(8, 0x00010000, true);
  view.setUint16(34, 0x504c, true);

  return data;
}

function createTga(): Uint8Array {
  const data = new Uint8Array(18);

  data[1] = 0;
  data[2] = 2;
  data[12] = 1;
  data[13] = 0;
  data[14] = 1;
  data[15] = 0;
  data[16] = 24;

  return data;
}

describe('asset extension detection', () => {
  test('normalizes specific MIME types and ignores generic MIME types', () => {
    expect(extensionFromContentType(' Font/WOFF2 ; charset=utf-8 ')).toBe('.woff2');
    expect(extensionFromContentType('application/octet-stream')).toBeUndefined();
    expect(extensionFromContentType(null)).toBeUndefined();
  });

  test('detects required binary signatures', () => {
    expect(extensionFromPrefix(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe('.png');
    expect(extensionFromPrefix(bytes(0x4f, 0x54, 0x54, 0x4f))).toBe('.otf');
    expect(extensionFromPrefix(bytes(0x77, 0x4f, 0x46, 0x32))).toBe('.woff2');
    expect(extensionFromPrefix(bytes(0x49, 0x44, 0x33))).toBe('.mp3');
    expect(extensionFromPrefix(bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50))).toBe('.webp');
    expect(extensionFromPrefix(bytes(0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20))).toBe('.mov');
  });

  test('uses Roblox serialization and asset type to distinguish model/place formats', () => {
    expect(extensionFromPrefix(new TextEncoder().encode('  \ufeff \t\r\n<roblox'), 9)).toBe('.rbxlx');
    expect(extensionFromPrefix(new TextEncoder().encode('<roblox!'), 8)).toBe('.rbxm');
    expect(extensionFromPrefix(new TextEncoder().encode('version 1.00'))).toBe('.mesh');
  });

  test('restores consumed chunks and preserves the complete body', async () => {
    const original = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const resolved = await resolveAssetExtension(
      'application/octet-stream',
      new ReadableStream({
        start(controller) {
          controller.enqueue(original.subarray(0, 2));
          controller.enqueue(original.subarray(2));
          controller.close();
        },
      }),
    );

    expect(resolved.extension).toBe('.png');
    expect(new Uint8Array(await new Response(resolved.body).arrayBuffer())).toEqual(original);
  });

  test('cancels the upstream reader when the restored body is cancelled', async () => {
    const cancel = vi.fn();

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(512));
      },
      cancel,
    });

    const restored = await readPrefixAndRestoreBody(stream);

    expect(restored.body).not.toBeNull();

    if (!restored.body) {
      throw new Error('Expected restored body');
    }

    await restored.body.cancel('consumer stopped');

    expect(cancel).toHaveBeenCalledWith('consumer stopped');
  });

  test('detects additional supported font signatures', () => {
    expect(extensionFromPrefix(createEot())).toBe('.eot');
    expect(extensionFromPrefix(bytes(0x00, 0x01, 0x00, 0x00))).toBe('.ttf');
    expect(extensionFromPrefix(new TextEncoder().encode('ttcf'))).toBe('.ttc');
    expect(extensionFromPrefix(new TextEncoder().encode('wOFF'))).toBe('.woff');
    expect(extensionFromPrefix(new TextEncoder().encode('true'))).toBe('.ttf');
    expect(extensionFromPrefix(new TextEncoder().encode('typ1'))).toBe('.otf');
  });

  test('rejects malformed EOT signatures', () => {
    const badMagic = createEot();
    new DataView(badMagic.buffer).setUint16(34, 0, true);

    const badVersion = createEot();
    new DataView(badVersion.buffer).setUint32(8, 0x12345678, true);

    const missingFontData = createEot();
    new DataView(missingFontData.buffer).setUint32(4, 0, true);

    const fontDataLargerThanFile = createEot();
    new DataView(fontDataLargerThanFile.buffer).setUint32(4, 37, true);

    const oversized = createEot();
    new DataView(oversized.buffer).setUint32(0, 0x40000001, true);

    expect(extensionFromPrefix(new Uint8Array(35))).toBeUndefined();
    expect(extensionFromPrefix(badMagic)).toBeUndefined();
    expect(extensionFromPrefix(badVersion)).toBeUndefined();
    expect(extensionFromPrefix(missingFontData)).toBeUndefined();
    expect(extensionFromPrefix(fontDataLargerThanFile)).toBeUndefined();
    expect(extensionFromPrefix(oversized)).toBeUndefined();
  });

  test('detects additional image and audio signatures', () => {
    expect(extensionFromPrefix(bytes(0xff, 0xd8, 0xff))).toBe('.jpg');
    expect(extensionFromPrefix(new TextEncoder().encode('GIF87a'))).toBe('.gif');
    expect(extensionFromPrefix(new TextEncoder().encode('GIF89a'))).toBe('.gif');
    expect(extensionFromPrefix(new TextEncoder().encode('BM'))).toBe('.bmp');
    expect(extensionFromPrefix(new TextEncoder().encode('OggS'))).toBe('.ogg');
    expect(extensionFromPrefix(new TextEncoder().encode('fLaC'))).toBe('.flac');

    expect(extensionFromPrefix(bytes(0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45))).toBe(
      '.wav',
    );
  });

  test('detects a valid MPEG frame without an ID3 header', () => {
    expect(extensionFromPrefix(bytes(0xff, 0xfb, 0x90, 0x64))).toBe('.mp3');
  });

  test.each([
    ['too short', bytes(0xff, 0xfb, 0x90)],
    ['invalid sync', bytes(0xfe, 0xfb, 0x90, 0x64)],
    ['reserved MPEG version', bytes(0xff, 0xea, 0x90, 0x64)],
    ['invalid layer', bytes(0xff, 0xf9, 0x90, 0x64)],
    ['zero bitrate', bytes(0xff, 0xfb, 0x04, 0x64)],
    ['reserved bitrate', bytes(0xff, 0xfb, 0xf4, 0x64)],
    ['reserved sample rate', bytes(0xff, 0xfb, 0x9c, 0x64)],
  ])('rejects %s as an MPEG frame', (_label, data) => {
    expect(extensionFromPrefix(data)).toBeUndefined();
  });

  test('detects MP4 from an ISO base media brand', () => {
    expect(
      extensionFromPrefix(new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])),
    ).toBe('.mp4');
  });

  test('ignores unsupported ISO base media brands', () => {
    expect(
      extensionFromPrefix(new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x66, 0x74, 0x79, 0x70, 0x7a, 0x7a, 0x7a, 0x7a])),
    ).toBeUndefined();
  });

  test('detects valid TGA images', () => {
    expect(extensionFromPrefix(createTga())).toBe('.tga');
  });

  test('rejects malformed TGA headers', () => {
    const badColorMap = createTga();
    badColorMap[1] = 2;

    const badImageType = createTga();
    badImageType[2] = 1;

    const zeroWidth = createTga();
    zeroWidth[12] = 0;
    zeroWidth[13] = 0;

    const zeroHeight = createTga();
    zeroHeight[14] = 0;
    zeroHeight[15] = 0;

    const badDepth = createTga();
    badDepth[16] = 12;

    expect(extensionFromPrefix(new Uint8Array(17))).toBeUndefined();
    expect(extensionFromPrefix(badColorMap)).toBeUndefined();
    expect(extensionFromPrefix(badImageType)).toBeUndefined();
    expect(extensionFromPrefix(zeroWidth)).toBeUndefined();
    expect(extensionFromPrefix(zeroHeight)).toBeUndefined();
    expect(extensionFromPrefix(badDepth)).toBeUndefined();
  });

  test('does not assign a Roblox serialization extension without a model or place type', () => {
    expect(extensionFromPrefix(new TextEncoder().encode('<roblox'), 999)).toBeUndefined();
    expect(extensionFromPrefix(new TextEncoder().encode('<roblox!'))).toBeUndefined();
  });

  test('falls back to the Roblox asset type and binary extension', async () => {
    const place = await resolveAssetExtension(null, null, 9);
    const unknown = await resolveAssetExtension(null, null, 999);

    expect(place).toEqual({
      extension: '.rbxl',
      body: null,
    });

    expect(unknown).toEqual({
      extension: '.bin',
      body: null,
    });
  });

  test('limits the inspected prefix to 512 bytes without losing body data', async () => {
    const original = new Uint8Array(600);

    original.set(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a));

    for (let index = 8; index < original.length; index += 1) {
      original[index] = index % 256;
    }

    const restored = await readPrefixAndRestoreBody(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(original);
          controller.close();
        },
      }),
    );

    expect(restored.prefix).toHaveLength(512);

    const restoredData = new Uint8Array(await new Response(restored.body).arrayBuffer());

    expect(restoredData).toEqual(original);
  });

  test('preserves the upstream stream error while reading the prefix', async () => {
    const streamError = new Error('upstream stream failed');

    const stream = new ReadableStream<Uint8Array>({
      pull() {
        throw streamError;
      },
    });

    await expect(readPrefixAndRestoreBody(stream)).rejects.toBe(streamError);
  });

  test('continues reading the upstream body after replaying the sniffed prefix', async () => {
    let pullCount = 0;

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;

        if (pullCount === 1) {
          controller.enqueue(new Uint8Array(512).fill(1));
          return;
        }

        if (pullCount === 2) {
          controller.enqueue(bytes(2, 3, 4));
          controller.close();
        }
      },
    });

    const restored = await readPrefixAndRestoreBody(stream);

    const data = new Uint8Array(await new Response(restored.body).arrayBuffer());

    expect(data).toHaveLength(515);
    expect(data.subarray(0, 512)).toEqual(new Uint8Array(512).fill(1));
    expect(data.subarray(512)).toEqual(bytes(2, 3, 4));
  });

  test('propagates an upstream error after prefix sniffing has completed', async () => {
    const streamError = new Error('later upstream stream failure');
    let pullCount = 0;

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;

        if (pullCount === 1) {
          controller.enqueue(new Uint8Array(512).fill(1));
          return;
        }

        controller.error(streamError);
      },
    });

    const restored = await readPrefixAndRestoreBody(stream);

    if (!restored.body) {
      throw new Error('Expected restored body');
    }

    const reader = restored.body.getReader();

    const first = await reader.read();

    expect(first.done).toBe(false);
    expect(first.value).toEqual(new Uint8Array(512).fill(1));

    await expect(reader.read()).rejects.toBe(streamError);
  });
});
