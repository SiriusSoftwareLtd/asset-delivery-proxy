import { describe, expect, test } from 'vitest';
import {
	extensionFromContentType,
	extensionFromPrefix,
	resolveAssetExtension,
} from '../src/assetExtension';

const bytes = (...values: number[]) => new Uint8Array(values);

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
		expect(extensionFromPrefix(new TextEncoder().encode('  \ufeff<roblox'), 9)).toBe('.rbxlx');
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
});
