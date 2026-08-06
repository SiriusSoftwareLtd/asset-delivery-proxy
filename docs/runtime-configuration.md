# Runtime Configuration

The Worker configuration is in [`../wrangler.jsonc`](../wrangler.jsonc). Before deploying a fork, create equivalent
Cloudflare resources and replace the binding identifiers in `wrangler.jsonc` with identifiers from your account.

## Bindings

| Binding                        | Type                          | Purpose                                                              | Billing and operational impact                                                                                                                                                                                            |
| ------------------------------ | ----------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assetCache`                   | Workers KV namespace          | Persistent asset and icon cache, including negative asset responses. | KV reads and writes are billable Cloudflare usage. Cache API L1 hits avoid KV reads; more persistent cache hits reduce Roblox upstream calls and Rate Limiting decisions, but successful writes store bytes and metadata. |
| `ASSET_PROXY_RATE_LIMITER`     | Workers Rate Limiting binding | Per-client request limiting.                                         | Limit checks are runtime binding operations. With `asset-cache-hit-exempt-limit` enabled, cache hits avoid this binding and only cold misses consume checks.                                                              |
| `ASSET_RESOLUTION_COORDINATOR` | Durable Object namespace      | Per-key coalescing, admission, retry, and cooldown state.            | Coordinator use can add Durable Object requests and active duration. See [`asset-rollout-flags.md`](./asset-rollout-flags.md) for the conditions under which foreground misses and stale refreshes use the coordinator.   |
| `ASSET_METRICS`                | Analytics Engine dataset      | Low-cardinality cache and resolution outcomes.                       | Each emitted datapoint contributes Analytics Engine ingest volume. Current Cloudflare docs state Workers Analytics Engine is not billed yet, but pricing is published ahead of future billing.                            |
| `FLAGS`                        | Cloudflare Flagship binding   | Controls asset-delivery rollout flags.                               | Flag evaluation may add provider-specific usage. See [`asset-rollout-flags.md`](./asset-rollout-flags.md) for flag behavior, dependencies, and rollout order.                                                             |

## Vars

The checked-in `vars` are non-secret runtime controls. Wrangler exposes them on `env`; invalid numeric values fall back to
the code defaults shown below. Do not put credentials in `vars`.

| Var                                           | Checked-in value | Accepted values                                                                     | Purpose                                                                                                                                                    | Billing and operational impact                                                                                                                                                                                                               |
| --------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OBSERVABILITY_REPORT_LEVEL`                  | `off`            | `off`, `error`, `warn`, `info`, or `debug`; missing or invalid values become `off`. | Gates custom application logs and trace spans. `info` enables request-completed logs and custom spans; `debug` includes every lower-severity custom event. | Cloudflare observability is enabled in `wrangler.jsonc`; raising this var increases retained/exported log and trace volume. Keep `off` for quiet production unless investigating an issue.                                                   |
| `ASSET_COORDINATOR_BUDGET_VERIFIED`           | `true`           | String `true` enables backpressure; every other value disables it.                  | Safety gate used by `asset-upstream-backpressure`.                                                                                                         | When disabled, coordinated backpressure is prevented from consuming Roblox quota or queueing Durable Object work under unverified capacity assumptions.                                                                                      |
| `ASSET_COORDINATOR_SHARDS`                    | `16`             | Integer `1` through `1024`; fallback `16`.                                          | Hashes each canonical cache key to `asset-shard-<n>` and spreads coordinated misses across Durable Object instances.                                       | More shards spread load and reduce per-object contention, but can create more active Durable Object instances and more distributed state. Aggregate upstream capacity is roughly `shards * concurrency` before permit spacing is considered. |
| `ASSET_COORDINATOR_CONCURRENCY`               | `1`              | Integer `1` through `32`; fallback `1`.                                             | Maximum active upstream resolutions per coordinator shard when backpressure is enabled.                                                                    | Raising it can increase Roblox request throughput and Durable Object active duration. Do not raise until the upstream API budget supports the aggregate capacity.                                                                            |
| `ASSET_COORDINATOR_QUEUE_LIMIT`               | `32`             | Integer `0` through `1000`; fallback `32`.                                          | Maximum queued waiters per coordinator shard when backpressure is enabled. A full queue returns `503` with `Retry-After`.                                  | Larger queues can smooth bursts but keep more callers waiting on Durable Object execution, increasing latency and potentially billed active duration.                                                                                        |
| `ASSET_COORDINATOR_PERMIT_INTERVAL_MS`        | `1600`           | Integer `0` through `60000`; fallback `1000`.                                       | Minimum spacing between upstream permits per coordinator shard when backpressure is enabled.                                                               | Lower values permit more upstream calls and can increase Roblox/API usage. Higher values reduce upstream pressure but increase queue time and timeout risk.                                                                                  |
| `ASSET_COORDINATOR_FALLBACK_COOLDOWN_SECONDS` | `30`             | Integer `1` through `3600`; fallback `30`.                                          | Cooldown duration used after Roblox returns `429` without a usable `Retry-After`.                                                                          | Longer cooldowns protect upstream quota and reduce retry churn, but can return `429` to users for longer. Shorter cooldowns may spend more upstream requests during a provider throttle window.                                              |
| `ASSET_COORDINATOR_OPERATION_DEADLINE_MS`     | `25000`          | Integer `1000` through `120000`; fallback `25000`.                                  | Deadline passed to the Durable Object for one miss-resolution operation, including queueing, upstream fetch, and retry.                                    | Longer deadlines can keep Durable Object work active longer and increase tail latency. Shorter deadlines fail faster with `504` and may reduce successful retries.                                                                           |
| `ASSET_COORDINATOR_RETRY_BASE_MS`             | `250`            | Integer `1` through `10000`; fallback `250`.                                        | Base jittered delay before one retry of retryable upstream failures while backpressure is enabled.                                                         | Higher values reduce immediate retry pressure but spend more request deadline. Lower values retry faster and can amplify upstream pressure during transient failures.                                                                        |

