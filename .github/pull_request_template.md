## Summary

<!-- What does this change do, and why? -->

## Related issue

<!-- Link the issue this pull request addresses, when applicable. -->

Closes #

## Validation

<!-- List the commands run and any manual checks performed. -->

```text
pnpm typecheck
pnpm lint
pnpm coverage
```

## Documentation

<!-- List documentation updated by this change, or explain why no documentation update is required. -->

## Checklist

- [ ] I kept this change focused and avoided unrelated refactors.
- [ ] I added or updated tests for behavior changes.
- [ ] I ran `pnpm typecheck`.
- [ ] I ran `pnpm lint`.
- [ ] I ran `pnpm coverage`.
- [ ] I regenerated `worker-configuration.d.ts` if Cloudflare bindings changed.
- [ ] I updated `docs/api.md` if public HTTP behavior changed.
- [ ] I updated other relevant documentation if configuration or operational behavior changed.
- [ ] I did not commit secrets, tokens, private asset data, or production configuration.
