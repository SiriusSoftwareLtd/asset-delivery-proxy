# Asset Delivery Proxy

[![Gen2 Asset Proxy](https://www.sentivel.com/status/sirius/badge.svg?component=5357cc42-5ebe-4ddd-8a1d-909cca5fd39a)](https://status.sirius.menu)

A Cloudflare Worker that provides Rayfield Gen2 with a controlled asset and icon delivery layer.

The service validates asset requests, proxies Roblox asset delivery, applies layered caching and bounded upstream coordination, renders supported SVG icon packs to PNG, and serves Rayfield's registry-backed PNG icons.

## Features

- Proxies Roblox assets through controlled request paths.
- Supports single and batch asset requests.
- Serves icons from Lucide, Feather, Remix Icon, Font Awesome, Heroicons, and Rayfield.
- Renders supported SVG icon sources to PNG with `resvg`.
- Serves allowlisted Rayfield PNG assets without SVG rendering.
- Uses the Cache API and Workers KV for layered asset caching.
- Uses Cache API L1 caching for positive icon responses before the Workers KV L2 cache.
- Uses Durable Objects to coalesce and regulate upstream asset requests.
- Single-flights identical icon misses within an isolate and reuses duplicate batch work.
- Initializes the SVG renderer only when an uncached SVG icon needs rendering.
- Supports negative caching and stale-while-refresh asset delivery.
- Applies request validation, upstream timeouts, response-size limits, and rate limiting.
- Emits structured logs, request IDs, cache metadata, metrics, and tracing data.
- Supports controlled feature rollout through Cloudflare Flagship.

## Requirements

- Node.js 24
- pnpm
- A Cloudflare account for local remote bindings or deployment

## Getting started

Install dependencies:

```sh
pnpm install
```

Run the test suite:

```sh
pnpm test
```

Start Wrangler development mode with local observability enabled:

```sh
pnpm dev
```

The Worker uses the bindings declared in [`wrangler.jsonc`](./wrangler.jsonc).

Use resources from your own Cloudflare account when testing a fork or separate deployment. Do not commit credentials, private asset data, or production resource configuration.

## API

The Worker exposes endpoints for single and batch Roblox asset delivery, icon rendering, and health checks.

| Method | Endpoint                        | Description                              |
| ------ | ------------------------------- | ---------------------------------------- |
| `GET`  | `/health`                       | Check Worker health.                     |
| `GET`  | `/v1/assets/:assetId`           | Fetch a single Roblox asset.             |
| `POST` | `/v1/assets/batch`              | Fetch an ordered batch of Roblox assets. |
| `GET`  | `/v1/icons/:iconPack/:iconName` | Fetch a single icon as PNG.              |
| `POST` | `/v1/icons/batch`               | Fetch an ordered batch of icons.         |

Asset delivery requests require secure mode:

```http
X-Rayfield-Secure-Mode: true
```

See [`docs/api.md`](./docs/api.md) for the complete API contract, including:

- Request formats.
- Validation rules.
- Batch limits and semantics.
- Supported icon providers and options.
- Response headers.
- Error responses and status codes.
- Asset and icon caching behavior.
- Upstream safeguards.

## Configuration

Worker configuration lives in [`wrangler.jsonc`](./wrangler.jsonc).

Repository-local operational documentation covers configuration that must stay synchronized with the deployed Worker:

- [`docs/runtime-configuration.md`](./docs/runtime-configuration.md) — bindings, variables, secrets, and runtime configuration.
- [`docs/asset-rollout-flags.md`](./docs/asset-rollout-flags.md) — asset resilience and rollout flags.
- [`docs/cd-secrets.md`](./docs/cd-secrets.md) — production deployment credentials and GitHub environment requirements.
- [`docs/api.md`](./docs/api.md) — public HTTP API behavior.

### Secrets

Do not commit API keys, Cloudflare tokens, production credentials, or private verification fixtures.

Store the Roblox Open Cloud API key as a Wrangler secret:

```sh
pnpm exec wrangler secret put ROBLOX_API_KEY
```

### Cloudflare binding types

Regenerate Cloudflare binding types after changing `wrangler.jsonc`:

```sh
pnpm cf-typegen
```

Commit the resulting `worker-configuration.d.ts` update with the configuration change.

## Asset resilience

Asset delivery uses layered caching and optional upstream coordination.

The current resilience system includes:

- Cloudflare Cache API as a data-center-local L1 cache.
- Workers KV as the persistent asset cache.
- Fresh positive asset entries for 24 hours.
- Stale delivery with background refresh.
- Five-minute negative caching for supported `404` responses.
- Durable Object request coalescing.
- Optional upstream admission control and backpressure.
- Per-client rate limiting.
- Feature-flagged rollout of resilience paths.

Resilience behavior is controlled through:

- `asset-cache-layered`
- `asset-cache-hit-exempt-limit`
- `asset-upstream-coordinator`
- `asset-upstream-backpressure`
- `use-asset-delivery-v2`

See [`docs/asset-rollout-flags.md`](./docs/asset-rollout-flags.md) for the complete rollout model, dependencies, and fallback behavior.

## Deployment

Deploy the configured Worker with:

```sh
pnpm deploy
```

The CD workflow deploys from the `production` GitHub Actions environment after CI succeeds for a push to `main`.

Before deployment, the workflow verifies that the tested commit is still the current `main` head. It performs the check again immediately before deployment so an older completed CI run cannot overwrite a newer revision.

To prevent CD for a specific commit, place `[skip cd]` at the start or end of its commit message.

See [`docs/cd-secrets.md`](./docs/cd-secrets.md) for the required GitHub environment configuration and Cloudflare permissions.

## Production verification

The repository includes a live production verification script.

Create a local fixture file:

```sh
cp scripts/verify-production.assets.example.json scripts/verify-production.assets.json
```

Populate it with between 1 and 25 private Roblox asset fixtures.

Include at least one stable image asset and one stable font asset when possible so extension detection, byte comparison, cache behavior, and batch delivery are exercised across supported asset kinds.

Run the verifier with:

```sh
ASSET_PROXY_URL=https://<worker-hostname> \
ROBLOX_API_KEY=<roblox-open-cloud-key> \
pnpm verify:production
```

The verifier also loads `.env` automatically, so local operator settings can be stored there.

Do not commit:

- Real API keys.
- Private asset IDs.
- `scripts/verify-production.assets.json`.
- Generated verification output.

`pnpm verify:production` checks:

- `/health`.
- Secure-mode rejection.
- Single asset delivery against Roblox Open Cloud.
- Cache-hit behavior.
- Ordered `/assets/batch` delivery.
- Duplicate batch consistency.

`ASSET_PROXY_URL` must use HTTPS unless `ASSET_PROXY_ALLOW_HTTP=true` is explicitly set for non-production testing.

Optional verifier settings include:

- `ASSET_PROXY_TEST_ASSETS_FILE`
- `ASSET_PROXY_TIMEOUT_MS`
- `ASSET_PROXY_CACHE_ATTEMPTS`
- `ASSET_PROXY_CACHE_DELAY_MS`

## Development commands

| Command                  | Description                                                        |
| ------------------------ | ------------------------------------------------------------------ |
| `pnpm dev`               | Start the Worker locally with observability enabled.               |
| `pnpm start`             | Start Wrangler development mode.                                   |
| `pnpm test`              | Run the test suite.                                                |
| `pnpm coverage`          | Run tests with coverage enforcement.                               |
| `pnpm typecheck`         | Type-check maintained TypeScript projects.                         |
| `pnpm lint`              | Run Biome checks.                                                  |
| `pnpm lint:fix`          | Apply Biome lint fixes.                                            |
| `pnpm format`            | Check formatting with Biome.                                       |
| `pnpm format:fix`        | Apply Biome formatting.                                            |
| `pnpm cf-typegen`        | Regenerate Cloudflare binding types.                               |
| `pnpm deploy`            | Deploy the Worker.                                                 |
| `pnpm verify:production` | Verify a deployed Worker against configured Roblox asset fixtures. |

## Testing and quality

Pull requests should pass:

```sh
pnpm typecheck
pnpm lint
pnpm coverage
```

CI runs type checking, Biome checks, and the coverage suite for every branch push and when a pull request is opened. Successful checks are reused for the same commit to avoid duplicate CI work.

Coverage is enforced per source file.

The test suite covers areas including:

- Asset request validation.
- Roblox upstream discovery and delivery.
- Layered caching.
- Cache corruption and failure handling.
- Asset extension detection.
- Durable Object coordination.
- Admission control and backpressure.
- Rate limiting.
- Structured observability.
- Icon provider validation.
- SVG rendering.
- Rayfield icon delivery.
- Batch processing.
- Upstream timeout and response-size handling.

## Documentation

Repository documentation is split by responsibility:

| Document                                                           | Purpose                                                                              |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| [`docs/api.md`](./docs/api.md)                                     | HTTP requests, responses, validation, providers, status codes, and caching behavior. |
| [`docs/runtime-configuration.md`](./docs/runtime-configuration.md) | Cloudflare bindings, variables, secrets, and runtime settings.                       |
| [`docs/asset-rollout-flags.md`](./docs/asset-rollout-flags.md)     | Asset resilience feature flags and rollout behavior.                                 |
| [`docs/cd-secrets.md`](./docs/cd-secrets.md)                       | Production deployment credentials and GitHub environment configuration.              |

Broader Rayfield documentation belongs in the Sirius documentation repository.

## Contributing

Contributions are welcome.

Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) before making a change and follow the [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).

Keep pull requests focused, include tests for behavior changes, and do not commit secrets or private configuration.

## Security

Do not report suspected vulnerabilities through public issues, discussions, or pull requests.

Read [`SECURITY.md`](./SECURITY.md) and use GitHub Private Vulnerability Reporting.

## License

This repository is licensed under the [Mozilla Public License Version 2.0](./LICENSE).
