import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            ROBLOX_API_KEY: '',
            ENVIRONMENT: 'test',
            ASSET_COORDINATOR_PERMIT_INTERVAL_MS: '5',
            ASSET_COORDINATOR_RETRY_BASE_MS: '2',
          },
        },
      },
    },
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
