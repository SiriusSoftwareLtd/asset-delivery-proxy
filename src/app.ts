import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { getErrorFields, logEvent, observeRequests } from './observability';
import { rateLimit } from './rateLimiter';
import { registerRoutes } from './routes';
import type { AppEnvironment } from './types';

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
  const status = error instanceof HTTPException ? error.status : 500;

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

  return c.json(
    {
      error: error instanceof HTTPException ? error.message : 'Internal server error',
      requestId,
    },
    status as ContentfulStatusCode,
  );
});

app.notFound((c) => {
  return c.json(
    {
      error: 'Not found',
      requestId: c.get('requestId'),
    },
    404,
  );
});
