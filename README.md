# Asset Delivery Proxy

A Cloudflare Worker that serves Rayfield's Roblox assets and icon resources through a controlled delivery layer. It validates asset requests, applies layered caching and bounded upstream coordination, renders supported SVG icon packs to PNG, and serves Rayfield's own registry-backed PNG icons directly.

## Features

- Serves Roblox assets from `GET /assets/:assetId`.
- Serves ordered batches of Roblox assets from `POST /assets/batch`.
- Serves icons from `GET /icons/:iconPack/:iconName`.
- Serves ordered batches of icons from `POST /icon/batch`.
- Supports Lucide, Feather, Remix Icon, Font Awesome, Heroicons, and Rayfield icon packs.
- Renders supported SVG icon sources to PNG with `resvg`.
- Serves Rayfield's own allowlisted PNG assets directly without SVG rendering.
- Caches generated and source PNG icons in Workers KV for 24 hours.
- Rejects malformed asset IDs and asset requests that do not opt into secure mode.
- Supports Roblox Asset Delivery v1 and an opt-in v2 path controlled by Cloudflare Flagship.
- Uses the Cache API for fresh, data-center-local asset bytes and Workers KV as the authoritative seven-day asset cache.
- Serves positive asset entries as fresh for 24 hours, then stale while a Durable Object-coalesced background refresh runs; 404 responses remain negatively cached for five minutes.
- Coalesces identical cold asset resolutions and applies bounded upstream admission through hash-sharded Durable Objects when the foreground coordinator rollout is enabled.
- Preserves Roblox upstream content types and returns a detected `X-Asset-Extension` when available.
- Emits structured logs, request IDs, cache-status headers, and tracing attributes.

## Requirements

- Node.js 20 or later
- pnpm
- A Cloudflare account for local remote bindings or deployment

## Getting started

```sh
pnpm install
pnpm test
pnpm dev
```

`pnpm dev` starts Wrangler with local observability enabled. The test suite uses the Cloudflare Workers Vitest pool and the bindings declared in `wrangler.jsonc`.

## API

### Assets

```http
GET /assets/:assetId
X-Rayfield-Secure-Mode: true
```

`assetId` must be a decimal Roblox asset ID of up to 20 digits. The secure-mode header is required; requests without it receive `403 Forbidden`.

Successful responses include the asset bytes and these useful headers:

| Header | Meaning |
| --- | --- |
| `X-Request-ID` | Request correlation ID. |
| `X-Cache-Hit` | Whether the response was served from cache. |
| `X-Cache-Status` | Cache outcome, including `l1-hit`, `kv-fresh-hit`, `stale-hit`, `miss`, or `negative-hit`. |
| `X-Cache-Timestamp` | Unix timestamp in milliseconds for the cached or fetched response. |
| `X-Asset-Extension` | Detected asset filename extension, when known. |

Throttled and queue-rejected responses include `Retry-After`. With lazy miss limiting enabled, fresh, stale, and negative-cache hits do not consume the per-client Rate Limiting binding. A batch makes at most one client-limit decision after its cache lookups.

### Batch assets

```http
POST /assets/batch
X-Rayfield-Secure-Mode: true
Content-Type: application/json
```

The JSON body must contain between 1 and 25 decimal asset IDs, each up to 20 digits:

```json
{ "assetIds": ["101", "202"] }
```

A valid batch returns `200` and preserves input order. Each successful item contains the asset bytes as base64 in `dataBase64`, along with `contentType`, an optional `extension`, `cacheStatus`, and `cacheHit`.

Failed items contain their individual HTTP `status`, `cacheStatus`, `cacheHit`, and `error`; one item failing does not fail the whole batch. Malformed JSON, an invalid body, an empty or over-25 list, or an invalid asset ID returns `400`. Missing secure mode returns `403` before processing items.

Batch processing allows at most six caller-side asset operations at once and groups duplicate canonical identities before coordinator admission.

### Icons

```http
GET /icons/:iconPack/:iconName
```

Supported icon packs are:

| Pack | Source | Options |
| --- | --- | --- |
| `lucide` | Lucide SVGs | `size` |
| `feather` | Feather SVGs | `size` |
| `remix` | Remix Icon SVGs | `size`, required `category` |
| `font-awesome` | Font Awesome SVGs | `size`, optional `style` |
| `hero` | Heroicons SVGs | `size`, optional `sourceSize`, optional `style` |
| `rayfield` | Rayfield Gen 2 PNG assets | None |

Icon names may contain lowercase letters, numbers, hyphens, and underscores.

#### SVG-backed packs

Lucide, Feather, Remix Icon, Font Awesome, and Heroicons are fetched as SVG and rendered to PNG with `resvg`.

