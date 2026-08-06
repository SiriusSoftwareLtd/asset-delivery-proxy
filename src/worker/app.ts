/*
 * Copyright (c) 2026 Corridon Capital
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { getAssetPolicy } from '../assets/policy';
import type { AppEnvironment } from '../http/context';
import { observeRequests } from '../http/middleware/observeRequests';
import type { RateLimitBinding } from '../http/middleware/rateLimit';
import { rateLimit } from '../http/middleware/rateLimit';
import { errorResponse } from '../http/responses';
import { registerRoutes } from '../http/routes/registerRoutes';
import { getErrorFields, logEvent } from '../observability/logging';

export const app = new Hono<AppEnvironment>();

const rateLimitMiddlewareByBinding = new WeakMap<object, MiddlewareHandler<AppEnvironment>>();

function getRateLimitMiddleware(binding: RateLimitBinding): MiddlewareHandler<AppEnvironment> {
  const existing = rateLimitMiddlewareByBinding.get(binding);
  if (existing) return existing;

  const middleware = rateLimit(
    binding,
    (context) => context.req.header('CF-Connecting-IP') ?? context.req.header('X-Forwarded-For') ?? 'anonymous',
  );
  rateLimitMiddlewareByBinding.set(binding, middleware);
  return middleware;
}

app.use('*', observeRequests);

app.use('*', async (c, next) => {
  const isAssetRoute = c.req.path.startsWith('/v1/assets/');

  if (isAssetRoute && (await getAssetPolicy(c).cacheHitExemptLimit())) {
    c.set('assetLazyLimitEnabled', true);
    await next();
    return;
  }

  c.set('assetLazyLimitEnabled', false);
  return getRateLimitMiddleware(c.env.ASSET_PROXY_RATE_LIMITER)(c, next);
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
