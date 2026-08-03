# Runtime Configuration

The Worker configuration is in [`../wrangler.jsonc`](../wrangler.jsonc). Before deploying a fork, create equivalent
Cloudflare resources and replace the binding identifiers in `wrangler.jsonc` with identifiers from your account.

## Bindings

| Binding | Type | Purpose | Billing and operational impact |
| --- | --- | --- | --- |
| `assetCache` | Workers KV namespace | Asset and negative-response cache. | KV reads and writes are billable Cloudflare usage. More cache hits reduce Roblox upstream calls and Rate Limiting decisions, but successful asset writes store raw bytes and metadata. |
| `ASSET_PROXY_RATE_LIMITER` | Workers Rate Limiting binding | Per-client request limiting. | Limit checks are runtime binding operations. With `asset-cache-hit-exempt-limit` enabled, cache hits avoid this binding and only cold misses consume checks. |
| `ASSET_RESOLUTION_COORDINATOR` | Durable Object namespace | Per-key coalescing, admission, retry, and cooldown state. | Foreground cold misses create Durable Object requests only when `asset-upstream-coordinator` is enabled. Background stale refreshes always use this Durable Object when `asset-cache-layered` is enabled so refresh work is distributed and single-flight coalesced. Higher shard, queue, and concurrency settings can increase DO request volume and active duration. |
| `ASSET_METRICS` | Analytics Engine dataset | Low-cardinality cache and resolution outcomes. | Each emitted datapoint contributes Analytics Engine ingest volume. Current Cloudflare docs state Workers Analytics Engine is not billed yet, but pricing is published ahead of future billing. |
| `FLAGS` | Cloudflare Flagship binding | Controls protocol and resilience rollout flags. | Flag evaluations affect route behavior and can add provider-specific billing depending on the Cloudflare account/product terms. Flag failures fail closed to the `false` path. |

## Vars

The checked-in `vars` are non-secret runtime controls. Wrangler exposes them on `env`; invalid numeric values fall back to
the code defaults shown below. Do not put credentials in `vars`.

| Var | Checked-in value | Accepted values | Purpose | Billing and operational impact |
| --- | --- | --- | --- | --- |
| `OBSERVABILITY_REPORT_LEVEL` | `off` | `off`, `error`, `warn`, `info`, or `debug`; missing or invalid values become `off`. | Gates custom application logs and trace spans. `info` enables request-completed logs and custom spans; `debug` includes every lower-severity custom event. | Cloudflare observability is enabled in `wrangler.jsonc`; raising this var increases retained/exported log and trace volume. Keep `off` for quiet production unless investigating an issue. |
| `ASSET_COORDINATOR_BUDGET_VERIFIED` | `false` | String `true` enables backpressure; every other value disables it. | Safety gate for `asset-upstream-backpressure`. Leave `false` until Roblox quota identity and aggregate coordinator capacity are verified. | When `false`, coordinated backpressure returns `503` with `Retry-After: 60` instead of consuming Roblox quota or queueing Durable Object work under uncalibrated settings. |
| `ASSET_COORDINATOR_SHARDS` | `16` | Integer `1` through `1024`; fallback `16`. | Hashes each canonical cache key to `asset-shard-<n>` and spreads coordinated misses across Durable Object instances. | More shards spread load and reduce per-object contention, but can create more active Durable Object instances and more distributed state. Aggregate upstream capacity is roughly `shards * concurrency` before permit spacing is considered. |
| `ASSET_COORDINATOR_CONCURRENCY` | `1` | Integer `1` through `32`; fallback `1`. | Maximum active upstream resolutions per coordinator shard when backpressure is enabled. | Raising it can increase Roblox request throughput and Durable Object active duration. Do not raise until the upstream API budget supports the aggregate capacity. |
| `ASSET_COORDINATOR_QUEUE_LIMIT` | `32` | Integer `0` through `1000`; fallback `32`. | Maximum queued waiters per coordinator shard when backpressure is enabled. A full queue returns `503` with `Retry-After`. | Larger queues can smooth bursts but keep more callers waiting on Durable Object execution, increasing latency and potentially billed active duration. |
| `ASSET_COORDINATOR_PERMIT_INTERVAL_MS` | `1000` | Integer `0` through `60000`; fallback `1000`. | Minimum time between permits issued by each shard when backpressure is enabled. | Lower values permit more upstream calls and can increase Roblox/API usage. Higher values reduce upstream pressure but increase queue time and timeout risk. |
| `ASSET_COORDINATOR_FALLBACK_COOLDOWN_SECONDS` | `30` | Integer `1` through `3600`; fallback `30`. | Cooldown duration used after Roblox returns `429` without a usable `Retry-After`. | Longer cooldowns protect upstream quota and reduce retry churn, but can return `429` to users for longer. Shorter cooldowns may spend more upstream requests during a provider throttle window. |
| `ASSET_COORDINATOR_OPERATION_DEADLINE_MS` | `25000` | Integer `1000` through `120000`; fallback `25000`. | Deadline passed to the Durable Object for one miss-resolution operation, including queueing, upstream fetch, and retry. | Longer deadlines can keep Durable Object work active longer and increase tail latency. Shorter deadlines fail faster with `504` and may reduce successful retries. |
| `ASSET_COORDINATOR_RETRY_BASE_MS` | `250` | Integer `1` through `10000`; fallback `250`. | Base jittered delay before one retry of retryable upstream failures while backpressure is enabled. | Higher values reduce immediate retry pressure but spend more request deadline. Lower values retry faster and can amplify upstream pressure during transient failures. |

The checked-in numeric coordinator values are inert rollout defaults, not claimed Roblox limits. Treat changes to any
`ASSET_COORDINATOR_*` var as an upstream-capacity and Durable Object cost review.

## Durable Object Rollout Impact

Foreground cold misses resolve directly from Roblox while `asset-upstream-coordinator` is disabled, and route through
`ASSET_RESOLUTION_COORDINATOR` when it is enabled. Background stale refreshes are different: once `asset-cache-layered` is
enabled, stale refresh work always goes through `ASSET_RESOLUTION_COORDINATOR` for distributed single-flight coalescing.

Backpressure on stale refreshes requires both `asset-upstream-coordinator` and `asset-upstream-backpressure`. Enabling
`asset-upstream-backpressure` alone must not add stale-refresh permits, queues, cooldown admission, or retries. Enabling
`asset-cache-layered` can still increase Durable Object requests and billed active duration before foreground coordinator
rollout.

## Secrets

Do not commit credentials or API tokens. Store sensitive runtime values with Wrangler secrets and local `.dev.vars` or
`.env` files.

| Secret | Required | Purpose | Billing and operational impact |
| --- | --- | --- | --- |
| `ROBLOX_API_KEY` | Yes | Sent as the `x-api-key` header to Roblox's authenticated Open Cloud asset-delivery endpoint. Authentication headers are not forwarded to returned signed asset-download locations. | This controls access to the upstream Roblox API and any Roblox-side quotas or billing associated with that API key. Rotate it through Wrangler secrets, not committed config. |

```sh
pnpm exec wrangler secret put ROBLOX_API_KEY
```
