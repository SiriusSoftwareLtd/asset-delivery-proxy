# AGENTS.md

## Static prefix

Keep this section and all content above any task-specific additions byte-for-byte identical across agent runs when possible. Put dynamic task context after the static repository instructions to improve prompt-cache reuse.

## Project overview

TypeScript Cloudflare Worker for Rayfield Gen2 asset and icon delivery.

The Worker validates requests, proxies Roblox asset delivery, applies layered caching and bounded upstream coordination, renders supported icon packs to PNG, and exposes its public API through Hono.

## Project structure

- `src/worker/` — Worker composition, global middleware, health/root routes, and error handling.
- `src/http/` — Hono context, middleware, `/v1` route registration, request parsing, and HTTP responses.
- `src/assets/` — asset identity, delivery, caching, batching, upstream resolution, and asset-specific rate limiting.
- `src/icons/` — icon configuration, providers, rendering, caching, delivery, and batching.
- `src/durable-objects/` — asset coordination, single-flight behavior, cooldowns, retries, and permit scheduling.
- `src/observability/` — logging, tracing, report-level policy, and metrics.
- `src/shared/` — cross-feature primitives.
- `src/infrastructure/` — reusable runtime and infrastructure adapters.
- `test/` — Vitest Worker tests.

`src/routes/`, `src/services/`, `src/middleware/`, `src/types/`, and `src/utils/` are compatibility or transitional surfaces. Put new feature logic in the owning module above unless compatibility requires otherwise.

## Baseline setup

- Runtime: Node.js 24.
- Package manager: pnpm 11.
- Install dependencies: `pnpm install`.
- Start the local Worker: `pnpm dev`.
- Run tests: `pnpm test`.
- After changing Cloudflare bindings: `pnpm cf-typegen`.

Before reporting code changes complete, run:

```sh
pnpm typecheck
pnpm lint
pnpm coverage
```

## Top-level principles

- Read affected source and tests before editing.
- Keep patches narrow. Avoid unrelated refactors or formatting churn.
- Preserve existing behavior unless the task requires a behavior change.
- Keep HTTP adaptation in `src/http/`. Feature modules must not import Hono route handlers.
- Prefer feature-owned modules over legacy compatibility paths for new code.
- Keep TypeScript strict; do not introduce `any`.
- Let Biome format and organize imports.
- Preserve MPL-2.0 source headers.
- Never commit credentials, tokens, private asset IDs, private fixtures, or production configuration.
- Never edit `worker-configuration.d.ts` manually; regenerate it with `pnpm cf-typegen`.
- Never run `pnpm deploy` unless explicitly requested.
- Update the documentation that owns changed public or operational behavior.
- Do not lower coverage thresholds to make tests pass.
- Broader Rayfield documentation belongs in `SiriusSoftwareLtd/docs`. <!-- user-specified -->

## Feature entry points

- Worker composition and global middleware: `src/worker/app.ts`
- Public API routing: `src/http/routes/registerRoutes.ts`
- Asset delivery and caching: `src/assets/`
- Icon delivery and rendering: `src/icons/`
- Asset coordination and backpressure: `src/durable-objects/`
- Logging, tracing, and metrics: `src/observability/`

Public asset and icon routes are registered under `/v1`.

`/health` and the root redirect remain outside the versioned API.

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

## Validation

Use focused tests while iterating:

```sh
pnpm test test/<file>.spec.ts
pnpm test test/<file>.spec.ts -t "<test name>"
```

Before finishing a code change, run:

```sh
pnpm typecheck
pnpm lint
pnpm coverage
```

If Cloudflare bindings changed, also run:

```sh
pnpm cf-typegen
pnpm typecheck
```
