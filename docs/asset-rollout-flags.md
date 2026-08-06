# Asset Rollout Flags

This Worker uses Cloudflare Flagship boolean flags to roll out asset-delivery behavior without changing public routes,
headers, binding names, or request and response shapes.

All flags default to `false` in code. If Flagship evaluation fails, the Worker logs
`asset.flag.evaluation_failed` according to `OBSERVABILITY_REPORT_LEVEL` and continues with the `false` path.

The flags below affect only `GET /v1/assets/:assetId` and `POST /v1/assets/batch`. Icon routes do not use these rollout
flags.

Asset flags are evaluated lazily through a request-scoped policy snapshot. Each flag is evaluated at most once per asset
request, including a batch, and values are never reused across requests or isolates.

Coordinator and backpressure flags are evaluated only after the request reaches a stale-refresh or foreground-miss path
where they can affect behavior.

## Flag map

| Flag                           | Purpose                                                                                  | `false` behavior                                                                                                                                                           | `true` behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `use-asset-delivery-v2`        | Selects the Roblox asset-delivery protocol used to resolve a requested asset.            | Uses the established Roblox v1 asset-delivery request path and a v1 canonical cache key.                                                                                   | Uses Roblox v2 discovery, follows the first valid HTTPS location, forwards only allowlisted representation-affecting inputs, and varies the cache key by those inputs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `asset-cache-hit-exempt-limit` | Moves client rate limiting from every asset request to only cold miss resolution work.   | The Worker applies `ASSET_PROXY_RATE_LIMITER` before route handling for every `/v1/assets/` request, including cache hits.                                                 | Cache hits bypass the client rate-limit check. Cold misses still call `ASSET_PROXY_RATE_LIMITER` before contacting Roblox or the coordinator. A batch performs one lazy limit decision for its unique misses.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `asset-cache-layered`          | Enables the layered asset cache lifecycle on top of KV.                                  | The Worker reads KV only. Fresh KV hits return `X-Cache-Status: hit`; stale KV entries are treated as misses and refetched before responding.                              | The Worker checks `caches.default` as an L1 cache, returns `l1-hit` for fresh L1 bytes, returns `kv-fresh-hit` for fresh KV bytes and repopulates L1, and returns `stale-hit` for stale KV bytes while refreshing in the background through `ASSET_RESOLUTION_COORDINATOR`.                                                                                                                                                                                                                                                                                                                                                                   |
| `asset-upstream-coordinator`   | Routes foreground cold misses through the `ASSET_RESOLUTION_COORDINATOR` Durable Object. | Foreground cold misses resolve directly from Roblox in the request handler. Stale background refreshes still use the Durable Object when `asset-cache-layered` is enabled. | Foreground cold misses go through a shard-selected Durable Object that coalesces same-key concurrent work, rechecks KV, and centralizes upstream retry and cooldown state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `asset-upstream-backpressure`  | Enables coordinator admission control and retry behavior for upstream protection.        | The coordinator still coalesces requests when used, but does not acquire permits, queue callers, rate permits, enter cooldown, or retry transient upstream responses.      | The coordinator enforces permits, queue limits, permit spacing, persisted cooldown after upstream `429`, and one retry for retryable upstream failures when the request deadline allows it. Requires both `asset-upstream-coordinator` and `ASSET_COORDINATOR_BUDGET_VERIFIED=true`; otherwise foreground coordinated misses return `503` with `Retry-After: 60`. Stale refreshes run through the coordinator without backpressure only when `asset-upstream-coordinator` is off; when both flags are on but the budget is unverified, the stale response is served and the background refresh is rejected before Durable Object work starts. |

## Coordinator traffic

### Foreground cold misses

- `asset-upstream-coordinator` off → resolve directly from Roblox.
- `asset-upstream-coordinator` on → resolve through the Durable Object coordinator.

When `asset-upstream-backpressure` is also enabled, coordinator admission control requires
`ASSET_COORDINATOR_BUDGET_VERIFIED=true`.

If that safety gate is not enabled, foreground coordinated misses return `503` with `Retry-After: 60` instead of
performing unverified upstream work.

### Background stale refreshes

When `asset-cache-layered` is enabled, stale responses may be returned immediately while refresh work runs in the
background.

The refresh path behaves as follows:

- `asset-upstream-coordinator` and `asset-upstream-backpressure` on, but the budget gate is unverified → reject the
  refresh at admission without Durable Object work.
- Otherwise → use the Durable Object for distributed single-flight refresh coalescing.

Stale refresh backpressure is enabled only when all of these conditions are satisfied:

- `asset-upstream-coordinator` is enabled.
- `asset-upstream-backpressure` is enabled.
- `ASSET_COORDINATOR_BUDGET_VERIFIED=true`.

Enabling `asset-cache-layered` can therefore create Durable Object requests for stale background refreshes before
foreground coordinator rollout.

`asset-upstream-coordinator` still controls whether foreground cold misses use the coordinator.

## Rollout order

Enable the resilience flags in dependency order:

1. `asset-cache-hit-exempt-limit`
2. `asset-cache-layered`
3. `asset-upstream-coordinator`
4. `asset-upstream-backpressure`

`use-asset-delivery-v2` is independent from the resilience rollout. It can be enabled or disabled separately.

Enabling v2 changes cache identity because the v2 path accepts representation-affecting query parameters and headers.

## Runtime configuration

The rollout flags depend on runtime controls for coordinator capacity, deadlines, retries, permit spacing, and the
backpressure safety gate.

See [`runtime-configuration.md`](./runtime-configuration.md) for:

- Current checked-in `ASSET_COORDINATOR_*` values.
- Accepted ranges and code fallbacks.
- Binding configuration.
- Billing and operational impact.
- Secret configuration.

Runtime values should be maintained in `runtime-configuration.md` rather than duplicated here.

## Related documentation

- [`runtime-configuration.md`](./runtime-configuration.md) — bindings, runtime variables, checked-in values, and secrets.
- [`api.md`](./api.md) — public asset API behavior, caching, and response contracts.
