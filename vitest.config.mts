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
        branches: 80,
        statements: 90,
      },
      include: ['src/**/*.ts'],
      exclude: ['scripts/verify-production.ts', 'test/worker.ts'],
    },
  },
});
