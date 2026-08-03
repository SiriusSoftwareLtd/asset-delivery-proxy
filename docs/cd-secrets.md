# CD secrets

The CD workflow deploys the Worker after the `CI` workflow succeeds for a push to `main`. Configure these GitHub
repository secrets before enabling automated deployment:

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account ID that owns the Worker and configured bindings. |
| `CLOUDFLARE_API_TOKEN` | A Cloudflare user API token for non-interactive Wrangler deployment. |

Create the API token from the Cloudflare dashboard's account API tokens page. Use the **Edit Cloudflare Workers** custom
permission template as the baseline, then scope resources as narrowly as possible:

- Account resources: restrict to the account named by `CLOUDFLARE_ACCOUNT_ID`.
- Zone resources: restrict to the zones this Worker uses, or omit zone access if no Worker routes/custom domains are
  managed by this deployment.

## `CLOUDFLARE_API_TOKEN` permissions

These permissions are required for this repository's current deploy path, where the CD workflow runs `pnpm deploy`, which
executes `wrangler deploy` against the checked-in [`wrangler.jsonc`](../wrangler.jsonc).

### Account: `Workers Scripts: Edit`

This is the primary deployment permission for Workers. Wrangler uses it to upload the bundled Worker code and Worker
metadata, then create the new Worker version/deployment.

For this repository, the uploaded metadata includes the configured bindings, Durable Object migration declarations,
compatibility settings, observability settings, rules, vars, required secret declarations, and source map upload setting.

### Account: `Workers KV Storage: Edit`

The Worker binds the `assetCache` KV namespace in `wrangler.jsonc`. Wrangler and the Workers API use this permission to
resolve and attach that configured KV namespace during deployment.

Keep this permission while the Worker has `kv_namespaces` bindings.

### Account: `Account Settings: Read`

Wrangler must operate against the account named by `CLOUDFLARE_ACCOUNT_ID`. It uses this permission to read account-level
metadata needed to validate the selected account and deploy into that account.

### User: `User Details: Read`

Cloudflare user API tokens are tied to a user identity. Cloudflare uses this permission to identify the token owner during
non-interactive API authentication.

### User: `Memberships: Read`

The deploying user must be a member of the target account. Cloudflare uses this permission to verify that the token owner
has access to the account in `CLOUDFLARE_ACCOUNT_ID`.

Do not add zone permissions for this repository unless deployment starts managing Worker routes or custom domains. If that
happens, add `Workers Routes: Edit` scoped only to the affected zone or zones so Wrangler can create or update the route
mapping.

Add more account-level product permissions only when `wrangler.jsonc` starts managing those resources directly. For
example, add `Workers R2 Storage: Edit` for R2 bindings or the relevant D1/Queues/Vectorize permissions for those
products. Remove unused permissions from the token when the corresponding binding or route management is removed.

Do not use a global API key. Rotate `CLOUDFLARE_API_TOKEN` if it is exposed, and do not store it in the repository or
local config files.
