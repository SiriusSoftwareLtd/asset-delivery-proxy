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

export async function limitAssetMiss(c: AppContext): Promise<void> {
  let decision = c.get('assetMissLimit');
  if (!decision) {
    decision = c.env.ASSET_PROXY_RATE_LIMITER.limit({ key: clientKey(c) }).then(({ success }) => success);
    c.set('assetMissLimit', decision);
  }
  const success = await decision;
  c.set(RATE_LIMIT_CONTEXT_KEY, success);
  if (!success) throw new HTTPException(429, { res: new Response('Too Many Requests', { status: 429 }) });
}
