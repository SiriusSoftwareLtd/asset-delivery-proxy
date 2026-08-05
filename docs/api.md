# Asset Delivery Proxy API

This document describes the HTTP API exposed by the Asset Delivery Proxy, including request formats, validation rules, response metadata, caching behavior, and error handling.

## Endpoints

| Method | Endpoint                        | Description                              |
| ------ | ------------------------------- | ---------------------------------------- |
| `GET`  | `/health`                       | Check Worker health.                     |
| `GET`  | `/v1/assets/:assetId`           | Fetch a single Roblox asset.             |
| `POST` | `/v1/assets/batch`              | Fetch an ordered batch of Roblox assets. |
| `GET`  | `/v1/icons/:iconPack/:iconName` | Fetch a single icon as PNG.              |
| `POST` | `/v1/icons/batch`               | Fetch an ordered batch of icons.         |

## Asset delivery

### Fetch an asset

```http
GET /v1/assets/:assetId
X-Rayfield-Secure-Mode: true
```

`assetId` must be a decimal Roblox asset ID containing no more than 20 digits.

The `X-Rayfield-Secure-Mode` header is required. Requests that do not opt into secure mode receive `403 Forbidden`.

### Successful asset responses

Successful responses contain the asset bytes returned by Roblox.

The proxy preserves the upstream content type and includes these response headers where applicable:

| Header              | Description                                                        |
| ------------------- | ------------------------------------------------------------------ |
| `X-Request-ID`      | Request correlation ID.                                            |
| `X-Cache-Hit`       | Whether the response was served from cache.                        |
| `X-Cache-Status`    | The cache result.                                                  |
| `X-Cache-Timestamp` | Unix timestamp in milliseconds for the cached or fetched response. |
| `X-Asset-Extension` | Detected asset filename extension, when known.                     |

Possible `X-Cache-Status` values include:

- `l1-hit`
- `kv-fresh-hit`
- `stale-hit`
- `miss`
- `negative-hit`

Throttled and queue-rejected responses include `Retry-After`.

When lazy miss limiting is enabled, fresh, stale, and negative-cache hits do not consume the per-client Rate Limiting binding.

## Batch asset delivery

```http
POST /v1/assets/batch
X-Rayfield-Secure-Mode: true
Content-Type: application/json
```

The request body must contain between 1 and 25 decimal asset IDs.

Each ID may contain no more than 20 digits.

Example:

```json
{
  "assetIds": ["101", "202"]
}
```

The secure-mode header is required for batch requests.

Missing secure mode returns `403` before any items are processed.

### Batch asset responses

A valid batch request returns `200` and preserves the input order.

Successful items contain:

- Asset bytes encoded as base64 in `dataBase64`.
- `contentType`.
- An optional `extension`.
- `cacheStatus`.
- `cacheHit`.

Failed items contain:

- `status`.
- `cacheStatus`.
- `cacheHit`.
- `error`.

An individual item failing does not cause the whole batch to fail.

The outer request returns `400` when:

- The JSON is malformed.
- The request body has an invalid structure.
- The asset list is empty.
- The asset list contains more than 25 items.
- An asset ID is invalid.

Batch asset processing permits at most six caller-side asset operations at once.

Duplicate canonical asset identities are grouped before coordinator admission.

A batch makes at most one client rate-limit decision after its cache lookups.

## Icon delivery

### Fetch an icon

```http
GET /v1/icons/:iconPack/:iconName
```

Supported icon packs are:

| Pack           | Source                   | Options                                         |
| -------------- | ------------------------ | ----------------------------------------------- |
| `lucide`       | Lucide SVGs              | `size`                                          |
| `feather`      | Feather SVGs             | `size`                                          |
| `remix`        | Remix Icon SVGs          | `size`, required `category`                     |
| `font-awesome` | Font Awesome SVGs        | `size`, optional `style`                        |
| `hero`         | Heroicons SVGs           | `size`, optional `sourceSize`, optional `style` |
| `rayfield`     | Rayfield Gen2 PNG assets | None                                            |

Icon names may contain:

- Lowercase letters.
- Numbers.
- Hyphens.
- Underscores.

## SVG-backed icon packs

The following providers use SVG source files:

- Lucide.
- Feather.
- Remix Icon.
- Font Awesome.
- Heroicons.

The proxy retrieves the source SVG and renders it to PNG using `resvg`.

### Output size

The `size` query parameter controls the rendered PNG width.

It:

- Defaults to `64`.
- Must be an integer.
- Must be between `1` and `1024`.

Examples:

```http
GET /v1/icons/lucide/circle-check
GET /v1/icons/lucide/circle-check?size=128
GET /v1/icons/remix/home?category=Buildings
GET /v1/icons/font-awesome/circle?style=brands
GET /v1/icons/hero/academic-cap?sourceSize=20&style=solid&size=128
```

## Remix Icon options

Remix Icon requires the `category` option.

Supported categories are:

- `Arrows`
- `Buildings`
- `Business`
- `Communication`
- `Design`
- `Development`
- `Device`
- `Document`
- `Editor`
- `Finance`
- `Games & Sports`
- `Health & Medical`
- `Logos`
- `Map`
- `Media`
- `Others`
- `System`
- `User & Faces`
- `Weather`

Example:

```http
GET /v1/icons/remix/home?category=Buildings
```

## Font Awesome options

The optional `style` parameter supports:

- `brands`
- `regular`
- `solid`

The default is:

```text
solid
```

Example:

```http
GET /v1/icons/font-awesome/circle?style=brands
```

## Heroicons options

The optional `sourceSize` parameter supports:

- `16`
- `20`
- `24`

The default source size is:

```text
24
```

