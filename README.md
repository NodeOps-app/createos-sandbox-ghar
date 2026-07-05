# createos-sandbox-ghar

Ephemeral GitHub Actions runner autoscaler for the `nodeops-app` org, on createos microVMs. One VM per job, torn down when the job finishes. See `CONTEXT.md` (glossary), `docs/adr/` (decisions), and `CLAUDE.md` (contributor/agent guide).

## How it works

`workflow_job` webhook → Worker verifies HMAC, filters `runs-on: [createos]` + policy → Coordinator Durable Object (SQLite) tracks state → Worker mints a JIT runner config, boots a sandbox from the `ghar-runner` template, launches the runner detached. Teardown: the `completed` webhook destroys the VM (primary); a 5-minute cron reaps any orphan older than `REAPER_MAX_AGE_MS`. The in-guest self-halt is best-effort — see [Teardown](#teardown).

```
GitHub ──webhook──▶ Worker (/webhook) ──▶ Coordinator DO (SQLite state)
                        │
                        ├─ mint JIT config (GitHub App)
                        └─ createSandbox(template) ─▶ createos microVM ──runner──▶ GitHub
```

---

## Prerequisites

- **bun** ≥ 1.3 (`curl -fsSL https://bun.sh/install | bash`). This project uses bun exclusively — no npm/node.
- A **Cloudflare account** (Workers **Free** plan is enough — the controller is designed to stay within it) + `wrangler` (bundled as a dev dependency; run via `bun run` / `node_modules/.bin/wrangler`).
- Admin on the **`nodeops-app` GitHub org** (to create + install a GitHub App).
- A **createos control plane** URL + API key (to build the runner template and boot sandboxes).
- The **`@nodeops-createos/sandbox` SDK** checked out as a sibling directory at `../fc-sdk` (it is unpublished and consumed via `bun link`).

---

## Step-by-step setup

### 1. Clone + install

```bash
git clone <this-repo> createos-sandbox-ghar
cd createos-sandbox-ghar

# The SDK is a linked sibling checkout, not an npm package:
cd ../fc-sdk && bun link && cd -
bun link @nodeops-createos/sandbox

bun install
```

Verify the toolchain is healthy:

```bash
bun run lint && bun run typecheck && bun run test    # expect: 47 tests pass
```

> If installs misbehave, see the "Toolchain gotchas" section in `CLAUDE.md` (pinned versions are deliberate — do not upgrade `vitest`/`vitest-pool-workers`).

### 2. Create the GitHub App (org `nodeops-app`)

Settings → Developer settings → GitHub Apps → **New GitHub App**:

- **Permissions**
  - Organization → **Self-hosted runners: Read & write** (needed to mint JIT runner configs).
  - Repository → **Actions: Read** (needed for the `fork-gated` policy; harmless otherwise).
- **Subscribe to events**: **Workflow job**.
- **Webhook**
  - URL: `https://<your-worker-subdomain>.workers.dev/webhook` (fill in after step 5, or set now and redeploy).
  - Secret: a strong random string — this becomes `GITHUB_WEBHOOK_SECRET`.
- Create the App, then **Install** it on the `nodeops-app` org (all repos, or a subset).
- Record the **App ID** and the **Installation ID** (the installation id is in the URL of the installation settings page: `.../installations/<ID>`).

Generate a private key (App settings → **Generate a private key**) — it downloads a PKCS#1 `.pem`. Convert to PKCS#8 (Web Crypto requires PKCS#8):

```bash
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in app.pem -out app.pkcs8.pem
```

Keep `app.pkcs8.pem` — you paste its contents in step 4.

### 3. Build the runner template

Builds a rootfs image with the Actions runner + docker + git baked in, named `ghar-runner`:

```bash
CREATEOS_BASE_URL=https://<control-plane> \
CREATEOS_API_KEY=<key> \
bun run build:template
```

The build **auto-pulls the latest `actions/runner` release** (GitHub deprecates old runners and refuses their jobs), injects it into `template/Dockerfile`, deletes any existing `ghar-runner` template, and rebuilds. Wait for `ready: <id>`. Set `RUNNER_TEMPLATE` to that name in `wrangler.toml` (default is already `ghar-runner`). Adjust `template/Dockerfile`'s `FROM` if the base image differs for your control plane — confirm it against `client.listRootfs()`. See [Keeping the runner current](#keeping-the-runner-current) for the daily auto-bump.

### 4. Configure secrets + vars

Non-secret config lives in `wrangler.toml [vars]` — edit `CREATEOS_BASE_URL`, `RUNNER_TEMPLATE`, and any policy/size knobs (see the reference table below).

Secrets go through `wrangler secret` (never in `wrangler.toml`):

```bash
bun run wrangler secret put GITHUB_APP_ID           # the App ID number
bun run wrangler secret put GITHUB_INSTALLATION_ID  # the Installation ID number
bun run wrangler secret put GITHUB_APP_PRIVATE_KEY  # paste the full contents of app.pkcs8.pem
bun run wrangler secret put GITHUB_WEBHOOK_SECRET   # the webhook secret from step 2
bun run wrangler secret put CREATEOS_API_KEY        # createos control-plane key
```

For local `wrangler dev`, copy `.dev.vars.example` → `.dev.vars` and fill the same values (`.dev.vars` is gitignored).

### 5. Deploy

```bash
bun run deploy
```

Note the deployed URL and make sure it matches the GitHub App webhook URL from step 2 (update + redeploy if needed). Confirm the Durable Object migration + cron trigger were applied (deploy output lists them).

### 6. Verify end-to-end

- Health: `curl https://<worker>.workers.dev/health` → `ok`.
- Redeliver a `workflow_job` from the GitHub App's **Advanced → Recent Deliveries** and confirm a `202` response.
- Add a job to a `nodeops-app` repo and watch a sandbox boot + the job run:

```yaml
jobs:
  build:
    runs-on: [createos]
    steps:
      - run: echo "hello from a createos microVM"
```

---

## Config reference

| Var | Secret? | Default | Meaning |
| --- | --- | --- | --- |
| GITHUB_ORG | no | nodeops-app | org served (matched case-insensitively) |
| GITHUB_API_URL | no | https://api.github.com | override for GitHub Enterprise / tests |
| GITHUB_APP_ID | yes | — | App identity |
| GITHUB_INSTALLATION_ID | yes | — | org installation id (**numeric**, not the App client id) |
| GITHUB_APP_PRIVATE_KEY | yes | — | **PKCS#8** PEM (convert from GitHub's PKCS#1) |
| GITHUB_WEBHOOK_SECRET | yes | — | webhook HMAC secret |
| CREATEOS_BASE_URL | no | — | control plane URL |
| CREATEOS_API_KEY | yes | — | createos key |
| RUNNER_LABEL | no | createos | opt-in `runs-on` label |
| RUNNER_TEMPLATE | no | ghar-runner | rootfs template id/name |
| RUNNER_SHAPE | no | s-4vcpu-4gb | VM size |
| RUNNER_DISK_MIB | no | 30720 | overlay disk (MiB) — must be ≤ your createos plan's cap |
| MAX_CONCURRENT | no | 0 | 0 = unlimited; N = cap + pending queue |
| PROVISION_POLICY | no | org-wide | org-wide / repo-allowlist / fork-gated |
| REPO_ALLOWLIST | no | — | csv of `owner/repo`, used when policy=repo-allowlist |
| REAPER_MAX_AGE_MS | no | 3600000 | orphan sandbox cutoff — keep **above your longest job** |
| ALERT_WEBHOOK_URL | yes | — | optional Slack-style webhook; posts on provision failure |

## Development

```bash
bun run test        # vitest (unit + real-DO integration, 47 tests)
bun run typecheck   # tsc --noEmit
bun run lint        # oxlint
bun run dev         # wrangler dev (needs .dev.vars)
```

See `CLAUDE.md` for architecture, file responsibilities, testing approach, and toolchain gotchas.

## Teardown

A VM is destroyed by, in order of reliability:

1. **`completed` webhook (primary).** When the job finishes, GitHub sends `workflow_job.completed`; the Worker looks up the sandbox recorded for that job and destroys it. This is the normal path and fires within seconds.
2. **Reaper cron (safety net).** Every 5 minutes a cron trigger sweeps sandboxes older than `REAPER_MAX_AGE_MS` whose completion was never recorded (e.g. a dropped webhook). The cutoff **must stay above your longest job** — the reaper can't distinguish a busy VM from an orphan, it only sees age.
3. **In-guest self-halt (best-effort, currently a no-op).** `start-runner.sh` attempts `halt`/`poweroff`/sysrq after the runner exits, but the minimal `nodeops/sandbox:debian` base has no `halt`/`poweroff` binary and firecracker ignores the sysrq poweroff, so this does **not** currently shut the VM down. Teardown therefore relies on layers 1–2. A proper in-guest self-destruct is tracked upstream at [`NodeOps-app/fc#520`](https://github.com/NodeOps-app/fc/issues/520).

> Edge case: an ephemeral runner takes the **first** matching queued job, which may differ from the job that provisioned its VM if a backlog exists. The `completed` webhook keys teardown on the provisioning job, so under a backlog a VM can be missed by layer 1 — the reaper (layer 2) still collects it. At steady state (one queued job → one VM) this doesn't arise.

## Keeping the runner current

GitHub deprecates old runner versions and **refuses their jobs** ("runner version deprecated, cannot receive messages"), so the baked runner must be kept fresh:

- `bun run build:template` always builds the **latest** `actions/runner` release (see step 3).
- `.github/workflows/bump-runner.yml` runs **daily**: it compares the latest release to the Dockerfile's pinned version and, only if they differ, rebuilds the `ghar-runner` template via the createos CLI and commits the bump. It needs a repo secret **`CREATEOS_API_KEY`**. Manually: Actions → **bump-runner** → **Run workflow**.

## Alerting

Provision failures are logged (`console.error`, visible via `wrangler tail`). To get pushed alerts, set an optional **`ALERT_WEBHOOK_URL`** secret to a Slack (or Slack-compatible) incoming webhook:

```bash
bun run wrangler secret put ALERT_WEBHOOK_URL   # https://hooks.slack.com/services/...
```

When set, the Worker POSTs `{ "text": "ghar provision failed — job <id> (<repo>): <error>" }` on every failed provision. Unset = no-op. The same `notify()` helper (`src/notify.ts`) can be dropped into other paths (e.g. reaper teardown failures) if you want broader coverage. For infra-level signals (Worker exceptions, cron failures), also wire Cloudflare's built-in **Workers → Observability/Notifications** or Logpush.

## Security notes

- `PROVISION_POLICY=org-wide` serves **every** repo in the org, including fork PRs; fork-PR safety then rests entirely on VM isolation + ephemerality (each job gets a throwaway KVM VM; GitHub withholds secrets from fork PRs unless approved). `MAX_CONCURRENT` caps the blast radius (set to a finite value in prod — `0` means unlimited). For tighter control use `repo-allowlist` or `fork-gated` (the latter checks the run's head repo via the GitHub API).
- Runs within the Cloudflare Workers **Free** plan: SQLite-backed Durable Object, kept hibernation-eligible, blocking I/O done in the Worker. See `docs/adr/0002`.
- The webhook is authenticated by `X-Hub-Signature-256` HMAC; unsigned/invalid requests get `401`.
- Never put secret values in `wrangler.toml` — use `wrangler secret`. `.env*` and `.dev.vars` are gitignored.
