/*
 * Copyright (c) 2026 Corridon Capital
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import type { AppContext } from '../types/app';

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

function clientRateLimitKey(c: AppContext): string {
  return c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? 'anonymous';
}

/** Applies the client limiter once, and only after an asset request has a true cache miss. */
export async function limitAssetMiss(c: AppContext): Promise<void> {
  let decision = c.get('assetMissLimit');
  if (!decision) {
    decision = c.env.ASSET_PROXY_RATE_LIMITER.limit({ key: clientRateLimitKey(c) }).then(({ success }) => success);
    c.set('assetMissLimit', decision);
  }

  const success = await decision;
  c.set(RATE_LIMIT_CONTEXT_KEY, success);
  if (!success) {
    throw new HTTPException(429, {
      res: new Response('Too Many Requests', { status: 429 }),
    });
  }
}
