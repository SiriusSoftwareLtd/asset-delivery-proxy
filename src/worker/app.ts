/*
 * Copyright (c) 2026 Corridon Capital
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { errorResponse } from '../http/responses';
import { getErrorFields, logEvent, observeRequests } from '../middleware/observability';
import { rateLimit } from '../middleware/rateLimiter';
import { registerRoutes } from '../routes';
import type { AppEnvironment } from '../types/app';

export const app = new Hono<AppEnvironment>();

app.use('*', observeRequests);

app.use('*', async (c, next) => {
  const isAssetRoute = c.req.path.startsWith('/assets/');
  if (isAssetRoute) {
    try {
      if (await c.env.FLAGS.getBooleanValue('asset-cache-hit-exempt-limit', false)) {
        c.set('assetLazyLimitEnabled', true);
        await next();
        return;
      }
    } catch (error) {
      logEvent(
        'warn',
        'asset.flag.evaluation_failed',
        { requestId: c.get('requestId'), flag: 'asset-cache-hit-exempt-limit', ...getErrorFields(error) },
        c.env,
      );
    }
  }

  c.set('assetLazyLimitEnabled', false);
  const rateLimiter = rateLimit(
    c.env.ASSET_PROXY_RATE_LIMITER,
    (context) => context.req.header('CF-Connecting-IP') ?? context.req.header('X-Forwarded-For') ?? 'anonymous',
  );

  return rateLimiter(c, next);
});

app.get('/health', (c) => c.text('OK', 200));

app.all('/', (c) => c.redirect('https://docs.sirius.menu/rayfield-gen2', 302));

app.route('/', registerRoutes());

/**
 * Logs uncaught errors once and returns a consistent public response.
 */
app.onError((error, c) => {
  const requestId = c.get('requestId');
  const status: ContentfulStatusCode = error instanceof HTTPException ? error.status : 500;

  logEvent(
    'error',
    'request.failed',
    {
      requestId,
      method: c.req.method,
      path: c.req.path,
      status,
      cacheStatus: c.get('cacheStatus'),
      upstreamStatus: c.get('upstreamStatus'),
      ...getErrorFields(error),
    },
    c.env,
  );

  return errorResponse(c, error instanceof HTTPException ? error.message : 'Internal server error', status);
});

app.notFound((c) => errorResponse(c, 'Not found', 404));
