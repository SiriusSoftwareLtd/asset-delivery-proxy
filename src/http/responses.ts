import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppContext } from '../types/app';

export function errorResponse(c: AppContext, error: string, status: ContentfulStatusCode): Response {
  return c.json({ error, requestId: c.get('requestId') }, status);
}
