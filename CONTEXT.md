# Context — createos-sandbox-ghar

Glossary for the GitHub Actions runner controller. Terms only, no implementation.

## Glossary

- **Controller** — the Cloudflare Worker. Receives GitHub webhooks, provisions a Sandbox per pending Job, tears it down when the Job completes. Stateless request handler; state lives in the DO's job rows, which own their Sandbox by **runner identity** (see Runner name).

- **Sandbox** — one createos microVM (real KVM VM), booted from a Template. Hosts exactly one Runner. Created on demand, destroyed after its Job finishes. (createos-sandbox-sdk term.)

- **Template** — pre-baked rootfs image (built from a Dockerfile) with the Actions runner binary and job tooling baked in. Boots fast; no per-job install. (createos-sandbox-sdk term.)

- **Runner** — the GitHub Actions self-hosted runner process inside a Sandbox. Ephemeral: takes exactly one Job then exits. Registered via JIT config, outbound-only (long-polls GitHub, no inbound).

- **Job** — a GitHub Actions `workflow_job`. `queued` action = provision trigger; `completed` action = teardown trigger. One `queued` Job provisions one Sandbox; but under a backlog *within the same Shape's pool*, GitHub may run a *different* queued Job on that Sandbox, because every Runner in that pool carries only the one label its Shape uses — so teardown is keyed on Runner name, not the provisioning Job id (see `docs/adr/0003`). Shaped pools are disjoint (see Shape label, `docs/adr/0004`), so this backlog reassignment can only ever happen between Jobs asking for the same Shape.

- **JIT config** — single-use encoded runner config from `POST /orgs/{org}/actions/runners/generate-jitconfig`. Passed to `run.sh --jitconfig`. Ephemeral by construction; token never persisted to disk.

- **Org** — `nodeops-app` GitHub org. Runners register at org scope, not per-repo.

