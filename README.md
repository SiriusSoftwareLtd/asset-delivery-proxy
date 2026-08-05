# Asset Delivery Proxy

A Cloudflare Worker that provides Rayfield Gen2 with a controlled asset and icon delivery layer.

The service validates asset requests, proxies Roblox asset delivery, applies layered caching and bounded upstream coordination, renders supported SVG icon packs to PNG, and serves Rayfield's registry-backed PNG icons.

## Features

- Proxies Roblox asset delivery through authenticated and controlled request paths.
- Supports single and batch asset requests.
- Serves icons from Lucide, Feather, Remix Icon, Font Awesome, Heroicons, and Rayfield.
- Renders supported SVG icon sources to PNG with `resvg`.
- Serves allowlisted Rayfield PNG assets without SVG rendering.
- Uses the Cache API and Workers KV for layered asset caching.
- Uses Durable Objects to coalesce and regulate upstream asset requests.
- Supports negative caching and stale-while-refresh asset delivery.
- Applies request validation, upstream timeouts, response-size limits, and rate limiting.
- Emits structured logs, request IDs, cache metadata, metrics, and tracing data.
- Supports controlled feature rollout through Cloudflare Flagship.

## API overview

| Method | Endpoint                     | Purpose                                  |
| ------ | ---------------------------- | ---------------------------------------- |
| `GET`  | `/assets/:assetId`           | Fetch a single Roblox asset.             |
| `POST` | `/assets/batch`              | Fetch an ordered batch of Roblox assets. |
| `GET`  | `/icons/:iconPack/:iconName` | Fetch a single icon as PNG.              |
| `POST` | `/icon/batch`                | Fetch an ordered batch of icons.         |
| `GET`  | `/health`                    | Check Worker health.                     |

Asset delivery requests require:

```http
X-Rayfield-Secure-Mode: true
```

The complete public API contract, request formats, response schemas, supported icon options, status codes, and examples are maintained in the Sirius documentation repository:

https://github.com/SiriusSoftwareLtd/docs

## Requirements

- Node.js 20 or later
- pnpm
- A Cloudflare account for Worker development or deployment

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

The Worker uses the bindings declared in `wrangler.jsonc`. Use resources from your own Cloudflare account when testing a fork or separate deployment.

## Configuration

Worker configuration lives in [`wrangler.jsonc`](./wrangler.jsonc).

Repository-local operational documentation covers settings that must stay synchronized with the deployed Worker:

- [`docs/runtime-configuration.md`](./docs/runtime-configuration.md) — bindings, variables, secrets, and runtime configuration.
- [`docs/asset-rollout-flags.md`](./docs/asset-rollout-flags.md) — asset resilience and rollout flags.
- [`docs/cd-secrets.md`](./docs/cd-secrets.md) — production deployment credentials and GitHub environment requirements.

Do not commit API keys, Cloudflare tokens, production credentials, or private verification fixtures.

Store the Roblox Open Cloud API key as a Wrangler secret:

```sh
pnpm exec wrangler secret put ROBLOX_API_KEY
```

Regenerate Cloudflare binding types after changing `wrangler.jsonc`:

```sh
pnpm cf-typegen
```

Commit the resulting `worker-configuration.d.ts` update with the configuration change.

## Deployment

Deploy the configured Worker with:

```sh
pnpm deploy
```

The repository's CD workflow deploys from the `production` GitHub Actions environment after CI succeeds for a push to `main`.

Before deployment, the workflow verifies that the tested commit is still the current `main` head. It performs the check again immediately before deployment so an older CI run cannot overwrite a newer revision.

To prevent CD for a specific commit, place `[skip cd]` at the start or end of its commit message.

## Production verification

The repository includes a live production verification script.

Create a local fixture file:

```sh
cp scripts/verify-production.assets.example.json scripts/verify-production.assets.json
```

Populate it with suitable private Roblox asset fixtures, then run:

```sh
ASSET_PROXY_URL=https://<worker-hostname> \
ROBLOX_API_KEY=<roblox-open-cloud-key> \
pnpm verify:production
```

The fixture file is ignored by Git and must not contain credentials.

The verifier checks core production behavior including:

- Worker health.
- Secure-mode enforcement.
- Roblox asset delivery.
- Cache behavior.
- Ordered batch delivery.
- Duplicate asset handling.

See the repository-local operational documentation for configuration details.

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

Coverage is enforced per source file to prevent new code from bypassing the configured thresholds.

Tests cover asset delivery, caching, Durable Object coordination, rate limiting, observability, Roblox upstream behavior, icon generation, validation, and failure handling.

## Documentation

Public Rayfield documentation and API reference material are maintained in:

https://github.com/SiriusSoftwareLtd/docs

Keep documentation in this repository only when it describes implementation-specific configuration, deployment, rollout, or operational behavior that must change with the Worker source.

## Contributing

Contributions are welcome.

Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) before making a change and follow the [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).

Keep pull requests focused, include tests for behavior changes, and do not commit secrets or private configuration.

## Security

Do not report suspected vulnerabilities through public issues or pull requests.

Read [`SECURITY.md`](./SECURITY.md) and use GitHub Private Vulnerability Reporting.

## License

A license has not yet been selected for this repository.

Until one is added, do not assume permission to reuse or redistribute the code.
