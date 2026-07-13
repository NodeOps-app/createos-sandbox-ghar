<div align="center">

# createos-sandbox-ghar

**Ephemeral GitHub Actions self-hosted runners on [CreateOS Sandbox](https://createos.sh) microVMs.**

One throwaway KVM microVM per job. Booted when a job is queued, destroyed seconds after it finishes.
The whole controller is a single Cloudflare Worker + one SQLite Durable Object — it fits in the free plan.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/NodeOps-app/createos-sandbox-ghar/actions/workflows/ci.yml/badge.svg)](https://github.com/NodeOps-app/createos-sandbox-ghar/actions/workflows/ci.yml)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers%20Free-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Runtime: bun](https://img.shields.io/badge/runtime-bun-000?logo=bun&logoColor=white)](https://bun.sh)

</div>

---

## What you get

```yaml
jobs:
  build:
    runs-on: [createos]      # ← that's it
    steps:
      - run: echo "hello from a fresh microVM"
```

| | |
| --- | --- |
| **Clean machine every job** | Each job gets its own microVM from a pre-baked rootfs. No leftover state, no cross-job contamination, no runner cleanup steps. |
| **Real isolation for untrusted code** | KVM microVM boundary, not a shared container. Fork PRs, `npm install`, `docker build` — all confined to a VM that ceases to exist afterwards. |
| **Zero idle cost** | Nothing is running between jobs. No warm pool, no idle runner VMs, no autoscaler to babysit. |
| **Fast teardown** | The guest self-deletes its own VM the moment the runner exits — it doesn't wait for a webhook round trip. |
| **Free-plan control plane** | Cloudflare Workers Free + one SQLite Durable Object. No Kubernetes, no controller VM, no database to run. |
| **Self-healing** | A 5-minute cron reconciles against GitHub: re-drives jobs whose webhook was lost, reaps VMs whose runner never came online. |

This repo is both a working autoscaler and a reference example of building on the CreateOS Sandbox SDK.

## How it works

```mermaid
flowchart LR
    GH[GitHub<br/>workflow_job] -->|webhook| W[Cloudflare Worker]
    W -->|verify HMAC<br/>label + policy filter| DO[(Coordinator DO<br/>SQLite state)]
    W -->|mint JIT runner config| GHA[GitHub App API]
    W -->|createSandbox| VM[CreateOS microVM<br/>ghar-runner rootfs]
    VM -->|registers + runs job| GH
    VM -.->|runner exits →<br/>self-delete| VM
    GH -->|completed webhook| W
    CRON([cron */5]) -->|reconcile + reap| W
```

1. A `workflow_job.queued` webhook arrives. The Worker verifies the HMAC signature, keeps only jobs labelled `runs-on: [createos]`, and applies the provisioning policy.
2. The **Coordinator** Durable Object records the job, enforces `MAX_CONCURRENT`, and queues the overflow.
3. The Worker mints a **JIT runner config** via the GitHub App, boots a sandbox from the `ghar-runner` template, and launches the runner detached. Ownership is recorded in the DO *before* launch, so a VM can never be leaked by a race.
4. The runner takes the job, runs it, and exits — **ephemeral**, so it deregisters itself.
5. Teardown happens in three layers (see [Teardown](#teardown)): the guest deletes its own VM in seconds, the `completed` webhook frees the concurrency slot and confirms the destroy, and a cron sweeps anything that fell through.

## Prerequisites

- **[bun](https://bun.sh)** ≥ 1.3 — this project is bun-only (no npm/node).
- A **Cloudflare account** — the Workers **Free** plan is enough.
- A **CreateOS Sandbox** account: control-plane URL + API key ([createos.sh](https://createos.sh)).
- **Admin on a GitHub org** — to create and install a GitHub App.

## Quickstart

### 1. Install

```bash
git clone https://github.com/NodeOps-app/createos-sandbox-ghar
cd createos-sandbox-ghar
bun install

bun run lint && bun run typecheck && bun run test    # all green?
```

### 2. Create the GitHub App

Org settings → Developer settings → GitHub Apps → **New GitHub App**:

- **Permissions**
  - Organization → **Self-hosted runners: Read & write** — to mint JIT runner configs.
  - Repository → **Actions: Read** — needed by the `fork-gated` policy, harmless otherwise.
- **Subscribe to events**: **Workflow job**.
- **Webhook URL**: `https://<your-worker>.workers.dev/webhook` (you get this in step 5 — set a placeholder now, fix it after).
- **Webhook secret**: a strong random string → becomes `GITHUB_WEBHOOK_SECRET`.

Install the App on your org, then note the **App ID** and the **Installation ID** (the number in the installation settings URL: `.../installations/<ID>` — *not* the App client id).

Generate a private key (App settings → **Generate a private key**). GitHub hands you a PKCS#1 `.pem`; Web Crypto needs PKCS#8:

```bash
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in app.pem -out app.pkcs8.pem
```

### 3. Build the runner template

Bakes a rootfs with the Actions runner + docker + git, named `ghar-runner`:

```bash
CREATEOS_BASE_URL=https://api.sb.createos.sh \
CREATEOS_API_KEY=<key> \
bun run build:template
```

The build always pulls the **latest `actions/runner`** release (GitHub refuses jobs from deprecated runners), removes any existing `ghar-runner` template, and rebuilds. Wait for `ready: <id>`. See [Keeping the runner current](#keeping-the-runner-current) for the daily auto-bump.

### 4. Configure

Non-secret config lives in `wrangler.toml [vars]` — **set `GITHUB_ORG` to your org** and adjust the size/policy knobs ([reference below](#configuration)).

Secrets never go in `wrangler.toml`:

```bash
bunx wrangler secret put GITHUB_APP_ID           # App ID number
bunx wrangler secret put GITHUB_INSTALLATION_ID  # Installation ID number
bunx wrangler secret put GITHUB_APP_PRIVATE_KEY  # full contents of app.pkcs8.pem
bunx wrangler secret put GITHUB_WEBHOOK_SECRET   # secret from step 2
bunx wrangler secret put CREATEOS_API_KEY        # CreateOS control-plane key
```

For local `wrangler dev`, copy `.dev.vars.example` → `.dev.vars` and fill the same values (gitignored).

### 5. Deploy

```bash
bun run deploy      # bunx wrangler@latest deploy
```

Point the GitHub App's webhook URL at the deployed Worker (`https://<worker>.workers.dev/webhook`).

### 6. Verify

```bash
curl https://<worker>.workers.dev/health     # → ok
```

Then add a `runs-on: [createos]` job to a repo in the org and watch a microVM boot, run it, and disappear. This repo ships one: **Actions → ghar-test → Run workflow**.

## Configuration

Set in `wrangler.toml [vars]` unless marked secret (`wrangler secret put`).

| Var | Secret | Default | Meaning |
| --- | :---: | --- | --- |
| `GITHUB_ORG` | | — | Org served (case-insensitive). **Change this.** |
| `GITHUB_API_URL` | | `https://api.github.com` | Override for GitHub Enterprise. |
| `GITHUB_APP_ID` | ✅ | — | App identity. |
| `GITHUB_INSTALLATION_ID` | ✅ | — | Org installation id — **numeric**, not the App client id. |
| `GITHUB_APP_PRIVATE_KEY` | ✅ | — | **PKCS#8** PEM (convert from GitHub's PKCS#1). |
| `GITHUB_WEBHOOK_SECRET` | ✅ | — | Webhook HMAC secret. |
| `CREATEOS_BASE_URL` | | — | CreateOS control plane, e.g. `https://api.sb.createos.sh`. |
| `CREATEOS_API_KEY` | ✅ | — | CreateOS API key. |
| `RUNNER_LABEL` | | `createos` | The opt-in `runs-on` label. Also the prefix for shaped labels (`createos-8vcpu-16gb`) — see [Choosing a runner size](#choosing-a-runner-size). |
| `RUNNER_TEMPLATE` | | `ghar-runner` | Rootfs template built in step 3. |
| `SANDBOX_NAME_PREFIX` | | — | Cosmetic VM name prefix (`<prefix>-ghar-<jobId>`). |
| `RUNNER_SHAPE` | | `s-4vcpu-4gb` | VM size for the bare `RUNNER_LABEL`. |
| `MIN_RUNNER_MEM_MIB` | | `2048` | Floor on shapes offered as shaped labels — smaller shapes can't run an Actions runner. |
| `RUNNER_DISK_MIB` | | `30720` | Overlay disk — **must be ≤ your plan's disk cap** or `createSandbox` 403s. |
| `MAX_CONCURRENT` | | `0` | `0` = unlimited; `N` = cap + pending queue. Set a finite value in production. |
| `PROVISION_POLICY` | | `org-wide` | `org-wide` \| `repo-allowlist` \| `fork-gated`. |
| `REPO_ALLOWLIST` | | — | CSV of `owner/repo`, used when policy is `repo-allowlist`. |
| `REAPER_MAX_AGE_MS` | | `3600000` | Orphan-VM cutoff — keep **above your longest job**. |
| `RECONCILE_GRACE_MS` | | `180000` | Boot grace before a runner-less VM is reaped — keep **above VM boot + runner registration**. |
| `ALERT_WEBHOOK_URL` | ✅ | — | Optional Slack-compatible webhook for provision/teardown failures. |

## Choosing a runner size

```yaml
jobs:
  build:
    runs-on: [createos]             # RUNNER_SHAPE (default s-4vcpu-4gb)
  big:
    runs-on: [createos-8vcpu-16gb]  # a specific CreateOS shape
```

Available labels are derived live from the CreateOS shape catalog (`GET /v1/shapes`), so a shape added to the platform is usable without redeploying this Worker. Shapes below `MIN_RUNNER_MEM_MIB` (default 2048) or with a fractional-vCPU quota are excluded — an Actions runner cannot work on them.

Use exactly one `createos*` label. Two (`[createos, createos-2vcpu-2gb]`) is refused and the job will never get a runner.

## Teardown

Three layers, each a backstop for the one before:

0. **In-guest self-delete (fast path).** When the runner exits, the baked-in `start-runner.sh` POSTs to the guest agent's loopback-only endpoint (`127.0.0.1:1029/self/delete`) and the host destroys the VM by its identity — within seconds, independent of webhook latency. Best-effort: if the host predates self-signal, layers 1–2 still clean up. Reclaims the **VM only**; the concurrency slot is freed by layer 1.
1. **`completed` webhook (authoritative).** GitHub sends `workflow_job.completed` with `runner_name`. The Worker frees the concurrency slot and destroys the VM whose runner *actually ran the job* — keyed on runner identity, not the provisioning job, so a backlog can't tear down the wrong VM. A destroy that hits `NotFound` (layer 0 got there first) counts as success. The row stays in `destroying` until the destroy is confirmed, so a failed destroy is never lost.
2. **Reaper cron (safety net).** Every 5 minutes: re-destroy any unconfirmed `destroying` VM, and sweep `running` VMs older than `REAPER_MAX_AGE_MS` whose completion was never recorded (dropped webhook). Age-only — hence the "keep it above your longest job" rule.

> **Why runner identity?** An ephemeral runner takes the *first* matching queued job, which may not be the job that provisioned its VM when there's a backlog. Teardown therefore keys on the `runner_name` in the `completed` payload.

## Reconciler

Webhooks are edge-triggered: GitHub sends `queued` **exactly once**. If that delivery is lost, or provisioning throws, the job sits queued with no runner until GitHub's 24-hour timeout. Symmetrically, a VM whose runner never registers (bad JIT config, guest crash) looks healthy to the controller.

The same 5-minute cron runs a **reconciler** before the reaper, treating GitHub as the source of truth:

1. **Runner-liveness reap** — lists the org's `online` runners; any tracked VM older than `RECONCILE_GRACE_MS` whose runner isn't online is destroyed. Keys on live runner identity, so long-running jobs are spared. Fails safe: an API error skips the step.
2. **Queued-job re-drive** — lists every still-`queued` labelled job across installed repos and replays it through the normal provisioning path, reusing the same cap and dedup logic. Jobs already being provisioned are ignored.

## Keeping the runner current

GitHub deprecates old runner versions and **refuses their jobs**, so the baked runner must stay fresh:

- `bun run build:template` always builds the latest `actions/runner` release.
- `.github/workflows/bump-runner.yml` runs **daily**: if a newer runner shipped, it rebuilds the `ghar-runner` template via the CreateOS CLI and commits the bump. Needs the repo secret **`CREATEOS_API_KEY`**.

## Alerting

Failures are logged (`wrangler tail`). For pushed alerts, set the optional `ALERT_WEBHOOK_URL` secret to a Slack-compatible incoming webhook — the Worker posts on provision and teardown failures. Unset = no-op.

## Security notes

- **`PROVISION_POLICY=org-wide` serves every repo in the org, including fork PRs.** Safety then rests on VM isolation + ephemerality (each job gets a throwaway KVM VM; GitHub withholds secrets from fork PRs unless approved) and on `MAX_CONCURRENT` to bound the blast radius — **set it to a finite value in production**. For tighter control use `repo-allowlist`, or `fork-gated` (checks the run's head repo via the API).
- The webhook is authenticated with `X-Hub-Signature-256` HMAC; unsigned or invalid requests get `401`.
- Secrets belong in `wrangler secret`, never in `wrangler.toml`. `.dev.vars` and `.env*` are gitignored.
- Found a vulnerability? See [SECURITY.md](SECURITY.md).

## Development

```bash
bun run test        # vitest — unit + real-Durable-Object integration
bun run typecheck   # tsc --noEmit
bun run lint        # oxlint
bun run dev         # wrangler dev (needs .dev.vars)
```

Architecture, file-by-file responsibilities, conventions, and the toolchain gotchas that will bite you live in **[AGENTS.md](AGENTS.md)**. Domain vocabulary is in [CONTEXT.md](CONTEXT.md).

### Working with an AI agent

The repo is agent-ready. `AGENTS.md` is the single contributor guide, and `CLAUDE.md` symlinks to it, so **Claude Code, Codex, Cursor, and friends all pick up the same instructions with no setup**:

```bash
claude    # or: codex
> read AGENTS.md, then add <your change>
```

It carries the repo map, the verification commands an agent must run before claiming done, and the non-obvious constraints (pinned test toolchain, the Workers `fetch`-binding trap, the free-plan Durable Object rules) that an agent would otherwise rediscover the hard way.

## License

[MIT](LICENSE) © NodeOps

Built on [CreateOS Sandbox](https://createos.sh) · [SDK](https://github.com/NodeOps-app/createos-sandbox-sdk) · [CLI](https://github.com/NodeOps-app/createos-cli)
