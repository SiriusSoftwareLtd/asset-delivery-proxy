# Asset Delivery Proxy

A Cloudflare Worker that securely proxies Roblox asset downloads for Rayfield. It validates asset IDs, requires an explicit secure-mode header, caches successful and not-found responses in Workers KV, and applies Cloudflare rate limiting before contacting Roblox.

## Features

- Serves Roblox assets from `GET /assets/:assetId`.
- Serves rendered provider icons from `GET /icons/:iconPack/:iconName`.
- Rejects malformed asset IDs and requests that do not opt into secure mode.
- Supports Roblox Asset Delivery v1 and an opt-in v2 path controlled by Cloudflare Flagship.
- Caches assets and cache metadata in Workers KV; 404 responses are negatively cached for five minutes.
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
| `X-Cache-Status` | Cache outcome, such as `hit`, `miss`, or `negative-hit`. |
| `X-Cache-Timestamp` | Unix timestamp in milliseconds for the cached or fetched response. |
| `X-Asset-Extension` | Detected asset filename extension, when known. |

### Icons

```http
GET /icons/:iconPack/:iconName?size=64
```

Supported packs are `lucide`, `feather`, `remix`, `font-awesome`, and `hero`. Icon names use lowercase letters, numbers, hyphens, and underscores. The `size` query parameter defaults to `64` and must be between 1 and 1024.

Pack-specific options are `category` for Remix icons, `style` (`brands`, `regular`, or `solid`) for Font Awesome, and `sourceSize` (`16`, `20`, or `24`) plus `style` (`outline` or `solid`) for Heroicons. Remix requires `category`; Heroicons defaults to source size `24` and `outline` style.

Successful icon responses are PNG bytes and include `Content-Type: image/png`, `Cache-Control`, `X-Request-ID`, `X-Icon-Pack`, and the `X-Cache-*` headers. Invalid requests and unsupported packs return `400`; missing icons return `404`; upstream timeouts return `504`; other generation failures return `502`.

Errors use a JSON body containing `error` and `requestId` fields. Upstream errors other than 404 are passed through with their original status and content type.

## Configuration and deployment

The Worker configuration is in [`wrangler.jsonc`](./wrangler.jsonc). It requires these Cloudflare bindings:

| Binding | Type | Purpose |
| --- | --- | --- |
| `assetCache` | Workers KV namespace | Asset and negative-response cache. |
| `ASSET_PROXY_RATE_LIMITER` | Workers Rate Limiting binding | Per-client request limiting. |
| `FLAGS` | Cloudflare Flagship binding | Enables the optional `use-asset-delivery-v2` flag. |

Before deploying a fork, create equivalent Cloudflare resources and replace the binding identifiers in `wrangler.jsonc` with identifiers from your account. Do not commit credentials or API tokens. Store sensitive runtime values with Wrangler secrets instead:

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