The `size` option controls the output width, defaults to `64`, and must be an integer from `1` through `1024`.

Examples:

```http
GET /icons/lucide/circle-check
GET /icons/lucide/circle-check?size=128
GET /icons/remix/home?category=Buildings
GET /icons/font-awesome/circle?style=brands
GET /icons/hero/academic-cap?sourceSize=20&style=solid&size=128
```

Provider-specific options:

- Remix Icon requires `category`. Supported categories are `Arrows`, `Buildings`, `Business`, `Communication`, `Design`, `Development`, `Device`, `Document`, `Editor`, `Finance`, `Games & Sports`, `Health & Medical`, `Logos`, `Map`, `Media`, `Others`, `System`, `User & Faces`, and `Weather`.
- Font Awesome `style` may be `brands`, `regular`, or `solid` and defaults to `solid`.
- Heroicons `sourceSize` may be `16`, `20`, or `24` and defaults to `24`.
- Heroicons `style` may be `outline` or `solid` and defaults to `outline`.
- Heroicons source sizes `16` and `20` only support `solid`; source size `24` supports both styles.

SVG source responses are bounded to 512 KiB and upstream icon requests time out after 10 seconds.

#### Rayfield icons

Rayfield icons are served from the allowlisted PNG assets in the `SiriusSoftwareLtd/rayfield-gen2` repository. They bypass SVG fetching and `resvg` rendering.

```http
GET /icons/rayfield/check
GET /icons/rayfield/settings
GET /icons/rayfield/rayfield
```

Supported Rayfield icon names are:

- `close`
- `minimise`
- `maximise`
- `settings`
- `search`
- `chevron`
- `check`
- `dot`
- `colorpicker`
- `banner`
- `config`
- `rayfield`

Rayfield icon requests do not accept query options. A request such as `GET /icons/rayfield/check?size=64` returns `400`.

Rayfield PNG source responses are limited to 256 KiB and use the same 10-second upstream timeout as SVG-backed packs. Rayfield cache entries use the underlying asset ID as their identity, so aliases that point to the same asset, such as `dot` and `colorpicker`, share one cached PNG.

#### Icon responses

Successful icon requests return PNG bytes and include:

| Header | Meaning |
| --- | --- |
| `Content-Type` | Always `image/png`. |
| `Cache-Control` | Public caching for 24 hours with a 5-minute stale-while-revalidate window. |
| `X-Request-ID` | Request correlation ID. |
| `X-Icon-Pack` | Requested icon pack. |
| `X-Cache-Hit` | Whether the icon came from the icon cache. |
| `X-Cache-Status` | Icon cache result, such as `hit`, `miss`, `read-error`, or `write-error`. |
| `X-Cache-Timestamp` | Unix timestamp in milliseconds for the cached or generated icon. |

Icon responses use these status codes:

| Status | Meaning |
| --- | --- |
| `200` | Icon returned successfully. |
| `400` | Invalid pack, icon name, size, provider option, or unsupported Rayfield query option. |
| `404` | The requested icon does not exist. |
| `502` | The icon source failed, returned an invalid response, exceeded a source-size limit, or rendering failed. |
| `504` | The upstream icon source timed out. |

Errors use a JSON body containing `error` and `requestId`.

### Batch icons

```http
POST /icon/batch
Content-Type: application/json
```

The JSON body must contain between 1 and 50 icon requests. Each item must contain `iconPack`, `iconName`, and an `options` object whose values are strings:

```json
{
  "icons": [
    {
      "iconPack": "lucide",
      "iconName": "circle-check",
      "options": { "size": "64" }
    },
    {
      "iconPack": "hero",
      "iconName": "academic-cap",
      "options": {
        "sourceSize": "20",
        "style": "solid",
        "size": "128"
      }
    },
    {
      "iconPack": "rayfield",
      "iconName": "check",
      "options": {}
    }
  ]
}
```

The same provider validation and defaults as the single-icon route apply. Rayfield items must use an empty `options` object.

A structurally valid batch returns `200` and preserves input order even when individual items fail. Successful items contain the PNG as base64 in `dataBase64`, along with `contentType`, `cacheStatus`, and `cacheHit`. Failed items contain their own `status` and `error`.

For example, a non-existent icon produces a `404` result for that item without failing the whole batch.

Malformed JSON, malformed body or item structure, an empty list, or more than 50 items returns an outer `400`. Batch processing allows at most six active icon operations at once.

## Icon source safeguards

Icon delivery applies bounded upstream handling before data is cached or returned:

- SVG source responses are limited to 512 KiB.
- Rayfield PNG source responses are limited to 256 KiB when the upstream declares a content length.
- Upstream icon requests time out after 10 seconds.
- SVG responses are checked for an accepted content type and SVG content before rendering.
- Rayfield PNG responses must use the `image/png` content type when one is supplied.
- Upstream 404 responses map to `404 Icon not found`.
- Other upstream or rendering failures map to `502`.
- Upstream timeouts map to `504`.

