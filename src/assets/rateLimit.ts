/*
 * Copyright (c) 2026 Corridon Capital
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { HTTPException } from 'hono/http-exception';
import type { AppContext } from '../http/context';

const RATE_LIMIT_CONTEXT_KEY = '.rateLimit';

function clientKey(c: AppContext): string {
  return c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? 'anonymous';
}

/**
 * Charges the client one limiter unit for one asset that missed every cache and is about to cost an
 * upstream fetch. It is called once per miss, not once per request: a batch of 25 cold IDs is 25
 * fetches from Roblox, and charging it as one let a single client multiply its upstream budget by
 * the batch size.
 */
export async function limitAssetMiss(c: AppContext): Promise<void> {
  const { success } = await c.env.ASSET_PROXY_RATE_LIMITER.limit({ key: clientKey(c) });
  c.set(RATE_LIMIT_CONTEXT_KEY, success);
  if (!success) throw new HTTPException(429, { res: new Response('Too Many Requests', { status: 429 }) });
}
