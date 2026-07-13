# Context — createos-sandbox-ghar

Glossary for the GitHub Actions runner controller. Terms only, no implementation.

## Glossary

- **Controller** — the Cloudflare Worker. Receives GitHub webhooks, provisions a Sandbox per pending Job, tears it down when the Job completes. Stateless request handler; state lives in the DO's job rows, which own their Sandbox by **runner identity** (see Runner name).

- **Sandbox** — one createos microVM (real KVM VM), booted from a Template. Hosts exactly one Runner. Created on demand, destroyed after its Job finishes. (createos-sandbox-sdk term.)

- **Template** — pre-baked rootfs image (built from a Dockerfile) with the Actions runner binary and job tooling baked in. Boots fast; no per-job install. (createos-sandbox-sdk term.)

- **Runner** — the GitHub Actions self-hosted runner process inside a Sandbox. Ephemeral: takes exactly one Job then exits. Registered via JIT config, outbound-only (long-polls GitHub, no inbound).

- **Job** — a GitHub Actions `workflow_job`. `queued` action = provision trigger; `completed` action = teardown trigger. One `queued` Job provisions one Sandbox; but because Runners carry only the shared label, under a backlog GitHub may run a *different* queued Job on that Sandbox — so teardown is keyed on Runner name, not the provisioning Job id.

- **JIT config** — single-use encoded runner config from `POST /orgs/{org}/actions/runners/generate-jitconfig`. Passed to `run.sh --jitconfig`. Ephemeral by construction; token never persisted to disk.

- **Org** — the GitHub org the Controller serves (`GITHUB_ORG`). Runners register at org scope, not per-repo.

- **Self-destruct** (a.k.a. **self-delete**) — a Sandbox tearing down its own VM from inside the guest, triggered when its Runner exits. The guest agent exposes a loopback-only endpoint `POST 127.0.0.1:1029/self/delete`; the host destroys the VM by its UDS identity (requires a createos host fleet with the self-signal agent baked into the host initrd — probe with `curl -o /dev/null -w '%{http_code}' http://127.0.0.1:1029/self/pause`, `405` = present). In this controller it is the **fast teardown path** — it reclaims the host VM in seconds but does **not** free the DO concurrency slot, so the `completed` webhook + Job→Sandbox map are still needed to free the slot and as a backstop. Sibling endpoint `/self/pause` exists but is unused (runners are one-shot ephemeral).

- **Reaper** — safety-net teardown, a cron sweep: destroys orphan Sandboxes (a Job that booted a Sandbox but whose completion was never recorded — crash, dropped webhook) and retries any **Destroying** row whose teardown was never confirmed.

- **Reconciler** — cron self-heal (same 5-min trigger, runs before the Reaper) that reconciles against GitHub as source of truth, closing the gaps the once-only `queued` webhook leaves. Two steps: (1) tears down tracked VMs older than `RECONCILE_GRACE_MS` whose `ghar-<jobId>` runner is not in GitHub's `online` runner list (booted-but-never-registered, or a missed `completed`) — keyed on live runner identity, so it spares a busy long-running VM the age-only Reaper can't; (2) re-drives every still-`queued` `createos` Job GitHub reports (across installed repos) through the normal `onQueued` path, recovering Jobs whose provision failed or whose `queued` webhook was lost. Both GitHub reads fail safe — an API error skips that step rather than reaping healthy VMs or provisioning blindly.

- **Provisioning policy** — configurable switch deciding which Jobs get a Sandbox: `org-wide` (any repo, default), `repo-allowlist` (only listed repos), or `fork-gated` (skip fork-PR jobs). Set via env/config. Under `org-wide`, fork-PR safety rests solely on VM isolation + ephemerality.

- **Runner label** — `createos`. Workflows opt in with `runs-on: [createos]`; the Controller ignores any `workflow_job` whose labels omit it; the JIT config registers the Runner with it.

- **Runner name** — `ghar-<provisioningJobId>`, the unique name the JIT config registers per Runner (distinct from the shared Runner label). The `completed` webhook echoes it as `runner_name`, letting the Controller tear down the Sandbox that *actually* ran the Job even when it differs from the provisioning Job.

- **Destroying** — a job-row state: the Job is done and its slot is freed, but the Sandbox `destroy()` is not yet confirmed. The row is held (not deleted) so a failed/dropped destroy is retried by the Reaper; it clears once the Worker confirms teardown.

- **Concurrency cap** — max simultaneous Sandboxes the Controller will run (protects createos account quota + CF free tier + cost). Off by default (`MAX_CONCURRENT` unset/0 = unlimited, boot every Job); when set to N>0, Jobs beyond N wait in a pending queue in the DO until a slot frees.
