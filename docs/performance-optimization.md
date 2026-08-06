# Worker cost and performance optimization

This page records the repository-local behavior and verification for the cost-focused changes on this branch. Local
timings are directional; production CPU, Cache API, KV, Durable Object, Analytics Engine, and upstream metrics remain
the authority for billing and traffic decisions.

## Retained optimizations

- Asset Flagship policy is request-scoped, lazy, and memoized. A batch does not reevaluate request-invariant flags for
  each item, and coordinator/backpressure policy is skipped on paths where it cannot affect the result.
- Rate-limit middleware is reused per binding identity. Rate-limit decisions and lazy miss exemption semantics are
  unchanged.
- Positive icons use the Cache API as a data-center-local L1 before Workers KV. L1 failures fall back to KV, and fresh
  KV hits populate L1 asynchronously.
- Identical icon misses are isolate-local single-flighted. Duplicate normalized icon batch entries reuse parsing,
  cache, upstream/render, write, and base64 work while preserving ordered output.
- Asset and icon batch output reuses base64 serialization only for equivalent result byte ownership.
- resvg WASM initialization is lazy and concurrency-safe. It does not initialize for health, root, asset, cached-icon,
  or Rayfield PNG requests. The renderer boundary retains the required PNG ownership copy before freeing WASM data.
- Disabled request-completion reporting avoids constructing timing and field objects; enabled structured events remain
  unchanged.

## Verification evidence

The branch added deterministic regression coverage for policy evaluation counts, Cache API L1 fallback and KV usage,
duplicate batches, concurrent icon misses, lazy WASM initialization, and rendering/cache failure behavior.

The completed local gates were:

```sh
pnpm typecheck
pnpm lint
pnpm coverage
```

The final local suite reported 27 test files and 345 passing tests with coverage thresholds satisfied. Wrangler dry-run
measurements were also captured before and after the implementation:

| Measurement | Before | After |
| --- | ---: | ---: |
| Total upload | 2500.84 KiB | 2503.33 KiB |
| Gzip upload | 955.06 KiB | 955.73 KiB |
| Local startup profile window | 12.8 ms | 11.4 ms |
| Local startup active time | 2.6 ms | 1.4 ms |

The startup profile is machine-dependent and is not evidence of a production CPU reduction. The small bundle increase
comes from retained caching and policy abstractions; no dependency or compatibility-mode change was justified.

## Deferred decisions

- Durable Object shard count, permit spacing, queue limits, concurrency, retry policy, and cooldown persistence require
  production traffic and quota evidence. They were not changed because local benchmarks cannot establish a safe billing
  trade without weakening upstream protection.
- The binary encoding path, asset hash conversion, cache metadata construction, and bounded extension sniffing were not
  changed because no measured material hotspot justified added complexity or a possible ownership regression.
- Icon negative caching was not added because the current icon path has no persisted negative metadata contract.
- Hono, resvg, `nodejs_compat`, and dependencies were retained because the dry-run bundle did not show a safe material
  reduction from replacing or narrowing them.

For public API details, see [`api.md`](./api.md). For runtime bindings and observability controls, see
[`runtime-configuration.md`](./runtime-configuration.md). For asset rollout dependencies, see
[`asset-rollout-flags.md`](./asset-rollout-flags.md).