The optional `style` parameter supports:

- `outline`
- `solid`

The default style is:

```text
outline
```

Source-size restrictions:

| Source size | Supported styles   |
| ----------- | ------------------ |
| `16`        | `solid`            |
| `20`        | `solid`            |
| `24`        | `outline`, `solid` |

Example:

```http
GET /v1/icons/hero/academic-cap?sourceSize=20&style=solid&size=128
```

## Rayfield icons

Rayfield icons are allowlisted PNG assets sourced from the `SiriusSoftwareLtd/rayfield-gen2` repository.

They bypass SVG fetching and `resvg` rendering.

Examples:

```http
GET /v1/icons/rayfield/check
GET /v1/icons/rayfield/settings
GET /v1/icons/rayfield/rayfield
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

Rayfield icons do not accept query options.

For example:

```http
GET /v1/icons/rayfield/check?size=64
```

returns `400`.

Rayfield cache entries use the underlying asset ID as their identity.

Aliases that reference the same asset therefore share one cached PNG. For example, `dot` and `colorpicker` may share the same cached source.

## Icon source safeguards

The proxy applies bounded upstream handling before icon data is cached or returned.

### SVG sources

SVG source responses:

- Are limited to 512 KiB.
- Use a 10-second upstream timeout.
- Must use an accepted content type.
- Must contain valid SVG content before rendering.

### Rayfield PNG sources

Rayfield PNG responses:

- Are limited to 256 KiB.
- Use a 10-second upstream timeout.
- Must use the `image/png` content type when a content type is supplied.

### Upstream errors

Icon upstream responses map as follows:

| Condition                     | Proxy response |
| ----------------------------- | -------------- |
| Source does not exist         | `404`          |
| Source request fails          | `502`          |
| Invalid source response       | `502`          |
| Source exceeds its size limit | `502`          |
| SVG rendering fails           | `502`          |
| Source request times out      | `504`          |

## Icon responses

Successful icon requests return PNG bytes.

Response headers include:

| Header              | Description                                                                |
| ------------------- | -------------------------------------------------------------------------- |
| `Content-Type`      | Always `image/png`.                                                        |
| `Cache-Control`     | Public caching for 24 hours with a 5-minute stale-while-revalidate window. |
| `X-Request-ID`      | Request correlation ID.                                                    |
| `X-Icon-Pack`       | Requested icon pack.                                                       |
| `X-Cache-Hit`       | Whether the icon came from the icon cache.                                 |
| `X-Cache-Status`    | Icon cache result.                                                         |
| `X-Cache-Timestamp` | Unix timestamp in milliseconds for the cached or generated icon.           |

Possible icon cache statuses include:

- `hit`
- `miss`
- `read-error`
- `write-error`

### Icon status codes

| Status | Meaning                                                                         |
| ------ | ------------------------------------------------------------------------------- |
| `200`  | Icon returned successfully.                                                     |
| `400`  | Invalid pack, icon name, size, provider option, or unsupported Rayfield option. |
| `404`  | Requested icon does not exist.                                                  |
| `502`  | Upstream source or rendering failed.                                            |
| `504`  | Upstream source timed out.                                                      |

Errors use a JSON body containing:

- `error`
- `requestId`

## Batch icon delivery

```http
POST /v1/icons/batch
Content-Type: application/json
```

The request body must contain between 1 and 50 icon requests.

Each item must contain:

- `iconPack`
- `iconName`
- `options`

`options` must be an object whose values are strings.

Example:

```json
{
  "icons": [
    {
      "iconPack": "lucide",
      "iconName": "circle-check",
      "options": {
        "size": "64"
      }
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

The same provider validation rules and defaults used by the single-icon endpoint apply to batch items.

Rayfield batch items must use an empty `options` object.

### Batch icon responses

A structurally valid batch returns `200` and preserves input order.

Successful items contain:

- PNG bytes encoded as base64 in `dataBase64`.
- `contentType`.
- `cacheStatus`.
- `cacheHit`.

Failed items contain:

- `status`.
- `error`.

An individual item may fail without causing the complete batch request to fail.

For example, a missing icon produces a `404` item while the outer request still returns `200`.

The outer request returns `400` when:

- The JSON is malformed.
- The request body has an invalid structure.
- An item has an invalid structure.
- The icon list is empty.
- More than 50 icons are supplied.

Batch icon processing permits at most six active icon operations at once.

## Caching

### Assets

The asset delivery path uses:

1. The Cloudflare Cache API as the data-center-local L1 cache.
2. Workers KV as the persistent asset cache.

Positive asset entries are considered fresh for 24 hours.

After the fresh period expires, stale entries may be served while a background refresh runs.

Persistent asset cache entries remain available for up to seven days.

Asset `404` responses may be negatively cached for five minutes.

Cache behavior may depend on the active rollout flags documented in [`asset-rollout-flags.md`](./asset-rollout-flags.md).

### Icons

Generated SVG-backed icons and source Rayfield PNG icons are cached in Workers KV for 24 hours.

Successful icon responses also advertise a 5-minute stale-while-revalidate period through `Cache-Control`.

## Request correlation

Requests include an `X-Request-ID` response header.

Error responses include the same request identifier in their JSON payload where applicable.

Use the request ID when correlating client failures with Worker logs and tracing data.

## Related documentation

- [`runtime-configuration.md`](./runtime-configuration.md) — Worker bindings, variables, secrets, and runtime settings.
- [`asset-rollout-flags.md`](./asset-rollout-flags.md) — asset cache, coordinator, backpressure, and rollout behavior.
- [`cd-secrets.md`](./cd-secrets.md) — production deployment credentials and GitHub environment configuration.
