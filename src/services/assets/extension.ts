/*
 * Copyright (c) 2026 Corridon Capital
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

const MAX_SNIFF_BYTES = 512;

const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  'application/font-sfnt': '.ttf',
  'application/lua': '.lua',
  'application/ogg': '.ogg',
  'application/vnd.ms-fontobject': '.eot',
  'application/x-font-opentype': '.otf',
  'application/x-font-ttc': '.ttc',
  'application/x-font-ttf': '.ttf',
  'application/x-font-woff': '.woff',
  'application/x-font-woff2': '.woff2',
  'audio/flac': '.flac',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'font/collection': '.ttc',
  'font/otf': '.otf',
  'font/sfnt': '.ttf',
  'font/ttf': '.ttf',
  'font/woff': '.woff',
  'font/woff2': '.woff2',
  'image/bmp': '.bmp',
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/tga': '.tga',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
};

const ROBLOX_ASSET_TYPE_EXTENSIONS: Readonly<Record<number, string>> = {
  1: '.png',
  3: '.ogg',
  4: '.mesh',
  5: '.lua',
  8: '.rbxm',
  9: '.rbxl',
  10: '.rbxm',
  11: '.rbxm',
  12: '.rbxm',
  13: '.png',
  38: '.rbxm',
};

const ISO_MP4_BRANDS = new Set(['isom', 'iso2', 'iso5', 'iso6', 'avc1', 'mp41', 'mp42', 'mp4v', 'M4V ']);

type SniffedRobloxFormat = 'roblox-binary' | 'roblox-xml';

export type RestoredBody = {
  prefix: Uint8Array;
  body: ReadableStream<Uint8Array> | null;
};

function asciiAt(bytes: Uint8Array, offset: number, value: string): boolean {
  if (offset + value.length > bytes.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

function isEot(bytes: Uint8Array): boolean {
  if (bytes.length < 36) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eotSize = view.getUint32(0, true);
  const fontDataSize = view.getUint32(4, true);
  const version = view.getUint32(8, true);
  const magicNumber = view.getUint16(34, true);
  return (
    magicNumber === 0x504c &&
    (version === 0x00010000 || version === 0x00020001 || version === 0x00020002) &&
    eotSize >= 36 &&
    fontDataSize >= 1 &&
    fontDataSize <= eotSize &&
    eotSize <= 0x40000000
  );
}

function isMpegFrame(bytes: Uint8Array): boolean {
  if (bytes.length < 4 || bytes[0] !== 0xff || (bytes[1] & 0xe0) !== 0xe0) return false;
  const version = (bytes[1] >> 3) & 0x03;
  const layer = (bytes[1] >> 1) & 0x03;
  const bitrate = (bytes[2] >> 4) & 0x0f;
  const sampleRate = (bytes[2] >> 2) & 0x03;
  return version !== 1 && layer !== 0 && bitrate !== 0 && bitrate !== 15 && sampleRate !== 3;
}

function isTga(bytes: Uint8Array): boolean {
  if (bytes.length < 18) return false;
  const colorMapType = bytes[1];
  const imageType = bytes[2];
  const width = bytes[12] | (bytes[13] << 8);
  const height = bytes[14] | (bytes[15] << 8);
  const pixelDepth = bytes[16];
  const validImageType = imageType === 2 || imageType === 3 || imageType === 10 || imageType === 11;
  const validDepth =
    pixelDepth === 8 || pixelDepth === 15 || pixelDepth === 16 || pixelDepth === 24 || pixelDepth === 32;
  return colorMapType <= 1 && validImageType && width > 0 && height > 0 && validDepth;
}

function isoBaseMediaExtension(bytes: Uint8Array): string | undefined {
  if (bytes.length < 12 || !asciiAt(bytes, 4, 'ftyp')) return undefined;
  if (asciiAt(bytes, 8, 'qt  ')) return '.mov';
  if (ISO_MP4_BRANDS.has(String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]))) return '.mp4';
  return undefined;
}

function robloxTextFormat(bytes: Uint8Array): SniffedRobloxFormat | undefined {
  let offset = 0;
  while (
    offset < bytes.length &&
    (bytes[offset] === 0x09 || bytes[offset] === 0x0a || bytes[offset] === 0x0d || bytes[offset] === 0x20)
  )
    offset += 1;
  if (bytes.length - offset >= 3 && bytes[offset] === 0xef && bytes[offset + 1] === 0xbb && bytes[offset + 2] === 0xbf)
    offset += 3;
  while (
    offset < bytes.length &&
    (bytes[offset] === 0x09 || bytes[offset] === 0x0a || bytes[offset] === 0x0d || bytes[offset] === 0x20)
  )
    offset += 1;
  if (asciiAt(bytes, offset, '<roblox!')) return 'roblox-binary';
  if (asciiAt(bytes, offset, '<roblox')) return 'roblox-xml';
  if (asciiAt(bytes, offset, 'version ')) return undefined;
  return undefined;
}

function detectMagicFormat(bytes: Uint8Array): string | SniffedRobloxFormat | undefined {
  if (isEot(bytes)) return '.eot';
  if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00)
    return '.ttf';
  if (bytes.length >= 8 && asciiAt(bytes, 0, '\x89PNG\r\n\x1a\n')) return '.png';
  if (asciiAt(bytes, 0, 'OTTO')) return '.otf';
  if (asciiAt(bytes, 0, 'ttcf')) return '.ttc';
  if (asciiAt(bytes, 0, 'wOFF')) return '.woff';
  if (asciiAt(bytes, 0, 'wOF2')) return '.woff2';
  if (asciiAt(bytes, 0, 'true')) return '.ttf';
  if (asciiAt(bytes, 0, 'typ1')) return '.otf';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return '.jpg';
  if (asciiAt(bytes, 0, 'GIF87a') || asciiAt(bytes, 0, 'GIF89a')) return '.gif';
  if (asciiAt(bytes, 0, 'BM')) return '.bmp';
  if (bytes.length >= 12 && asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WEBP')) return '.webp';
  if (asciiAt(bytes, 0, 'OggS')) return '.ogg';
  if (asciiAt(bytes, 0, 'fLaC')) return '.flac';
  if (bytes.length >= 12 && asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WAVE')) return '.wav';
  if (asciiAt(bytes, 0, 'ID3') || isMpegFrame(bytes)) return '.mp3';
  const isoExtension = isoBaseMediaExtension(bytes);
  if (isoExtension) return isoExtension;
  if (isTga(bytes)) return '.tga';
  const robloxFormat = robloxTextFormat(bytes);
  if (robloxFormat) return robloxFormat;
  return undefined;
}

function extensionForRobloxFormat(format: SniffedRobloxFormat, assetTypeId?: number): string | undefined {
  const isPlace = assetTypeId === 9;
  const isModel =
    assetTypeId === 8 || assetTypeId === 10 || assetTypeId === 11 || assetTypeId === 12 || assetTypeId === 38;
  if (!isPlace && !isModel) return undefined;
  return format === 'roblox-xml' ? (isPlace ? '.rbxlx' : '.rbxmx') : isPlace ? '.rbxl' : '.rbxm';
}

export function normalizeContentType(contentType: string | null): string | undefined {
  const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType || undefined;
}

export function extensionFromContentType(contentType: string | null): string | undefined {
  const mediaType = normalizeContentType(contentType);
  if (
    !mediaType ||
    mediaType === 'application/octet-stream' ||
    mediaType === 'binary/octet-stream' ||
    mediaType === 'application/binary'
  )
    return undefined;
  return MIME_EXTENSIONS[mediaType];
}

export function extensionFromPrefix(prefix: Uint8Array, assetTypeId?: number): string | undefined {
  const format = detectMagicFormat(prefix);
  if (format === 'roblox-binary' || format === 'roblox-xml') return extensionForRobloxFormat(format, assetTypeId);
  if (format) return format;
  if (prefix.length >= 9 && asciiAt(prefix, 0, 'version ')) return '.mesh';
  return undefined;
}

function extensionFromAssetType(assetTypeId?: number): string | undefined {
  return assetTypeId === undefined ? undefined : ROBLOX_ASSET_TYPE_EXTENSIONS[assetTypeId];
}

export async function readPrefixAndRestoreBody(body: ReadableStream<Uint8Array> | null): Promise<RestoredBody> {
  if (!body) return { prefix: new Uint8Array(0), body: null };
  const reader = body.getReader();
  const consumed: Uint8Array[] = [];
  const prefix = new Uint8Array(MAX_SNIFF_BYTES);
  let prefixLength = 0;
  let done = false;

  try {
    while (!done && prefixLength < MAX_SNIFF_BYTES) {
      const result = await reader.read();
      if (result.done) {
        done = true;
        break;
      }
      consumed.push(result.value);
      const amount = Math.min(result.value.byteLength, MAX_SNIFF_BYTES - prefixLength);
      prefix.set(result.value.subarray(0, amount), prefixLength);
      prefixLength += amount;
    }
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {
      // Preserve the upstream stream error if cancellation also fails.
    }
    reader.releaseLock();
    throw error;
  }

  const inspectedPrefix = prefix.subarray(0, prefixLength);
  let consumedIndex = 0;
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      reader.releaseLock();
    }
  };

  const restoredBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (consumedIndex < consumed.length) {
          controller.enqueue(consumed[consumedIndex]);
          consumedIndex += 1;
          return;
        }
        if (done) {
          controller.close();
          release();
          return;
        }
        const result = await reader.read();
        if (result.done) {
          done = true;
          controller.close();
          release();
        } else {
          controller.enqueue(result.value);
        }
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    },
  });

  return { prefix: inspectedPrefix, body: restoredBody };
}

export async function resolveAssetExtension(
  contentType: string | null,
  body: ReadableStream<Uint8Array> | null,
  assetTypeId?: number,
): Promise<{ extension: string; body: ReadableStream<Uint8Array> | null }> {
  const contentTypeExtension = extensionFromContentType(contentType);
  if (contentTypeExtension) return { extension: contentTypeExtension, body };
  const restored = await readPrefixAndRestoreBody(body);
  const extension = extensionFromPrefix(restored.prefix, assetTypeId) ?? extensionFromAssetType(assetTypeId) ?? '.bin';
  return { extension, body: restored.body };
}
