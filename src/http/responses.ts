/*
 * Copyright (c) 2026 Corridon Capital
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppContext } from './context';

export function errorResponse(c: AppContext, error: string, status: ContentfulStatusCode): Response {
  return c.json({ error, requestId: c.get('requestId') }, status);
}
