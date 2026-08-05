import { describe, expect, test, vi } from 'vitest';
import {
  buildRobloxV1Url,
  buildRobloxV2Request,
  fetchRobloxAsset,
  getFirstRobloxV2Discovery,
  isRetryableUpstreamStatus,
  parseRetryAfter,
  RobloxV2RejectedError,
} from '../src/services/assets/roblox';

describe('Roblox asset delivery helpers', () => {
  test('encodes asset IDs in v1 URLs', () => {
    expect(buildRobloxV1Url('123 456')).toContain('id=123%20456');
  });

  test('parses a future Retry-After HTTP date', () => {
    const now = Date.parse('2026-08-04T12:00:00Z');

    expect(parseRetryAfter('Tue, 04 Aug 2026 12:00:05 GMT', now)).toBe(5);
  });

  test('only forwards allowlisted v2 query parameters and headers', () => {
    const request = new Request('https://proxy.test/v1/assets/123?assetVersionId=5&unknown=drop', {
      headers: {
        'Roblox-Place-Id': '42',
        'X-Unknown': 'drop',
      },
    });

    const result = buildRobloxV2Request('123', request);
    const headers = new Headers(result.init.headers);

    expect(result.url).toContain('assetVersionId=5');
    expect(result.url).not.toContain('unknown=');

    expect(headers.get('Roblox-Place-Id')).toBe('42');
    expect(headers.get('X-Unknown')).toBeNull();

    expect(result.cacheKey).toContain('assetVersionId=5');
    expect(result.cacheKey).toContain('Roblox-Place-Id=42');
  });

  test('skips malformed and insecure discovery locations', () => {
    const result = getFirstRobloxV2Discovery({
      locations: [
        'not-a-url',
        { location: 'http://cdn.test/insecure' },
        { location: '' },
        { location: 'https://cdn.test/valid' },
      ],
      assetTypeId: 9,
    });

    expect(result).toEqual({
      location: 'https://cdn.test/valid',
      assetTypeId: 9,
    });
  });

  test('ignores a non-integer assetTypeId', () => {
    const result = getFirstRobloxV2Discovery({
      location: 'https://cdn.test/asset',
      assetTypeId: 9.5,
    });

    expect(result).toEqual({
      location: 'https://cdn.test/asset',
      assetTypeId: undefined,
    });
  });

  test.each([null, undefined, false, 123, 'not an object'])('rejects malformed discovery value %j', (value) => {
    expect(() => getFirstRobloxV2Discovery(value)).toThrow('Roblox v2 returned malformed JSON');
  });

  test('parses fractional Retry-After seconds by rounding up', () => {
    expect(parseRetryAfter('0.2')).toBe(1);
    expect(parseRetryAfter('1.01')).toBe(2);
  });

  test('rejects negative and expired Retry-After values', () => {
    const now = Date.parse('2026-08-04T12:00:00Z');

    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter('-1', now)).toBeUndefined();
    expect(parseRetryAfter('Tue, 04 Aug 2026 11:59:59 GMT', now)).toBeUndefined();
  });

  test('rewrites authenticated v1 requests to Open Cloud without forwarding the id query', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(null, {
          status: 404,
        }),
    );

    let cleanup: (() => Promise<void>) | undefined;

    try {
      const result = await fetchRobloxAsset(
        'v1',
        'https://assetdelivery.roblox.com/v1/asset/?id=123&foo=bar',
        {},
        'test-api-key',
        Date.now() + 10_000,
      );

      if (result.kind !== 'response') {
        throw new Error('Expected Roblox response result');
      }

      cleanup = result.cleanup;

      expect(result.response.status).toBe(404);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const call = fetchMock.mock.calls[0];

      if (!call) {
        throw new Error('Expected Roblox fetch');
      }

      const [input, init] = call;

      expect(String(input)).toBe('https://apis.roblox.com/asset-delivery-api/v1/assetId/123?foo=bar');

      const headers = new Headers(init?.headers);

      expect(headers.get('x-api-key')).toBe('test-api-key');
    } finally {
      await cleanup?.();
      fetchMock.mockRestore();
    }
  });

  test.each([
    ['missing rejection fields', {}],
    [
      'fractional code and empty message',
      {
        code: 401.5,
        message: '',
      },
    ],
  ])('uses fallback details for %s', (_label, rejection) => {
    let thrown: unknown;

    try {
      getFirstRobloxV2Discovery({
        errors: [rejection],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RobloxV2RejectedError);

    expect(thrown).toEqual(
      expect.objectContaining({
        message: 'Roblox rejected the asset request',
        upstreamCode: undefined,
      }),
    );
  });

  test.each([
    ['v1', 'https://assetdelivery.roblox.com/not-an-asset/?id=123'],
    ['v2', 'https://assetdelivery.roblox.com/v2/not-an-asset/123'],
  ] as const)('keeps the original authenticated %s URL when it cannot be rewritten', async (protocol, upstreamUrl) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, {
        status: 404,
      }),
    );

    let cleanup: (() => Promise<void>) | undefined;

    try {
      const result = await fetchRobloxAsset(protocol, upstreamUrl, {}, 'test-api-key', Date.now() + 10_000);

      if (result.kind !== 'response') {
        throw new Error('Expected Roblox response result');
      }

      cleanup = result.cleanup;

      expect(fetchMock).toHaveBeenCalledTimes(1);

      const call = fetchMock.mock.calls[0];

      if (!call) {
        throw new Error('Expected Roblox fetch');
      }

      expect(String(call[0])).toBe(upstreamUrl);

      expect(new Headers(call[1]?.headers).get('x-api-key')).toBe('test-api-key');
    } finally {
      await cleanup?.();
      fetchMock.mockRestore();
    }
  });

  test.each([
    [502, true],
    [503, true],
    [504, true],
    [500, false],
  ])('reports upstream status %i retryable=%s', (status, expected) => {
    expect(isRetryableUpstreamStatus(status)).toBe(expected);
  });

  test('accepts an authenticated v2 response without a Content-Type header as asset bytes', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));

    let cleanup: (() => Promise<void>) | undefined;

    try {
      const result = await fetchRobloxAsset(
        'v2',
        'https://assetdelivery.roblox.com/v2/assetId/123',
        {},
        'test-api-key',
        Date.now() + 10_000,
      );

      if (result.kind !== 'response') {
        throw new Error('Expected Roblox response result');
      }

      cleanup = result.cleanup;

      expect(result.response.status).toBe(200);
      expect(result.response.headers.get('Content-Type')).toBeNull();

      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await cleanup?.();
      fetchMock.mockRestore();
    }
  });

  test.each([
    {
      name: 'a timeout',
      failure: new DOMException('timed out', 'TimeoutError'),
      expectedStatus: 504,
      expectedError: 'Roblox asset delivery timed out',
    },
    {
      name: 'a network failure',
      failure: new Error('network unavailable'),
      expectedStatus: 502,
      expectedError: 'Unable to reach Roblox asset delivery',
    },
  ])('maps $name to the expected rejection', async ({ failure, expectedStatus, expectedError }) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(failure);

    try {
      const result = await fetchRobloxAsset('v1', buildRobloxV1Url('123'), {}, undefined, Date.now() + 10_000);

      expect(result).toEqual({
        kind: 'rejection',
        status: expectedStatus,
        error: expectedError,
        retryable: true,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
    }
  });
});
