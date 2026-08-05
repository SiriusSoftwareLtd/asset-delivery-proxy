/*
 * Copyright (c) 2026 Corridon Capital
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fetchWithTimeout } from '../../src/infrastructure/http/fetchWithTimeout';

describe('fetchWithTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test('keeps the timeout active until cleanup is called', async () => {
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

    expect(result.response).toBe(response);
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
    expect(vi.getTimerCount()).toBe(1);

    await result.cleanup();

    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(signal?.aborted).toBe(false);
  });

  test('cleanup cancels an unread response body', async () => {
    let cancelled = false;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      );
    });

    const result = await fetchWithTimeout('https://example.com/asset', {}, 10_000);

    expect(result.response.bodyUsed).toBe(false);
    expect(vi.getTimerCount()).toBe(1);

    await result.cleanup();

    expect(cancelled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('aborts the fetch when the timeout expires before a response is returned', async () => {
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

    const result = await fetchWithTimeout(
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

    expect(vi.getTimerCount()).toBe(1);

    await result.cleanup();

    expect(vi.getTimerCount()).toBe(0);
  });

  test('keeps the timeout active while the response body is streaming', async () => {
    let signal: AbortSignal | null | undefined;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      signal = init?.signal;

      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));

          signal?.addEventListener(
            'abort',
            () => {
              controller.error(signal?.reason);
            },
            { once: true },
          );
        },
      });

      return new Response(body);
    });

    const result = await fetchWithTimeout('https://example.com/asset', {}, 10_000);

    expect(signal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(1);

    const bodyRead = result.response.arrayBuffer();

    const rejection = expect(bodyRead).rejects.toMatchObject({
      name: 'TimeoutError',
      message: 'The operation timed out',
    });

    await vi.advanceTimersByTimeAsync(10_000);

    await rejection;

    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    await result.cleanup();

    expect(vi.getTimerCount()).toBe(0);
  });

  test('cleanup is idempotent', async () => {
    const response = new Response('ok');
    let signal: AbortSignal | null | undefined;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      signal = init?.signal;
      return response;
    });

    const result = await fetchWithTimeout('https://example.com/asset', {}, 10_000);

    expect(vi.getTimerCount()).toBe(1);

    await result.cleanup();
    await result.cleanup();

    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(signal?.aborted).toBe(false);
  });
});
