# AGENTS.md

This file gives coding agents the repository-specific context needed to make safe, focused changes. Follow these
instructions for all work in this repository unless the user explicitly asks for a different direction.

## Operating principles

- Start by reading the relevant source and tests before editing. Let local patterns win over generic preferences.
- Keep changes narrow and behavior-preserving unless the task explicitly asks for a behavior change.
- Do not revert or overwrite user changes. If the worktree is dirty, work around unrelated edits and call out only
  conflicts that affect the task.
- Prefer small, reviewable patches. Avoid drive-by refactors, dependency swaps, formatting churn, or config churn.
- Update tests and documentation in the same change when public behavior, bindings, headers, status codes, or operational
  requirements change.
- Never log, print, commit, or document credentials, tokens, private headers, or private Cloudflare resource details beyond
  the existing checked-in configuration.

## Project overview

`asset-delivery-proxy` is a TypeScript Cloudflare Worker for Rayfield. It uses Hono to proxy Roblox assets and rendered
provider icons, Cloudflare KV to cache successful and not-found responses, a Cloudflare Rate Limiting binding for asset
delivery, and Cloudflare Flagship to gate Roblox Asset Delivery v2.

Public routes:

- `GET /assets/:assetId` - validated and rate-limited Roblox asset delivery.
- `POST /assets/batch` - ordered asset batch delivery with per-item results.
- `GET /icons/:iconPack/:iconName` - rendered PNG icons from supported providers.
- `POST /icon/batch` - ordered icon batch rendering with per-item results.

The runtime entry point is `src/index.ts`. `src/worker/app.ts` assembles middleware, routes, error handling, and not-found
responses. `src/routes/index.ts` registers the public routes.

## Repository map

- `src/routes/assetDelivery.ts` - single and batch asset request handling.
- `src/routes/icons.ts` - single and batch icon request handling.
- `src/services/assets/delivery.ts` - asset validation, secure-mode enforcement, cache flow, upstream requests, and
  response metadata.
- `src/services/assets/roblox.ts` - Roblox v1/v2 request construction and v2 discovery parsing.
- `src/services/assets/extension.ts` - content-type and byte-signature based asset extension detection.
- `src/services/icons/config.ts` - icon provider, option, and size validation.
- `src/services/icons/generator.ts` - SVG provider fetching, validation, and PNG rendering.
- `src/middleware/rateLimiter.ts` - Hono rate-limiting middleware.
- `src/middleware/observability.ts` - request IDs, structured logs, report levels, and custom trace spans.
- `src/http/responses.ts` - shared JSON error response helpers.
- `src/utils/batch.ts` - bounded-concurrency batch mapping and byte/base64 helpers.
- `src/types/app.ts` - Hono environment, context variables, cache metadata, and cache-status types.
- `test/` - Vitest tests running in the Cloudflare Workers pool.
- `wrangler.jsonc` - Worker runtime settings and Cloudflare bindings.
- `worker-configuration.d.ts` - generated Cloudflare binding types.

## Toolchain and commands

Use Node.js 20 or later and pnpm. Do not substitute npm or yarn, and do not hand-edit `pnpm-lock.yaml`.

```sh
pnpm install
pnpm dev
pnpm start
pnpm typecheck
pnpm lint
pnpm format
pnpm test
pnpm test test/index.spec.ts
pnpm test test/index.spec.ts -t "flag evaluation failure"
pnpm cf-typegen
pnpm deploy
```

- There is no standalone build script. `pnpm typecheck` is the compile-time validation command; `pnpm deploy` performs the
  Wrangler production build and deploy, so run it only when the user explicitly requests deployment.
- `pnpm test` runs the bounded Vitest suite once. Use `pnpm test test/<file>.spec.ts` for one file and append
  `-t "<test name>"` for one matching test.
- `pnpm typecheck` checks both source and test TypeScript projects.
- `pnpm lint` runs `biome check .` (lint, formatting, and import organization); `pnpm format` checks formatting only.
- `pnpm lint:fix` and `pnpm format:fix` modify files. Inspect their changes before keeping them.
- Run `pnpm cf-typegen` after changing bindings in `wrangler.jsonc`, and include the generated
  `worker-configuration.d.ts` update.

Before reporting a source change complete, run:

```sh
pnpm typecheck
pnpm lint
pnpm test
```

Run the narrowest relevant test during iteration, but finish with the full suite. If a gate fails or cannot run, do not
claim completion without reporting the exact command and reason. Documentation-only changes may skip source gates when they
cannot exercise the changed files; state that explicitly.

## Current documentation requirements

Cloudflare APIs and limits change frequently. Before a Cloudflare-specific change, retrieve current official documentation
through Context7 and `https://developers.cloudflare.com/`; use each product's `/platform/limits/` page for quotas. For
Wrangler fields, also inspect `node_modules/wrangler/config-schema.json`; for runtime APIs, prefer generated and installed
types. Consult product-specific best practices before introducing Durable Objects, Workflows, Queues, R2, D1, or similar
services.

## Coding conventions

- Keep TypeScript strict and compatible with the Workers runtime.
- Do not introduce Node-only APIs without verifying `nodejs_compat` support and Workers runtime behavior.
- Let Biome organize imports. Keep external imports before relative imports, use `import type` or inline `type` specifiers for
  type-only dependencies, and do not add barrel files unless they match an existing module boundary.
