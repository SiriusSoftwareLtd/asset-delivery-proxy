/*
 * Copyright (c) 2026 Corridon Capital
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// =============================================================================
// Mock Rate Limiters (using factory functions for better serialization)
// =============================================================================

import { Hono, type MiddlewareHandler } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { type RateLimitBinding, rateLimit, rateLimitPassed } from '../../src/http/middleware/rateLimit';

// Creates a rate limiter that always allows requests
function createPassingRateLimiter(): RateLimitBinding {
  return {
    limit: async (_: { key: string }) => ({ success: true }),
  };
}

// Creates a rate limiter that always denies requests
function createFailingRateLimiter(): RateLimitBinding {
  return {
    limit: async (_: { key: string }) => ({ success: false }),
  };
}

describe('rateLimit middleware', () => {
  it('allows requests when rate limit is not exceeded', async () => {
    const app = new Hono();
    const rateLimiter: MiddlewareHandler = (c, next) => rateLimit(createPassingRateLimiter(), () => 'testKey')(c, next);

    app.use('/api/*', rateLimiter);
    app.get('/api/hello', (c) => c.text('Hello'));

    const res = await app.request('http://localhost/api/hello');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('Hello');
  });

  it('returns 429 when rate limit is exceeded', async () => {
    const app = new Hono();
    const rateLimiter: MiddlewareHandler = (c, next) => rateLimit(createFailingRateLimiter(), () => 'testKey')(c, next);

    app.use('/api/*', rateLimiter);
    app.get('/api/hello', (c) => c.text('Hello'));

    const res = await app.request('http://localhost/api/hello');
    expect(res.status).toBe(429);
    expect(await res.text()).toBe('Too Many Requests');
  });

  it('bypasses rate limiting when keyFunc returns empty string', async () => {
    const app = new Hono();
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const rateLimiter: MiddlewareHandler = (c, next) => rateLimit(createFailingRateLimiter(), () => '')(c, next);

    app.use('/api/*', rateLimiter);
    app.get('/api/hello', (c) => c.text('Hello'));

    const res = await app.request('http://localhost/api/hello');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('Hello');
    expect(consoleSpy).toHaveBeenCalledWith('Rate limiting key is empty, skipping rate limiting.');

    consoleSpy.mockRestore();
  });

  it('supports async keyFunc', async () => {
    const app = new Hono();
    const rateLimiter: MiddlewareHandler = (c, next) =>
      rateLimit(createPassingRateLimiter(), async () => {
        await Promise.resolve();
        return 'asyncKey';
      })(c, next);

    app.use('/api/*', rateLimiter);
    app.get('/api/hello', (c) => c.text('Hello'));

    const res = await app.request('http://localhost/api/hello');
    expect(res.status).toBe(200);
  });

  it('passes the correct key to the rate limiter', async () => {
    const app = new Hono();
    let capturedKey = '';

    const trackingLimiter: RateLimitBinding = {
      limit: async ({ key }) => {
        capturedKey = key;
        return { success: true };
      },
    };

    const rateLimiter: MiddlewareHandler = (c, next) =>
      rateLimit(trackingLimiter, (c) => c.req.header('X-API-Key') || 'anonymous')(c, next);

    app.use('/api/*', rateLimiter);
    app.get('/api/hello', (c) => c.text('Hello'));

    await app.request('http://localhost/api/hello', {
      headers: { 'X-API-Key': 'my-secret-key' },
    });
    expect(capturedKey).toBe('my-secret-key');
  });
});

describe('rateLimitPassed helper', () => {
  it('returns true when request passed rate limiting', async () => {
    const app = new Hono();
    let rateLimitStatus: boolean | undefined;

    const rateLimiter: MiddlewareHandler = (c, next) => rateLimit(createPassingRateLimiter(), () => 'testKey')(c, next);

    app.use('/api/*', rateLimiter);
    app.get('/api/hello', (c) => {
      rateLimitStatus = rateLimitPassed(c);
      return c.text('Hello');
    });

    await app.request('http://localhost/api/hello');
    expect(rateLimitStatus).toBe(true);
  });

  it('returns undefined when middleware was not applied', async () => {
    const app = new Hono();
    let rateLimitStatus: boolean | undefined;

    app.get('/api/hello', (c) => {
      rateLimitStatus = rateLimitPassed(c);
      return c.text('Hello');
    });

    await app.request('http://localhost/api/hello');
    expect(rateLimitStatus).toBeUndefined();
  });
});
