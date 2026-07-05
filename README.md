# createos-sandbox-ghar

Ephemeral GitHub Actions runner autoscaler for the `nodeops-app` org, on createos microVMs. One VM per job, torn down when the job finishes. See `CONTEXT.md` (glossary) and `docs/adr/` (decisions).

## How it works

`workflow_job` webhook → Worker verifies HMAC, filters `runs-on: [createos]` + policy → Coordinator DO (SQLite) tracks state → Worker mints a JIT runner config, boots a sandbox from the `ghar-runner` template, launches the runner detached. Teardown: `completed` webhook destroys the VM; the runner also `halt`s on exit (fc liveness reap); a 5-min cron sweeps orphans.

## Setup

### 1. GitHub App (org `nodeops-app`)
- Permissions: **Organization → Self-hosted runners: Read & write**, **Repository → Actions: Read**.
- Subscribe to event: **Workflow job**.
- Webhook URL: `https://<worker>.workers.dev/webhook`, secret = `GITHUB_WEBHOOK_SECRET`.
- Install on the org; note the **App ID** and **Installation ID**.
- Generate a private key; convert PKCS#1 → PKCS#8:
  `openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in app.pem -out app.pkcs8.pem`

### 2. Build the runner template
`CREATEOS_BASE_URL=... CREATEOS_API_KEY=... bun run template/build.ts` → set `RUNNER_TEMPLATE`.

### 3. Deploy
```bash
wrangler secret put GITHUB_APP_ID
wrangler secret put GITHUB_INSTALLATION_ID
wrangler secret put GITHUB_APP_PRIVATE_KEY   # paste PKCS#8 PEM
wrangler secret put GITHUB_WEBHOOK_SECRET
wrangler secret put CREATEOS_API_KEY
# edit wrangler.toml [vars] for CREATEOS_BASE_URL, RUNNER_TEMPLATE, etc.
bun run deploy
```

### 4. Use it
In any `nodeops-app` repo workflow:
```yaml
jobs:
  build:
    runs-on: [createos]
    steps: [ ... ]
```

## Config reference
| Var | Secret? | Default | Meaning |
| --- | --- | --- | --- |
| GITHUB_ORG | no | nodeops-app | org served |
| GITHUB_APP_ID / INSTALLATION_ID | yes | — | App identity |
| GITHUB_APP_PRIVATE_KEY | yes | — | PKCS#8 PEM |
| GITHUB_WEBHOOK_SECRET | yes | — | HMAC secret |
| CREATEOS_BASE_URL | no | — | control plane URL |
| CREATEOS_API_KEY | yes | — | createos key |
| RUNNER_LABEL | no | createos | opt-in label |
| RUNNER_TEMPLATE | no | ghar-runner | rootfs template |
| RUNNER_SHAPE | no | s-4vcpu-4gb | VM size |
| RUNNER_DISK_MIB | no | 30720 | overlay disk |
| MAX_CONCURRENT | no | 0 | 0 = unlimited; N = cap + pending queue |
| PROVISION_POLICY | no | org-wide | org-wide / repo-allowlist / fork-gated |
| REPO_ALLOWLIST | no | — | csv, for repo-allowlist |
| REAPER_MAX_AGE_MS | no | 3600000 | orphan cutoff |

## Development
```bash
bun run test        # vitest (unit + real-DO integration)
bun run typecheck   # tsc --noEmit
bun run lint        # oxlint
bun run dev         # wrangler dev
```

## Security notes
- Default `org-wide` + `MAX_CONCURRENT=0` is wide open — set `MAX_CONCURRENT` and consider `fork-gated`/`repo-allowlist` before pointing at public repos. Fork-PR safety under org-wide rests on VM isolation + ephemerality.
- Stays within the Cloudflare Workers **Free** plan (SQLite DO, hibernating). See `docs/adr/0002`.
