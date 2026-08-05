# AGENTS.md

## Project overview

TypeScript Cloudflare Worker for Rayfield Gen2 asset and icon delivery.

The Worker validates requests, proxies Roblox asset delivery, applies layered caching and bounded upstream coordination, renders supported icon packs to PNG, and exposes its public API through Hono.

## Project structure

- `src/worker/` — Worker composition, global middleware, health/root routes, and error handling.
- `src/http/` — Hono context, middleware, `/v1` route registration, request parsing, and HTTP responses.
- `src/assets/` — asset-owned types, batch orchestration, and asset-specific rate limiting.
- `src/services/assets/` — asset cache access, delivery, extension detection, Roblox integration, and coordinator client logic.
- `src/icons/` — icon cache and delivery orchestration.
- `src/services/icons/` — icon configuration, providers, fetching, rendering, validation, and supporting types.
- `src/durable-objects/` — asset coordination, single-flight behavior, cooldowns, retries, and permit scheduling.
- `src/observability/` — logging, tracing, report-level policy, and metrics.
- `src/shared/` — cross-feature primitives.
- `src/infrastructure/` — reusable runtime and infrastructure adapters.
- `test/` — Vitest Worker tests.

## Baseline setup

- Runtime: Node.js 24.
- Package manager: pnpm 11.
- Install dependencies: `pnpm install`.
- Start the local Worker: `pnpm dev`.
- Run focused tests while iterating: `pnpm test test/<file>.spec.ts`.
- After changing Cloudflare bindings: `pnpm cf-typegen`.
- Before reporting code changes complete, run `pnpm typecheck`, `pnpm lint`, and `pnpm coverage`.

## Top-level principles

- Read affected source and tests before editing.
- Keep patches narrow; avoid unrelated refactors or formatting churn.
- Preserve existing behavior unless the task requires a behavior change.
- Keep HTTP adaptation in `src/http/`; feature and service modules must not import Hono route handlers.
- Keep TypeScript strict; do not introduce `any`.
- Preserve MPL-2.0 source headers.
- Never commit credentials, tokens, private asset IDs, private fixtures, or production configuration.
- Never edit `worker-configuration.d.ts` manually; regenerate it with `pnpm cf-typegen`.
- Never run `pnpm deploy` unless explicitly requested.
- Update the documentation that owns changed public or operational behavior, and do not lower coverage thresholds to make tests pass.
- Broader Rayfield documentation belongs in `SiriusSoftwareLtd/docs`. <!-- user-specified -->

## Feature entry points

- Worker composition and global middleware: `src/worker/app.ts`
- Public API routing: `src/http/routes/registerRoutes.ts`
- Asset HTTP handling: `src/http/routes/assets.ts`
- Asset feature logic: `src/assets/` and `src/services/assets/`
- Icon HTTP handling: `src/http/routes/icons.ts`
- Icon feature logic: `src/icons/` and `src/services/icons/`
- Asset coordination and backpressure: `src/durable-objects/`
- Logging, tracing, and metrics: `src/observability/`

Public asset and icon routes are registered under `/v1`. `/health` and the root redirect remain outside the versioned API.

## Git commits

Every Git commit must follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/) and include exactly one appropriate Gitmoji in the subject. <!-- user-specified -->

Required format: <!-- user-specified -->

```text
<type>[optional scope][!]: <gitmoji> <description>
```

Examples: <!-- user-specified -->

```text
feat(worker): ✨ add icon URL resolver
fix(cache): 🐛 prevent stale entry corruption
docs(api): 📝 document batch response fields
refactor(assets)!: ♻️ replace legacy cache identity
```

Commit rules: <!-- user-specified -->

- Use `feat` for a new feature.
- Use `fix` for a bug fix.
- Other valid types include `build`, `chore`, `ci`, `docs`, `perf`, `refactor`, `revert`, `style`, and `test`.
- Add a scope when it clarifies the affected subsystem.
- Include exactly one Gitmoji between the colon and description.
- Keep the description short, imperative, and lowercase.
- Do not end the subject with a period.
- Use `!` immediately before the colon when the commit introduces a breaking change.
- Breaking changes may also use a `BREAKING CHANGE:` footer.
- Separate an optional body from the subject with one blank line.
- Separate optional footers from the body with one blank line.
- Optional bodies and footers must also follow Conventional Commits 1.0.0.
- Do not create a commit that omits the Gitmoji or violates the Conventional Commits structure.

Breaking-change example:

```text
refactor(assets)!: ♻️ replace legacy cache identity

BREAKING CHANGE: asset cache keys now use the canonical v2 identity.
```

## Reference index

- [`README.md`](README.md) — read for setup, service overview, development commands, and deployment context.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — read before making a change; it owns contribution, pull request, and detailed workflow rules.
- [`docs/api.md`](docs/api.md) — read before changing routes, request validation, batch behavior, caching, upstream behavior, or response contracts.
- [`docs/runtime-configuration.md`](docs/runtime-configuration.md) — read before changing Cloudflare bindings, variables, secrets, or runtime settings.
- [`docs/asset-rollout-flags.md`](docs/asset-rollout-flags.md) — read before changing asset resilience flags, rollout dependencies, or fallback behavior.
- [`docs/cd-secrets.md`](docs/cd-secrets.md) — read before changing deployment or GitHub environment requirements.
- [`SECURITY.md`](SECURITY.md) — read before changing security-sensitive behavior or handling vulnerability reports.
