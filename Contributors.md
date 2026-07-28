# Contributing to Asset Delivery Proxy

Thank you for contributing. This project welcomes bug fixes, tests, documentation improvements, and focused feature proposals.

## Before you start

1. Search existing issues and pull requests for related work.
2. Open an issue before beginning a substantial feature or behavior change so maintainers can confirm the direction.
3. Keep changes narrow: avoid drive-by refactors in a bug-fix pull request.

## Local setup

```sh
pnpm install
pnpm test
```

Use `pnpm dev` to run the Worker locally. The project relies on Cloudflare bindings configured in `wrangler.jsonc`; use bindings from your own Cloudflare account when testing deployed behavior. Never add API tokens, secrets, or private resource data to commits.

## Making a change

- Use TypeScript and follow the existing formatting and naming conventions.
- Add or update tests for behavior changes, especially around request validation, caching, rate limiting, and upstream failures.
- Run `pnpm test` before opening a pull request.
- Run `pnpm cf-typegen` after changing Cloudflare bindings, then include the generated `worker-configuration.d.ts` update.
- Update the README when changing public API behavior, configuration, or operational requirements.

## Commit messages

Use the [Conventional Commits](https://www.conventionalcommits.org/) format and include an appropriate [Gitmoji](https://gitmoji.dev/) in every commit subject:

```text
type(scope): gitmoji short imperative summary
```

For example: [`feat(worker): ✨ Adding icons url resolver`](https://github.com/SiriusSoftwareLtd/asset-delivery-proxy/commit/6874bd8a795cb0e194ca7431b8fe6eb6a8eef6d0).

Choose a conventional type that reflects the change, such as `feat`, `fix`, `docs`, `test`, `refactor`, `build`, or `chore`. Include a scope when it makes the affected area clearer.

## Pull requests

Please make each pull request easy to review:

- Use a clear title and describe the user-visible effect.
- Explain how you tested the change.
- Link the relevant issue when one exists.
- Include only source, test, and documentation changes that are necessary for the proposal.
- Be ready to address review feedback or explain intentional trade-offs.

By contributing, you agree to follow the [Code of Conduct](./CODE_OF_CONDUCT.md). Licensing terms for contributions will apply once the repository license is published.
