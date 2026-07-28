import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';

const RATE_LIMIT_CONTEXT_KEY = '.rateLimit';

/**
 * Rate limiting binding as defined by Cloudflare Workers.
 * @see https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
 */
export type RateLimitBinding = RateLimit;

/**
 * Function that returns the key to rate limit on for a given request.
 * The key should represent a unique characteristic of a user or class of user.
 */
export type RateLimitKeyFunc = (c: Context) => string | Promise<string>;

export const rateLimit = (rateLimitBinding: RateLimitBinding, keyFunc: RateLimitKeyFunc) => {
  return createMiddleware(async (c, next) => {
    const key = await keyFunc(c);
    if (!key) {
      console.warn('Rate limiting key is empty, skipping rate limiting.');
      await next();
      return;
    }

    const { success } = await rateLimitBinding.limit({ key });
    c.set(RATE_LIMIT_CONTEXT_KEY, success);

    if (!success) {
      throw new HTTPException(429, {
        res: new Response('Too Many Requests', {
          status: 429,
        }),
      });
    }

    await next();
  });
};

/**
 * Check if the current request passed rate limiting.
 * Returns true if the request was allowed through, false if it was rate limited,
 * or undefined if the rate limiting middleware was not applied.
 */
export const rateLimitPassed = (c: Context): boolean | undefined => {
  return c.get(RATE_LIMIT_CONTEXT_KEY);
};
