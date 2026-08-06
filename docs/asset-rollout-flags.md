# Asset Rollout Flags

This Worker uses Cloudflare Flagship boolean flags to roll out asset-delivery behavior without changing public routes,
headers, binding names, or request and response shapes. All flags default to `false` in code. If Flagship evaluation fails,
the Worker logs `asset.flag.evaluation_failed` according to `OBSERVABILITY_REPORT_LEVEL` and continues with the `false`
path.

The flags below affect only `GET /v1/assets/:assetId` and `POST /v1/assets/batch`. Icon routes do not use these rollout flags.

Asset flags are evaluated lazily through a request-scoped policy snapshot. Each flag is evaluated at most once per asset
request, including a batch, and values are never reused across requests or isolates. Coordinator and backpressure flags
are evaluated only after the request reaches a stale-refresh or foreground-miss path where they can affect behavior.

## Flag map

| Flag                           | Purpose                                                                                  | `false` behavior                                                                                                                                                           | `true` behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `use-asset-delivery-v2`        | Selects the Roblox asset-delivery protocol used to resolve a requested asset.            | Uses the established Roblox v1 asset-delivery request path and a v1 canonical cache key.                                                                                   | Uses Roblox v2 discovery, follows the first valid HTTPS location, forwards only allowlisted representation-affecting inputs, and varies the cache key by those inputs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `asset-cache-hit-exempt-limit` | Moves client rate limiting from every asset request to only cold miss resolution work.   | The Worker applies `ASSET_PROXY_RATE_LIMITER` before route handling for every `/v1/assets/` request, including cache hits.                                                 | Cache hits bypass the client rate-limit check. Cold misses still call `ASSET_PROXY_RATE_LIMITER` before contacting Roblox or the coordinator. A batch performs one lazy limit decision for its unique misses.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `asset-cache-layered`          | Enables the layered asset cache lifecycle on top of KV.                                  | The Worker reads KV only. Fresh KV hits return `X-Cache-Status: hit`; stale KV entries are treated as misses and refetched before responding.                              | The Worker checks `caches.default` as an L1 cache, returns `l1-hit` for fresh L1 bytes, returns `kv-fresh-hit` for fresh KV bytes and repopulates L1, and returns `stale-hit` for stale KV bytes while refreshing in the background through `ASSET_RESOLUTION_COORDINATOR`.                                                                                                                                                                                                                                                                                                                                                                   |
| `asset-upstream-coordinator`   | Routes foreground cold misses through the `ASSET_RESOLUTION_COORDINATOR` Durable Object. | Foreground cold misses resolve directly from Roblox in the request handler. Stale background refreshes still use the Durable Object when `asset-cache-layered` is enabled. | Foreground cold misses go through a shard-selected Durable Object that coalesces same-key concurrent work, rechecks KV, and centralizes upstream retry and cooldown state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `asset-upstream-backpressure`  | Enables coordinator admission control and retry behavior for upstream protection.        | The coordinator still coalesces requests when used, but does not acquire permits, queue callers, rate permits, enter cooldown, or retry transient upstream responses.      | The coordinator enforces permits, queue limits, permit spacing, persisted cooldown after upstream `429`, and one retry for retryable upstream failures when the request deadline allows it. Requires both `asset-upstream-coordinator` and `ASSET_COORDINATOR_BUDGET_VERIFIED=true`; otherwise foreground coordinated misses return `503` with `Retry-After: 60`. Stale refreshes run through the coordinator without backpressure only when `asset-upstream-coordinator` is off; when both flags are on but the budget is unverified, the stale response is served and the background refresh is rejected before Durable Object work starts. |

## Coordinator traffic

Foreground cold miss:

- `asset-upstream-coordinator` off -> direct Roblox
- `asset-upstream-coordinator` on -> Durable Object

Background stale refresh:

- `asset-upstream-coordinator` and `asset-upstream-backpressure` on, budget unverified -> rejected at admission, no
  Durable Object work
- otherwise -> Durable Object for distributed single-flight coalescing

Stale refresh backpressure is enabled only when `asset-upstream-coordinator`, `asset-upstream-backpressure`, and
`ASSET_COORDINATOR_BUDGET_VERIFIED=true` are all in place. Enabling `asset-cache-layered` can therefore create Durable
Object requests for stale background refreshes before foreground coordinator rollout. This has Durable Object operational
and billing impact, while `asset-upstream-coordinator` still controls foreground cold-miss routing.

## Rollout order

Enable the flags in dependency order:

1. `asset-cache-hit-exempt-limit`
2. `asset-cache-layered`
3. `asset-upstream-coordinator`
4. `asset-upstream-backpressure`

`use-asset-delivery-v2` is independent from the resilience rollout. It can be enabled or disabled separately, but v2
changes cache identity because v2 allows representation-affecting query parameters and headers.

## Related runtime vars

These `wrangler.jsonc` vars are not Flagship flags, but they tune the flagged asset-resolution paths.

| Var                                           | Default | Purpose                                                                                                                                                                            |
| --------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ASSET_COORDINATOR_BUDGET_VERIFIED`           | `true`  | Safety gate for `asset-upstream-backpressure`. Keep this `false` until Roblox quota identity and aggregate shard capacity are verified.                                            |
| `ASSET_COORDINATOR_SHARDS`                    | `16`    | Number of Durable Object shards used by foreground coordination and stale background refresh coalescing. The client hashes each canonical cache key and selects `asset-shard-<n>`. |
| `ASSET_COORDINATOR_CONCURRENCY`               | `1`     | Maximum active upstream resolutions per coordinator shard when backpressure is enabled.                                                                                            |
| `ASSET_COORDINATOR_QUEUE_LIMIT`               | `32`    | Maximum queued waiters per coordinator shard when backpressure is enabled. A full queue returns `503` with `Retry-After`.                                                          |
| `ASSET_COORDINATOR_PERMIT_INTERVAL_MS`        | `1600`  | Minimum spacing between upstream permits per coordinator shard when backpressure is enabled.                                                                                       |
| `ASSET_COORDINATOR_FALLBACK_COOLDOWN_SECONDS` | `30`    | Cooldown duration used when Roblox returns `429` without a usable `Retry-After` header.                                                                                            |
| `ASSET_COORDINATOR_OPERATION_DEADLINE_MS`     | `25000` | Request deadline passed to the coordinator for a miss resolution operation.                                                                                                        |
| `ASSET_COORDINATOR_RETRY_BASE_MS`             | `250`   | Base jittered delay before one retry of retryable upstream failures while backpressure is enabled.                                                                                 |
