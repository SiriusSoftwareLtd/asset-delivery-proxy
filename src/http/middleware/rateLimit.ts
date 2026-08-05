/*
 * Copyright (c) 2026 Corridon Capital
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';

export type RateLimitBinding = RateLimit;
export type RateLimitKeyFunc = (c: Context) => string | Promise<string>;
const RATE_LIMIT_CONTEXT_KEY = '.rateLimit';

export const rateLimit = (binding: RateLimitBinding, keyFunc: RateLimitKeyFunc) =>
  createMiddleware(async (c, next) => {
    const key = await keyFunc(c);
    if (!key) {
      console.warn('Rate limiting key is empty, skipping rate limiting.');
      await next();
      return;
    }
    const { success } = await binding.limit({ key });
    c.set(RATE_LIMIT_CONTEXT_KEY, success);
    if (!success) throw new HTTPException(429, { res: new Response('Too Many Requests', { status: 429 }) });
    await next();
  });

export const rateLimitPassed = (c: Context): boolean | undefined => c.get(RATE_LIMIT_CONTEXT_KEY);
