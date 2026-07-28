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