- Follow Biome formatting: spaces, single quotes (including JSX), trailing commas where emitted, and a 120-character line
  width. Do not hand-format around Biome.
- Prefer inferred local types. Use `type` aliases for object shapes and discriminated unions; use `satisfies` to validate
  object literals without widening them. Keep shared Worker/Hono types in `src/types/` and feature-local request/result
  types beside the owning module. Do not use `any`; narrow `unknown` at input and error boundaries.
- Use `camelCase` for variables/functions, `PascalCase` for types/classes, and `UPPER_SNAKE_CASE` for module constants.
  Name route handlers `handle...`, boolean predicates `is...`/`should...`, and parsing/building helpers `parse...`/`build...`.
- Preserve the existing Hono environment and context types instead of casting around binding or context errors.
- Prefer named helpers for logic that needs independent tests; avoid abstractions that only hide one call site.
- Use structured APIs for URLs, headers, JSON, and binary data instead of ad hoc string manipulation.
- Keep comments sparse and operationally useful. Explain non-obvious cache, security, tracing, or compatibility reasoning.
- Keep generated files generated. Do not manually edit `worker-configuration.d.ts`.

## Behavioral invariants

Treat these as part of the public and operational contract unless the task explicitly changes them:

- Asset IDs are decimal strings of 1-20 digits.
- Asset requests require `X-Rayfield-Secure-Mode: true`, including `POST /assets/batch`.
- Single asset delivery is rate limited before contacting Roblox. Preserve the established rate-limit behavior and response
  shape.
- Every handled response gets an `X-Request-ID`; error JSON contains `error` and `requestId`.
- Successful asset responses preserve the upstream content type and include cache headers.
- Asset extension detection must not consume or alter the returned response body.
- Cache values contain raw bytes; small JSON-serializable fields belong in typed KV metadata.
- Only definitive upstream `404` asset responses are negatively cached, currently for five minutes.
- Rate limits, permission errors, timeouts, malformed discovery responses, icon generation failures, and upstream 5xx
  responses must not be negatively cached.
- Cache read/write/delete failures should degrade gracefully when delivery can still proceed.
- Corrupt cache entries are discarded and refetched.
- The v2 feature flag must fail closed to the established v1 path.
- Roblox v2 forwards only allowlisted query parameters and headers, and every forwarded input that affects output must vary
  the cache key.
- Followed v2 locations must remain valid HTTPS URLs.
- Outbound Roblox and icon-provider requests use finite timeouts; preserve the distinction between gateway failure (`502`)
  and timeout (`504`).
- Batch responses preserve input order, isolate per-item failures, and keep bounded concurrency at six unless deliberately
  changed.
- Asset batches accept 1-25 asset IDs. Icon batches accept 1-50 icon requests.
- Icon responses are PNG bytes with `Content-Type: image/png`, cache headers, `X-Icon-Pack`, and request/cache metadata.
- Supported icon packs are `lucide`, `feather`, `remix`, `font-awesome`, and `hero`.
- Icon `size` is an integer from 1 to 1024. Provider-specific options must remain allowlisted and validated.
- Avoid high-cardinality trace attributes such as raw asset IDs and icon names. Structured logs may contain operationally
  necessary identifiers.
- Custom logging and tracing respect `OBSERVABILITY_REPORT_LEVEL`; do not add unconditional application logs.

When changing response behavior, update `README.md` if the public API, headers, status codes, bindings, or operational
requirements change.

## Testing guidance

Tests use Vitest with `@cloudflare/vitest-pool-workers` and bindings declared in `wrangler.jsonc`.

- Put deterministic tests in `test/*.spec.ts`; use `cloudflare:test` and exercise route behavior through the exported
  Worker's `fetch` handler.
- Mock `globalThis.fetch`, KV, Flagship, and rate limiting; restore spies locally. Never call real providers or Cloudflare
  services.
- Assert status, body, and headers. Cover relevant validation, cache keys and hit/miss/corruption paths, upstream calls and
  failures, timeouts, v1/v2 routing, batch ordering/concurrency/duplicates, and icon options.
- For streamed bodies or signature inspection, prove the returned body remains unchanged.

## Configuration and security

- `wrangler.jsonc` contains account-specific resource identifiers. Do not replace them incidentally or copy them into
  examples outside the configuration.
- Store sensitive runtime values with Wrangler secrets, never plain `vars`.
- Treat changes to compatibility dates, compatibility flags, bindings, cache keys, rate-limit settings, observability
  settings, and source-map upload settings as operational changes requiring focused verification.
- Preserve secure-mode validation, input allowlists, HTTPS validation, finite timeout handling, and cache-key variance unless
  the task explicitly changes them and tests cover the new behavior.
- Keep request forwarding minimal. Forward only the headers and query parameters needed for the intended upstream behavior.
- Follow `SECURITY.md` for vulnerability reports; do not expose suspected vulnerabilities in public issues or generated docs.

## Commits and pull requests

Follow `Contributors.md`:

- Keep pull requests focused and explain the user-visible effect and verification performed.
- Use Conventional Commits with a Gitmoji in the subject:

```text
type(scope): gitmoji short imperative summary
```

Examples of suitable types include `feat`, `fix`, `docs`, `test`, `refactor`, `build`, and `chore`. Include a scope when it
makes the affected area clearer.
