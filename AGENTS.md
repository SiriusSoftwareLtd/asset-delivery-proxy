# AGENTS.md

## Static prefix

Keep this section and all content above any task-specific additions byte-for-byte identical across agent runs when possible. Put dynamic task context after the static repository instructions to improve prompt-cache reuse.

## Repository

TypeScript Cloudflare Worker for Rayfield Gen2 asset and icon delivery.

Key paths:

- `src/routes/` — HTTP route handlers.
- `src/services/assets/` — Roblox delivery, caching, extension detection, coordinator client.
- `src/services/icons/` — icon validation, providers, fetching, rendering.
- `src/durable-objects/` — asset coordination and backpressure.
- `src/middleware/` — rate limiting and observability.
- `src/observability/` — asset metrics.
- `src/types/` — shared Worker/Hono types.
- `src/utils/` — shared helpers.
- `test/` — Vitest Worker tests.
- `scripts/verify-production.ts` — live production verification.
- `docs/api.md` — public HTTP contract.
- `docs/runtime-configuration.md` — bindings, vars, secrets.
- `docs/asset-rollout-flags.md` — feature-flag behavior.
- `docs/cd-secrets.md` — deployment requirements.
- `wrangler.jsonc` — Cloudflare configuration.
- `worker-configuration.d.ts` — generated; never edit manually.

## Toolchain

Use Node.js 24 and pnpm.

```sh
pnpm install
pnpm dev
pnpm test
pnpm coverage
pnpm typecheck
pnpm lint
pnpm format
pnpm cf-typegen
pnpm verify:production
```

Before reporting code complete:

```sh
pnpm typecheck
pnpm lint
pnpm coverage
```

Use focused tests while iterating:

```sh
pnpm test test/<file>.spec.ts
pnpm test test/<file>.spec.ts -t "<test name>"
```

Run `pnpm cf-typegen` after changing Cloudflare bindings.

Never run `pnpm deploy` unless explicitly requested.

## Change rules

- Read affected source and tests before editing.
- Keep patches narrow; avoid unrelated refactors or formatting churn.
- Preserve existing behavior unless the task requires a change.
- Do not overwrite unrelated user changes.
- Keep TypeScript strict; do not introduce `any`.
- Let Biome format and organize imports.
- Preserve MPL-2.0 headers.
- Never commit credentials, private asset IDs, tokens, or production secrets.
- Update the documentation that owns changed behavior.
- Do not lower coverage thresholds to make tests pass.

## Critical contracts

- Asset IDs: decimal strings, 1–20 digits.
- Asset routes require `X-Rayfield-Secure-Mode: true`.
- Asset batches: 1–25 items; preserve order and isolate item failures.
- Icon batches: 1–50 items; preserve order and isolate item failures.
- Batch concurrency stays bounded at 6 unless intentionally changed.
- Supported icon packs: `lucide`, `feather`, `remix`, `font-awesome`, `hero`, `rayfield`.
- Icon size: integer `1..1024`, default `64`.
- Handled responses use `X-Request-ID`.
- Only definitive asset `404`s may be negatively cached.
- Preserve finite upstream timeouts and `502` vs `504` semantics.
- Roblox v2 redirects must remain HTTPS and must not receive the Roblox API key.
- Representation-affecting forwarded inputs must vary the cache key.
- Respect `OBSERVABILITY_REPORT_LEVEL`; never log secrets.
- Avoid high-cardinality metric or trace dimensions.

## Asset rollout

Flags:

- `use-asset-delivery-v2`
- `asset-cache-hit-exempt-limit`
- `asset-cache-layered`
- `asset-upstream-coordinator`
- `asset-upstream-backpressure`

Flag evaluation must fail closed to the `false` path.

Resilience rollout order:

1. `asset-cache-hit-exempt-limit`
2. `asset-cache-layered`
3. `asset-upstream-coordinator`
4. `asset-upstream-backpressure`

Backpressure requires:

```text
asset-upstream-coordinator = true
ASSET_COORDINATOR_BUDGET_VERIFIED = true
```

Do not weaken this gate incidentally.

## Documentation ownership

- Public HTTP behavior → `docs/api.md`
- Bindings, vars, secrets → `docs/runtime-configuration.md`
- Asset flags and rollout → `docs/asset-rollout-flags.md`
- Deployment/CD → `docs/cd-secrets.md`
- Setup and repository overview → `README.md`
- Contribution workflow → `CONTRIBUTING.md`
- Security-sensitive reporting → `SECURITY.md`

Broader Rayfield documentation belongs in `SiriusSoftwareLtd/docs`.

## Subagents and critics

Use subagents only for bounded, independent work that would otherwise inflate orchestrator context.

Delegate with:

- A precise question or file scope.
- Only the minimum relevant context.
- A compact required result format.

Subagents return findings, evidence, and proposed changes—not reasoning transcripts or large source excerpts.

The orchestrator owns:

- Task decomposition.
- Cross-file decisions.
- Final implementation choices.
- Integration.
- Validation.
- User-facing output.

Use a critic only after a concrete draft, patch, or conclusion exists.

Critics return only:

- Blocking issues.
- Material correctness risks.
- Missing validation.
- Concise recommended fixes.

Do not recursively delegate or ask multiple agents to duplicate the same investigation.

## Commits and pull requests

Follow `CONTRIBUTING.md`.

Every Git commit message must follow Conventional Commits 1.0.0 and include exactly one Gitmoji in the subject.

Required format:

```text
<type>[optional scope][!]: <gitmoji> <description>
```

Examples:

```text
feat(worker): ✨ add icon URL resolver
fix(cache): 🐛 prevent stale entry corruption
docs(api): 📝 document batch response fields
refactor(assets)!: ♻️ replace legacy cache identity
```

Use `feat` for features and `fix` for bug fixes. Other valid types include:

- `build`
- `chore`
- `ci`
- `docs`
- `perf`
- `refactor`
- `revert`
- `style`
- `test`

Use a scope when it clarifies the affected subsystem.

Keep descriptions short, imperative, and lowercase.

For breaking changes, use `!` before the colon and/or a `BREAKING CHANGE:` footer:

```text
feat(api)!: 💥 change asset batch response shape

BREAKING CHANGE: asset batch results now use the new response schema.
```

Optional bodies and footers must also follow Conventional Commits 1.0.0.

Do not create commits that omit the Gitmoji or violate the Conventional Commits structure.
