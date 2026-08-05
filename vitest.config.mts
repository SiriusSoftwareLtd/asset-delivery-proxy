import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      remoteBindings: false,
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          ROBLOX_API_KEY: '',
          ENVIRONMENT: 'test',
          ASSET_COORDINATOR_PERMIT_INTERVAL_MS: '5',
          ASSET_COORDINATOR_RETRY_BASE_MS: '2',
        },
      },
    }),
  ],
  test: {
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'json', 'html'],
      thresholds: {
        perFile: true,
        lines: 95,
        functions: 90,
        branches: 90,
        statements: 90,
      },
      include: ['src/**/*.ts'],
      exclude: ['scripts/verify-production.ts', 'test/worker.ts'],
    },
  },
});
