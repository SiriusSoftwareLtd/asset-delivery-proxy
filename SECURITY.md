# Security Policy

## Reporting a vulnerability

Do not report security vulnerabilities through public GitHub issues, discussions, pull requests, or other public channels.

Use GitHub Private Vulnerability Reporting instead:

1. Open the repository's **Security** tab.
2. Open **Advisories**.
3. Select **Report a vulnerability**.
4. Submit the report with enough information for maintainers to reproduce and assess the issue.

Include:

- A clear description of the vulnerability.
- The affected endpoint, component, or configuration.
- Reproduction steps or a minimal proof of concept.
- The expected and observed behavior.
- The potential security impact.
- Any relevant logs or request and response data after removing secrets and personal data.
- Suggested remediation, if known.

Do not include:

- API keys, tokens, cookies, or other credentials.
- Private Roblox asset IDs unless they are required to reproduce the issue.
- Cloudflare credentials or private resource identifiers that are not required for the report.
- Production user data.
- Unrelated sensitive information.

If GitHub Private Vulnerability Reporting is unavailable, contact the SiriusSoftwareLtd maintainers privately through the organization rather than opening a public issue.

## Scope

Security reports related to the following areas are in scope:

- Asset and icon request validation.
- Authentication and authorization handling.
- Roblox Open Cloud credential handling.
- Upstream request construction and redirect handling.
- Server-side request forgery or unintended upstream access.
- Cache poisoning or cache-key confusion.
- Workers KV and Cache API behavior that could expose or mix data.
- Durable Object coordination and isolation.
- Rate limiting and abuse controls.
- Request smuggling or malformed HTTP handling.
- Unsafe parsing or rendering of upstream icon content.
- Resource exhaustion or denial-of-service conditions caused by bounded request paths.
- Secret handling and deployment configuration.
- GitHub Actions and deployment supply-chain security.
- Cloudflare Worker configuration that could expose protected resources.

Reports about vulnerabilities that exist only in a third-party service or dependency should also be reported to the relevant upstream provider.

## Testing guidelines

Security research must avoid unnecessary impact to production systems.

Do not:

- Degrade or intentionally interrupt the production service.
- Perform sustained denial-of-service testing.
- Attempt to access data that does not belong to you.
- Use compromised credentials.
- Exfiltrate secrets or private user data.
- Persist access after demonstrating a vulnerability.
- Publicly disclose an unresolved vulnerability before maintainers have had a reasonable opportunity to address it.

Use the smallest number of requests needed to demonstrate the issue.

If a vulnerability can be reproduced against a local or isolated deployment, prefer that environment over production.

## Response process

Maintainers will review private reports and determine whether they affect the supported service.

For accepted reports, maintainers will:

1. Assess severity and affected components.
2. Reproduce the issue where practical.
3. Develop and validate a remediation.
4. Coordinate deployment of the fix.
5. Determine whether additional hardening, monitoring, or documentation changes are required.
6. Coordinate disclosure when appropriate.

Response and remediation times depend on severity, complexity, and required coordination. Do not treat acknowledgement or remediation estimates as disclosure deadlines unless maintainers explicitly agree to them.

## Disclosure

Keep vulnerability details private until maintainers confirm that disclosure is appropriate.

When warranted, SiriusSoftwareLtd may publish a GitHub Security Advisory or another notice describing the affected versions, impact, remediation, and any required operator action.

Reports may be credited with the researcher's permission.
