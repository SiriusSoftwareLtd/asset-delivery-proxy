import { describe, expect, test } from 'vitest';
import { assetResultToBatchItem } from '../../src/assets/batch';

describe('asset batch results', () => {
  test('omits the extension when asset type detection did not produce one', () => {
    const result = assetResultToBatchItem({
      assetId: '123456',
      kind: 'asset',
      status: 200,
      data: new Uint8Array([1, 2, 3]),
      contentType: 'application/octet-stream',
      extension: undefined,
      cacheStatus: 'miss',
      cacheHit: false,
      timestamp: 1_000,
    });

    expect(result).toEqual({
      assetId: '123456',
      status: 200,
      contentType: 'application/octet-stream',
      cacheStatus: 'miss',
      cacheHit: false,
      dataBase64: 'AQID',
    });

    expect(result).not.toHaveProperty('extension');
  });
});
