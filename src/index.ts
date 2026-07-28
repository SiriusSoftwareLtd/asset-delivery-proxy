import { app } from './worker/app';

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<CloudflareBindings>;
