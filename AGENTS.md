# AGENTS.md

## Static prefix

Keep this section and all content above any task-specific additions byte-for-byte identical across agent runs when possible. Put dynamic task context after the static repository instructions to improve prompt-cache reuse.

## Project overview

TypeScript Cloudflare Worker for Rayfield Gen2 asset and icon delivery. It validates requests, proxies Roblox asset delivery, applies layered caching and bounded upstream coordination, renders supported icon packs to PNG, and exposes the public API through Hono.

## Project structure

- `src/worker/` — Worker composition, global middleware, health/root routes, and error handling.
- `src/http/` — Hono context, middleware, `/v1` route registration, request parsing, and HTTP responses.
- `src/assets/` — asset identity, delivery, caching, batching, upstream resolution, and asset-specific rate limiting.
- `src/icons/` — icon configuration, providers, rendering, caching, delivery, and batching.
- `src/durable-objects/` — asset coordination, single-flight behavior, cooldowns, retries, and permit scheduling.
- `src/observability/` — logging, tracing, report-level policy, and metrics.
- `src/shared/` and `src/infrastructure/` — cross-feature primitives and runtime adapters.
- `test/` — Vitest Worker tests.

`src/routes/`, `src/services/`, `src/middleware/`, `src/types/`, and `src/utils/` are compatibility or transitional surfaces. Put new feature logic in the owning module above unless compatibility requires otherwise.

## Baseline setup

- Node.js 24 and pnpm 11.
- Install: `pnpm install`
- Local Worker: `pnpm dev`
- Before reporting code complete: `pnpm typecheck && pnpm lint && pnpm coverage`
- After changing Cloudflare bindings: `pnpm cf-typegen`

## Top-level principles

- Read affected source and tests before editing. Keep patches narrow and preserve behavior unless the task requires a change.
- Keep HTTP adaptation in `src/http/`. Feature modules must not import Hono route handlers.
- Prefer feature-owned modules over legacy compatibility paths for new code.
- Keep TypeScript strict; do not introduce `any`. Let Biome format and organize imports.
- Preserve MPL-2.0 headers.
- Never commit credentials, tokens, private asset IDs, private fixtures, or production configuration.
- Never edit `worker-configuration.d.ts` manually; regenerate it with `pnpm cf-typegen`.
- Never run `pnpm deploy` unless explicitly requested.
- Update the documentation that owns any changed public or operational behavior.
- Broader Rayfield documentation belongs in `SiriusSoftwareLtd/docs`. <!-- user-specified -->

## Feature entry points

- Worker composition and global middleware: `src/worker/app.ts`
- Public API routing: `src/http/routes/registerRoutes.ts`
- Asset behavior: `src/assets/`
- Icon behavior: `src/icons/`
- Asset coordination/backpressure: `src/durable-objects/`
- Logging, tracing, and metrics: `src/observability/`

Public asset and icon routes are registered under `/v1`. `/health` and the root redirect remain outside the versioned API.

## Reference index

- [`README.md`](README.md) — read for setup, service overview, development commands, and deployment context.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — read before making a change; it owns validation, commit, PR, and contribution rules.
- [`docs/api.md`](docs/api.md) — read before changing routes, validation, batch behavior, caching, upstream behavior, or response contracts.
- [`docs/runtime-configuration.md`](docs/runtime-configuration.md) — read before changing bindings, variables, secrets, or runtime settings.
- [`docs/asset-rollout-flags.md`](docs/asset-rollout-flags.md) — read before changing asset resilience flags, rollout order, or fallbacks.
- [`docs/cd-secrets.md`](docs/cd-secrets.md) — read before changing deployment or GitHub environment requirements.
- [`SECURITY.md`](SECURITY.md) — read before changing security-sensitive behavior or handling vulnerability reports.

## Validation

Use focused tests while iterating. Before finishing any code change, run:

```sh
pnpm typecheck
pnpm lint
pnpm coverage
```

Do not lower coverage thresholds to make tests pass.