- **Self-destruct** (a.k.a. **self-delete**) — a Sandbox tearing down its own VM from inside the guest, triggered when its Runner exits. Shipped in fc (NodeOps-app/fc#520, commit `a56978b`): the guest agent exposes a loopback-only endpoint `POST 127.0.0.1:1029/self/delete` and the host destroys the VM by its UDS identity. In this controller it is the **fast teardown path** — it reclaims the host VM in seconds but does **not** free the DO concurrency slot, so the `completed` webhook + Job→Sandbox map are still needed to free the slot and as a backstop. Sibling endpoint `/self/pause` exists but is unused (runners are one-shot ephemeral).

- **Reaper** — safety-net teardown, a cron sweep: destroys orphan Sandboxes (a Job that booted a Sandbox but whose completion was never recorded — crash, dropped webhook) and retries any **Destroying** row whose teardown was never confirmed.

- **Reconciler** — cron self-heal (same 5-min trigger, runs before the Reaper) that reconciles against GitHub as source of truth, closing the gaps the once-only `queued` webhook leaves. Three steps: (1) tears down tracked VMs older than `RECONCILE_GRACE_MS` whose recorded runner name is not in GitHub's `online` runner list (booted-but-never-registered, or a missed `completed`) — keyed on live runner identity, so it spares a busy long-running VM the age-only Reaper can't; (2) re-drives still-`queued` `createos` Jobs GitHub reports (across installed repos) through the normal `onQueued` path, recovering Jobs whose provision failed or whose `queued` webhook was lost — this **recovery scan** is bounded by `RECOVERY_SUBREQUEST_BUDGET` and resumed by a per-repo **cursor** held in the Coordinator, so as installed repos grow it rotates coverage across ticks (eventual coverage) instead of blowing the Free-plan 50-subrequest cap; a bound tick warns loudly with covered/deferred counts; (3) deletes **Orphaned runner registrations**. All GitHub reads fail safe — an API error skips that step rather than reaping healthy VMs, provisioning blindly, or deleting live Runners.

- **Orphaned runner registration** — a JIT Runner registered with GitHub for a Job that never completed one, so GitHub (which auto-removes an ephemeral Runner only *after* it finishes a Job) keeps it listed `offline` forever. Created whenever a provision attempt dies after the JIT mint but before the Runner takes work: `createSandbox` failed, the Job was cancelled mid-boot, the VM was reaped before GitHub assigned it anything. Nothing else cleans these up, so the Reconciler's third step deletes them. **Ownership is proven, not guessed** — a registration is deleted only if its Runner name parses as ours (`cos-<jobId>-<xx>`), GitHub reports it offline and not busy, *and* the Coordinator holds no row for that Job id. The last test is what distinguishes an orphan from a Runner that is merely **booting**: a JIT registration exists from the moment it is minted but its VM takes ~30s to come up, during which a healthy Runner is indistinguishable from an orphan by name and status alone. `onQueued` inserts the Job row *before* the mint, so a booting Runner always has a row and an orphan never does.

- **Provisioning policy** — configurable switch deciding which Jobs get a Sandbox: `org-wide` (any repo, default), `repo-allowlist` (only listed repos), or `fork-gated` (skip fork-PR jobs). Set via env/config. Under `org-wide`, fork-PR safety rests solely on VM isolation + ephemerality. The policy is a **cost** control — which repos the Controller spends a VM on — not a GitHub-side execution boundary: the JIT Runner registers into **`RUNNER_GROUP_ID`** (default `1`, the org-wide Default group), and which repos may schedule onto a Runner is that *group's* GitHub policy, not the allowlist. So `repo-allowlist` only becomes an actual boundary when `RUNNER_GROUP_ID` points at a group whose policy scopes it to the allowlisted repos.

- **Job admission** — the ordered decision that turns a queued GitHub Job into a Pending Job the Coordinator may track: identify exactly one Runner label, apply Provisioning policy, then validate a shaped label against the lazily-loaded Shape catalog. Bare-label Jobs never consult the catalog. Webhook intake and the Reconciler use the same admission module (`src/admission.ts`); completed Jobs use label identification only, so teardown never depends on current policy or the catalog.

- **Runner label** — a family of labels, not one: bare `createos` (opts into `RUNNER_SHAPE`) plus one `createos-<shape suffix>` per usable Shape (see Shape label). The Controller ignores any `workflow_job` whose labels contain none of them, and refuses (202, logged) any Job naming more than one — there is no defensible way to pick a winner. The JIT config registers the Runner with exactly the one label the Job asked for, never more than one (`docs/adr/0004`).

- **Runner name** — `cos-<jobId>-<xx>`, the unique name the JIT config registers per Runner (distinct from the Runner label). `xx` is a 2-character per-attempt token, so a retried provision for the same Job can never collide with an orphaned JIT registration left by an earlier attempt. The `completed` webhook echoes the full name as `runner_name`, letting the Controller tear down the Sandbox that *actually* ran the Job even when it differs from the provisioning Job.

- **Shape** — a createos VM sizing preset (e.g. `s-2vcpu-2gb`), listed live at `GET /v1/shapes`.

- **Shape label** — the `runs-on` label a workflow uses to pick a Shape (`createos-2vcpu-2gb` → `s-2vcpu-2gb`; strip the `createos-` prefix, prepend `s-`). The bare `createos` label means `RUNNER_SHAPE`. Exactly one Shape label per Runner (`docs/adr/0004`).

- **Destroying** — a job-row state: the Job is done and its slot is freed, but the Sandbox `destroy()` is not yet confirmed. The row is held (not deleted) so a failed/dropped destroy is retried by the Reaper; it clears once the Worker confirms teardown.

- **Spawn timeline** — the queued→started latency of one Sandbox, logged as a single line when the `in_progress` webhook lands, split into three phases the Controller can act on: **wait** (Job sat `pending` behind the Concurrency cap), **provision** (JIT mint + `createSandbox` + ownership record + Runner launch), **boot** (VM/dockerd/Runner-connect until GitHub dispatches the Job). GitHub sends `in_progress` when a Runner *accepts* a Job, so it is the true start signal — earlier the Controller ignored it and wrote `booted_at` at launch-return instead. Recorded by `markJobStarted` against the row the **Runner name** owns and stamped once (`job_started_at`); a Job cancelled before pickup never emits, and redelivery emits nothing. Pure observation: the DO changes no state and makes no extra call, since the webhook is one already received.

- **Concurrency cap** — max simultaneous Sandboxes the Controller will run (protects createos account quota + CF free tier + cost). Off by default (`MAX_CONCURRENT` unset/0 = unlimited, boot every Job); when set to N>0, Jobs beyond N wait in a pending queue in the DO until a slot frees.

- **Tenant** — an approved GitHub org, keyed by App installation id. Owns the Grant, concurrency cap, shape ceiling, job TTL and runner group.

- **Project** — an approved repo inside a Tenant; the admission unit — usage is attributed to it, never enforced at it.

- **Grant** — a Tenant's weighted minutes per UTC calendar month.

- **Tenant admission** — in `TENANCY_MODE=multi`, the ordered gate ladder a queued Job clears before it becomes a Pending Job: identify exactly one Runner label (same first step as single-mode Job admission), look up the Tenant by installation id and require it `approved`, require the repo on the Project allowlist (unless the Tenant is `allow_all_repos`), require the requested Shape within the Tenant's ceiling, require the Tenant's Ledger balance under its Grant, then the same shared catalog validation that single mode runs. A Tenant's own concurrency cap gates additionally to the deploy-wide Concurrency cap — either binding queues the Job. One function (`admitAndDrive`) is the only path through this ladder, walked identically by the webhook and by the Reconciler's re-drive, so a recovered Job can never be admitted more leniently than a fresh one.

- **Refusal notice** — a neutral GitHub check run (`conclusion: neutral`, so it informs without failing the Job's CI) posted on the commit when Tenant admission refuses a Job past the label gate. Deduplicated to one per repo per UTC day, so a noisy misconfigured repo gets a single notice rather than one per queued Job.

- **Job TTL** — a Tenant's `job_ttl_ms`: the max wall-time its own Sandboxes get before the Reaper sweep tears them down, in place of the deploy-wide `REAPER_MAX_AGE_MS` for that Tenant's rows. Untenanted rows (single mode, or pre-migration) keep the deploy-wide bound.

- **Weighted minute** — one wall-clock minute of Sandbox lifetime × shape vCPU ÷ 2.

- **Ledger** — per-Tenant, per-month usage rows; the month is part of the key, so a new month is a new row and there is no reset step. Billed at destroy confirmation (`markDestroyed`), using the weight persisted on the row at admission time — not recomputed from the deploy's current label→shape mapping, so a label rename mid-flight can't retroactively change what an in-flight Job bills. A NULL weight (a row that predates per-Tenant billing) falls back to parsing it from the row's label.
