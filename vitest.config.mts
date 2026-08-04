import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.jsonc' },
      },
		},
		coverage: {
			provider: 'istanbul',
			reporter: ['text', 'json', 'html'],
			thresholds: {
		    lines: 70,
		    functions: 70,
		    branches: 70,
		    statements: 70,
			},
			exclude: ["./scripts/verify-production.ts"]
		}
  },
});
