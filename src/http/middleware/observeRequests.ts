/*
 * Copyright (c) 2026 Corridon Capital
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createMiddleware } from 'hono/factory';
import { logEvent } from '../../observability/logging';
import type { AppEnvironment } from '../context';

export const observeRequests = createMiddleware<AppEnvironment>(async (c, next) => {
  const requestId = c.req.header('CF-Ray') ?? crypto.randomUUID();
  const startedAt = performance.now();
  c.set('requestId', requestId);
  c.set('cacheStatus', 'unknown');
  c.header('X-Request-ID', requestId);
  await next();
  logEvent(
    'info',
    'request.completed',
    {
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      cacheStatus: c.get('cacheStatus'),
      upstreamStatus: c.get('upstreamStatus'),
      durationMs: Number((performance.now() - startedAt).toFixed(2)),
    },
    c.env,
  );
});
