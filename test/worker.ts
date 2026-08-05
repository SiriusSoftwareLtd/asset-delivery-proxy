/*
 * Copyright (c) 2026 Corridon Capital
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

export default {
  async fetch(request: Request, bindings: CloudflareBindings): Promise<Response> {
    const context = createExecutionContext();
    const response = await worker.fetch(new IncomingRequest(request), bindings, context);
    await waitOnExecutionContext(context);
    return response;
  },
};
