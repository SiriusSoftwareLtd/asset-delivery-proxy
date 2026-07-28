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
  const rateLimiter = rateLimit(
    c.env.ASSET_PROXY_RATE_LIMITER,
    (context) => context.req.header('CF-Connecting-IP') ?? context.req.header('X-Forwarded-For') ?? 'anonymous',
  );

  return rateLimiter(c, next);
});

registerRoutes(app);

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
