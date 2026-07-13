# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report privately via [GitHub Security Advisories](https://github.com/NodeOps-app/createos-sandbox-ghar/security/advisories/new), or email **security@nodeops.xyz**. We aim to acknowledge within 72 hours.

## Scope

This controller provisions VMs in response to GitHub webhooks and holds credentials that can create infrastructure. Findings we especially care about:

- Bypassing webhook authentication (`X-Hub-Signature-256` HMAC verification in `src/webhook.ts`).
- Bypassing the provisioning policy (`src/policy.ts`) — e.g. getting a non-allowlisted repo or an unapproved fork PR to boot a VM.
- Leaking the GitHub App private key, installation token, or CreateOS API key through logs, error messages, or alert payloads.
- Escaping the concurrency cap (`MAX_CONCURRENT`) or leaking VMs that are never torn down.

## Operator responsibilities

- `PROVISION_POLICY=org-wide` serves **every** repo in the org, including fork pull requests. Safety rests on microVM isolation and ephemerality. Set a finite `MAX_CONCURRENT`, and prefer `repo-allowlist` or `fork-gated` for public repos.
- Secrets belong in `wrangler secret`, never in `wrangler.toml`.
- Rotate the GitHub App private key and the CreateOS API key if this Worker's configuration is ever exposed.
