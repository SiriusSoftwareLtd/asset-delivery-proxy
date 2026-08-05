/*
 * Copyright (c) 2026 Corridon Capital
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { env } from 'cloudflare:test';
import { describe, expect, test } from 'vitest';
import worker from './worker';

function createTestEnv(options: { rateLimit?: () => Promise<{ success: boolean }> } = {}): CloudflareBindings {
  return {
    ...env,
    ASSET_PROXY_RATE_LIMITER: {
      limit: options.rateLimit ?? (async () => ({ success: true })),
    },
  } as unknown as CloudflareBindings;
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://proxy.test${path}`, init);
}

describe('worker', () => {
  test('health endpoint returns OK', async () => {
    const response = await worker.fetch(request('/health'), createTestEnv());

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('OK');
  });

  test('root redirects to the Rayfield Gen 2 documentation', async () => {
    const response = await worker.fetch(request('/'), createTestEnv());

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('https://docs.sirius.menu/rayfield-gen2');
  });

  test('unknown routes return 404', async () => {
    const response = await worker.fetch(request('/not-a-real-route'), createTestEnv());

    expect(response.status).toBe(404);

    const body = (await response.json()) as {
      error: string;
      requestId?: string;
    };

    expect(body.error).toBe('Not found');
  });

  test('global rate limiting can reject a request', async () => {
    const response = await worker.fetch(
      request('/health'),
      createTestEnv({
        rateLimit: async () => ({ success: false }),
      }),
    );

    expect(response.status).toBe(429);
  });
});