## Configuration and deployment

The Worker configuration is in [`wrangler.jsonc`](./wrangler.jsonc). See [`docs/runtime-configuration.md`](./docs/runtime-configuration.md) for the complete bindings, vars, secrets, and billing-impact reference.

Resilience rolls out through `asset-cache-layered`, `asset-cache-hit-exempt-limit`, `asset-upstream-coordinator`, and `asset-upstream-backpressure`. `asset-upstream-coordinator` controls foreground cold-miss Durable Object routing, but stale background refreshes use `ASSET_RESOLUTION_COORDINATOR` once `asset-cache-layered` is enabled, unless the budget gate rejects the refresh at admission before any Durable Object work starts. Stale-refresh backpressure requires both `asset-upstream-coordinator` and `asset-upstream-backpressure`. The existing `use-asset-delivery-v2` flag remains independent. Disabling each flag restores the preceding foreground path without changing public routes. See [`docs/asset-rollout-flags.md`](./docs/asset-rollout-flags.md) for the complete flag map.

Before deploying a fork, create equivalent Cloudflare resources and replace the binding identifiers in `wrangler.jsonc` with identifiers from your account. Do not commit credentials or API tokens. Store `ROBLOX_API_KEY` with Wrangler secrets:

```sh
pnpm exec wrangler secret put ROBLOX_API_KEY
pnpm deploy
```

After deployment, run the production verifier against the deployed Worker:

```sh
cp scripts/verify-production.assets.example.json scripts/verify-production.assets.json
ASSET_PROXY_URL=https://<your-worker-hostname> ROBLOX_API_KEY=<roblox-open-cloud-key> pnpm verify:production
```

Edit the ignored `scripts/verify-production.assets.json` file with between 1 and 25 private Roblox asset fixtures. Include at least one stable image asset and one stable font asset when possible so extension detection, byte comparison, cache headers, and batch delivery are exercised across both supported asset kinds.

The verifier loads `.env` automatically, so `ASSET_PROXY_URL`, `ROBLOX_API_KEY`, and optional verifier settings can live there for local operator runs. Do not commit real asset IDs if they are private, API keys, or generated verification output.

`pnpm verify:production` checks `/health`, secure-mode rejection, single asset delivery against Roblox Open Cloud, cache hit behavior, ordered `/assets/batch` delivery, and duplicate batch consistency. It requires `ASSET_PROXY_URL` to be HTTPS unless `ASSET_PROXY_ALLOW_HTTP=true` is set for non-production testing.

Optional settings are `ASSET_PROXY_TEST_ASSETS_FILE`, `ASSET_PROXY_TIMEOUT_MS`, `ASSET_PROXY_CACHE_ATTEMPTS`, and `ASSET_PROXY_CACHE_DELAY_MS`.

The CD workflow deploys the Worker from the `production` GitHub Actions environment after the `CI` workflow succeeds for a push to `main`, but only when that CI run's SHA is still the current `main` head. It verifies that condition before opening the deploy job and rechecks it immediately before `pnpm deploy` so a newer `main` commit cannot be overwritten by an older completed CI run.

To intentionally skip automated deployment for a commit, put `[skip cd]` at the start or end of the commit message. See [`docs/cd-secrets.md`](./docs/cd-secrets.md) for the required GitHub environment secret and Cloudflare API token permissions.

Generate binding types after changing `wrangler.jsonc`:

```sh
pnpm cf-typegen
```

## Development commands

| Command | Description |
| --- | --- |
| `pnpm dev` | Start the Worker locally with observability enabled. |
| `pnpm start` | Start Wrangler development mode. |
| `pnpm test` | Run the Worker test suite. |
| `pnpm typecheck` | Type-check the Worker and test projects. |
| `pnpm lint` | Run Biome checks. |
| `pnpm lint:fix` | Apply safe Biome fixes. |
| `pnpm format` | Check formatting with Biome. |
| `pnpm format:fix` | Apply Biome formatting. |
| `pnpm cf-typegen` | Regenerate Cloudflare binding types. |
| `pnpm deploy` | Deploy the configured Worker. |
| `pnpm verify:production` | Run live post-deploy verification against a configured Worker and Roblox asset fixtures. |

## Contributing

Contributions are welcome. Read [Contributors.md](./Contributors.md) for the development workflow and pull-request expectations, and follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Security

Please report suspected vulnerabilities privately; see [SECURITY.md](./SECURITY.md). Do not open public issues for security reports.

## License

A license has not yet been selected for this repository. Until one is added, do not assume permission to reuse or redistribute the code.
