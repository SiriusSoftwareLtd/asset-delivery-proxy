import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fetchWithTimeout } from '../../src/utils/fetch';

describe('fetchWithTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test('returns the fetch response when the request completes before the timeout', async () => {
    const response = new Response('ok', { status: 200 });
    let signal: AbortSignal | null | undefined;

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      signal = init?.signal;
      return response;
    });

    const result = await fetchWithTimeout(
      'https://example.com/asset',
      {
        headers: {
          Accept: 'application/octet-stream',
        },
      },
      10_000,
    );

    expect(result).toBe(response);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/asset',
      expect.objectContaining({
        headers: {
          Accept: 'application/octet-stream',
        },
        signal: expect.any(AbortSignal),
      }),
    );

    expect(signal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('aborts the fetch when the timeout expires', async () => {
    let signal: AbortSignal | null | undefined;

    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      signal = init?.signal;

      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => {
            reject(signal?.reason);
          },
          { once: true },
        );
      });
    });

    const request = fetchWithTimeout('https://example.com/asset', {}, 10_000);

    expect(signal?.aborted).toBe(false);

    // Attach the rejection handler before causing the timer to fire.
    const rejection = expect(request).rejects.toMatchObject({
      name: 'TimeoutError',
      message: 'The operation timed out',
    });

    await vi.advanceTimersByTimeAsync(10_000);

    await rejection;

    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('clears the timeout when fetch rejects before the timeout expires', async () => {
    const upstreamError = new TypeError('fetch failed');
    let signal: AbortSignal | null | undefined;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      signal = init?.signal;
      throw upstreamError;
    });

    await expect(fetchWithTimeout('https://example.com/asset', {}, 10_000)).rejects.toBe(upstreamError);

    expect(signal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(signal?.aborted).toBe(false);
  });

  test('forwards the supplied fetch options', async () => {
    const response = new Response('asset');
    const headers = new Headers({
      'x-api-key': 'test-key',
    });

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);

    await fetchWithTimeout(
      'https://apis.roblox.com/asset-delivery-api/v1/assetId/123',
      {
        method: 'GET',
        headers,
        redirect: 'follow',
      },
      10_000,
    );

    expect(fetchMock).toHaveBeenCalledWith('https://apis.roblox.com/asset-delivery-api/v1/assetId/123', {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: expect.any(AbortSignal),
    });

    expect(vi.getTimerCount()).toBe(0);
  });
});
