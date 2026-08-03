# Asset Delivery Proxy

A Cloudflare Worker that securely proxies Roblox asset downloads for Rayfield. It validates asset IDs, requires an explicit secure-mode header, and uses layered edge and persistent caching with bounded upstream coordination.

## Features

- Serves Roblox assets from `GET /assets/:assetId`.
- Serves ordered batches of Roblox assets from `POST /assets/batch`.
- Serves rendered provider icons from `GET /icons/:iconPack/:iconName`.
- Serves ordered batches of rendered provider icons from `POST /icon/batch`.
- Rejects malformed asset IDs and requests that do not opt into secure mode.
- Supports Roblox Asset Delivery v1 and an opt-in v2 path controlled by Cloudflare Flagship.
- Uses the Cache API for fresh, data-center-local bytes and Workers KV as the authoritative seven-day cache.
- Serves positive entries as fresh for 24 hours, then stale while a background refresh runs; 404 responses remain negatively cached for five minutes.
- Coalesces identical cold resolutions and applies bounded upstream admission through hash-sharded Durable Objects.
- Preserves the upstream content type and returns a detected `X-Asset-Extension` when available.
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

The JSON body must contain between 1 and 25 decimal asset IDs (each up to 20 digits):

```json
{ "assetIds": ["101", "202"] }
```

A valid batch returns `200` and preserves input order. Each successful item contains the asset bytes as base64 in `dataBase64`, along with `contentType`, an optional `extension`, `cacheStatus`, and `cacheHit`. Failed items contain their individual HTTP `status`, `cacheStatus`, `cacheHit`, and `error`; one item failing does not fail the whole batch. Malformed JSON, an invalid body, an empty or over-25 list, or an invalid asset ID returns `400`. Missing secure mode returns `403` before processing items. Batch processing allows at most six caller-side asset operations at once and groups duplicate canonical identities before coordinator admission.

### Icons

```http
GET /icons/:iconPack/:iconName?size=64
```

Supported packs are `lucide`, `feather`, `remix`, `font-awesome`, and `hero`. Icon names use lowercase letters, numbers, hyphens, and underscores. The `size` query parameter defaults to `64` and must be between 1 and 1024.

Pack-specific options are `category` for Remix icons, `style` (`brands`, `regular`, or `solid`) for Font Awesome, and `sourceSize` (`16`, `20`, or `24`) plus `style` (`outline` or `solid`) for Heroicons. Remix requires `category`; Heroicons defaults to source size `24` and `outline` style.

Successful icon responses are PNG bytes and include `Content-Type: image/png`, `Cache-Control`, `X-Request-ID`, `X-Icon-Pack`, and the `X-Cache-*` headers. Invalid requests and unsupported packs return `400`; missing icons return `404`; upstream timeouts return `504`; other generation failures return `502`.

Errors use a JSON body containing `error` and `requestId` fields. Upstream errors other than 404 are passed through with their original status and content type.

### Batch icons

```http
POST /icon/batch
Content-Type: application/json
```

The JSON body must contain between 1 and 50 icon requests. Each item has an `iconPack`, `iconName`, and an `options` object whose values are strings:

```json
{
  "icons": [
    { "iconPack": "lucide", "iconName": "circle-check", "options": { "size": "64" } },
    { "iconPack": "hero", "iconName": "academic-cap", "options": { "sourceSize": "20", "style": "solid", "size": "128" } }
  ]
}
```

The supported options are `size`, Remix `category`, Font Awesome `style` (`brands`, `regular`, or `solid`), and Heroicons `sourceSize` (`16`, `20`, or `24`) plus `style` (`outline` or `solid`). The same provider validation and defaults as the single-icon route apply. A valid batch returns `200`, preserves input order, and returns successful PNGs as base64 in `dataBase64`, with `contentType`, `cacheStatus`, and `cacheHit`. Individual failures return their own `status` and `error`; malformed JSON, malformed body/item structure, an empty list, or more than 50 items returns outer `400`. Batch processing allows at most six active icon operations at once.

## Configuration and deployment

The Worker configuration is in [`wrangler.jsonc`](./wrangler.jsonc). It requires these Cloudflare bindings:

| Binding | Type | Purpose |
| --- | --- | --- |
| `assetCache` | Workers KV namespace | Asset and negative-response cache. |
| `ASSET_PROXY_RATE_LIMITER` | Workers Rate Limiting binding | Per-client request limiting. |
| `ASSET_RESOLUTION_COORDINATOR` | Durable Object namespace | Per-key coalescing, admission, retry, and cooldown state. |
| `ASSET_METRICS` | Analytics Engine dataset | Low-cardinality cache and resolution outcomes. |
| `FLAGS` | Cloudflare Flagship binding | Controls protocol and resilience rollout flags. |

Resilience rolls out through `asset-cache-layered`, `asset-cache-hit-exempt-limit`, `asset-upstream-coordinator`, and `asset-upstream-backpressure`. The existing `use-asset-delivery-v2` flag remains independent. Disabling each flag restores the preceding path without changing public routes. See [`docs/asset-rollout-flags.md`](./docs/asset-rollout-flags.md) for the complete flag map.

Coordinator shard count, concurrency, queue size, permit interval, fallback cooldown, retry base, and operation deadline are configured through `ASSET_COORDINATOR_*` vars. `ASSET_COORDINATOR_BUDGET_VERIFIED` is checked before backpressure can run and is committed as `false`; leave it false until Roblox quota identity and capacity have been verified and the aggregate shard settings have been calibrated at or below that budget. The checked-in numeric values are inert rollout defaults, not claimed Roblox limits.

Legacy bare v1 KV keys are read only until `ASSET_LEGACY_V1_READ_UNTIL`; all new writes use hashed canonical keys. Remove the fallback after that cutoff once migration hit metrics show it is no longer needed.

Before deploying a fork, create equivalent Cloudflare resources and replace the binding identifiers in `wrangler.jsonc` with identifiers from your account. Do not commit credentials or API tokens. Store sensitive runtime values with Wrangler secrets instead:

`ROBLOX_API_KEY` is sent as the `x-api-key` header to Roblox's authenticated Open Cloud asset-delivery endpoint.
Configure an actual Open Cloud API key in `ROBLOX_API_KEY`. Authentication headers are not forwarded to returned signed
asset-download locations.

```sh
pnpm exec wrangler secret put YOUR_SECRET_NAME
pnpm deploy
```

Generate bindings types after changing `wrangler.jsonc`:

```sh
pnpm cf-typegen
```

## Development commands

| Command | Description |
| --- | --- |
| `pnpm dev` | Start the Worker locally with observability enabled. |
| `pnpm start` | Start Wrangler development mode. |
| `pnpm test` | Run the Worker test suite. |
| `pnpm cf-typegen` | Regenerate Cloudflare binding types. |
| `pnpm deploy` | Deploy the configured Worker. |

## Contributing

Contributions are welcome. Read [Contributors.md](./Contributors.md) for the development workflow and pull-request expectations, and follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Security

Please report suspected vulnerabilities privately; see [SECURITY.md](./SECURITY.md). Do not open public issues for security reports.

## License

A license has not yet been selected for this repository. Until one is added, do not assume permission to reuse or redistribute the code.
