import { app } from './worker/app';

export { AssetResolutionCoordinator } from './durable-objects/assetResolutionCoordinator';

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<CloudflareBindings>;