The checked-in coordinator values are operational settings, not claimed Roblox limits. Treat changes to any
`ASSET_COORDINATOR_*` var as an upstream-capacity and Durable Object cost review.

See [`asset-rollout-flags.md`](./asset-rollout-flags.md) for how these controls interact with the asset rollout flags.

## Observability

When `OBSERVABILITY_REPORT_LEVEL=off`, custom request-completion logging does not build its timing or event field object.

Setting `info` or a more verbose level enables the structured `request.completed` event and the corresponding custom
tracing behavior.

Cloudflare observability itself remains configured through `wrangler.jsonc`.

## Secrets

Do not commit credentials or API tokens. Store sensitive runtime values with Wrangler secrets and local `.dev.vars` or
`.env` files.

> **CI note:** GitHub Actions sets `ROBLOX_API_KEY` directly to the non-secret placeholder `ci-test-key` when running the test suite. CI does not read this value from repository variables and does not use a real Roblox Open Cloud API key. Real keys are required only for deployed runtime and production verification and must be stored as secrets.

| Secret           | Required | Purpose                                                                                                                                                                            | Billing and operational impact                                                                                                                                                |
| ---------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ROBLOX_API_KEY` | Yes      | Sent as the `x-api-key` header to Roblox's authenticated Open Cloud asset-delivery endpoint. Authentication headers are not forwarded to returned signed asset-download locations. | This controls access to the upstream Roblox API and any Roblox-side quotas or billing associated with that API key. Rotate it through Wrangler secrets, not committed config. |

```sh
pnpm exec wrangler secret put ROBLOX_API_KEY
```

## Related documentation

- [`asset-rollout-flags.md`](./asset-rollout-flags.md) — asset rollout behavior, flag dependencies, and coordinator traffic.
- [`api.md`](./api.md) — public API behavior, caching, and response contracts.
- [`cd-secrets.md`](./cd-secrets.md) — production deployment credentials and GitHub environment configuration.
