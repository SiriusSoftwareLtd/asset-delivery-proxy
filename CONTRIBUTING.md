# Contributing to Asset Delivery Proxy

Thank you for contributing. This project welcomes bug fixes, tests, documentation improvements, and focused feature proposals.

## Before you start

1. Search existing issues and pull requests for related work.
2. Open an issue before beginning a substantial feature or behavior change so maintainers can confirm the direction.
3. Keep changes narrow. Avoid unrelated refactors in a bug-fix or feature pull request.

## Local setup

Install dependencies:

```sh
pnpm install
```

Run the Worker locally:

```sh
pnpm dev
```

The project relies on Cloudflare bindings configured in `wrangler.jsonc`. Use bindings from your own Cloudflare account when testing deployed behavior.

Never add API tokens, secrets, private asset data, or production resource configuration to commits.

## Validation

Before opening a pull request, run the same core checks used by CI:

```sh
pnpm typecheck
pnpm lint
pnpm coverage
```

These commands verify:

- TypeScript source, tests, and repository tooling.
- Biome lint and formatting rules.
- Automated tests and configured coverage thresholds.

Fix failures before submitting the pull request.

## Continuous integration

GitHub Actions runs type checking, Biome checks, and the coverage suite for every branch push and when pull requests are opened, updated, or reopened. Successful checks are reused for the same commit to avoid duplicate CI work.

CI sets `ROBLOX_API_KEY` to the non-secret placeholder `ci-test-key`. CI does not use a real Roblox Open Cloud API key.

Production and live verification require a real `ROBLOX_API_KEY`. Store real credentials with Wrangler secrets or the appropriate GitHub environment secret.

Never commit credentials or store secrets as repository variables.

## Making a change

- Use TypeScript and follow the existing formatting and naming conventions.
- Add or update tests for behavior changes, especially around request validation, caching, rate limiting, upstream failures, and icon delivery.
- Keep refactors separate from unrelated behavior changes where practical.
- Run `pnpm cf-typegen` after changing Cloudflare bindings and commit the resulting `worker-configuration.d.ts` update.
- Update `docs/api.md` when public HTTP behavior changes.
- Update `docs/runtime-configuration.md` when bindings, variables, secrets, or runtime settings change.
- Update `docs/asset-rollout-flags.md` when asset resilience flags or rollout behavior change.
- Update `docs/cd-secrets.md` when production deployment requirements change.
- Update the README when repository setup, deployment, development commands, or the high-level API overview changes.

Do not edit `worker-configuration.d.ts` by hand. Wrangler generates this file from the current Worker configuration.

## Commit messages

Use the [Conventional Commits](https://www.conventionalcommits.org/) format and include an appropriate [Gitmoji](https://gitmoji.dev/) in every commit subject:

```text
type(scope): gitmoji short imperative summary
```

For example:

```text
feat(worker): ✨ Add icons URL resolver
```

Choose a conventional type that reflects the change, such as:

- `feat`
- `fix`
- `docs`
- `test`
- `refactor`
- `build`
- `ci`
- `chore`

Include a scope when it makes the affected area clearer.

## Pull requests

Keep each pull request focused and easy to review.

A pull request should:

- Use a clear title that follows the repository's commit naming conventions.
- Explain what changed and why.
- Describe any user-visible or operational effects.
- Link the relevant issue when one exists.
- Explain how the change was validated.
- Include tests for behavior changes.
- Update relevant documentation.
- Avoid unrelated source, configuration, or formatting changes.
- Avoid committed secrets, tokens, private asset data, or production configuration.

Large refactors should be submitted separately from feature and bug-fix work unless the refactor is required for the change.

## Cloudflare configuration

Worker configuration lives in `wrangler.jsonc`.

After changing bindings or generated Cloudflare types, run:

```sh
pnpm cf-typegen
pnpm typecheck
```

Commit the updated `worker-configuration.d.ts` with the configuration change.

Do not place real credentials directly in `wrangler.jsonc`.

## Production verification

Changes that affect production asset delivery may also require live verification.

Create a local fixture file from:

```sh
cp scripts/verify-production.assets.example.json scripts/verify-production.assets.json
```

Then run the production verifier with the required environment configuration:

```sh
pnpm verify:production
```

Do not commit `scripts/verify-production.assets.json`, private asset IDs, or production credentials.

## Security

Do not report security vulnerabilities through public GitHub issues, discussions, or pull requests.

Follow [`SECURITY.md`](./SECURITY.md) and use GitHub Private Vulnerability Reporting.

## Code of Conduct

By contributing, you agree to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

## License

Contributions are licensed under the [Mozilla Public License Version 2.0](./LICENSE).
