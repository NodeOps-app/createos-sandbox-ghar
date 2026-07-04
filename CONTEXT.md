# Context — createos-sandbox-ghar

Glossary for the GitHub Actions runner controller. Terms only, no implementation.

## Glossary

- **Controller** — the Cloudflare Worker. Receives GitHub webhooks, provisions a Sandbox per pending Job, tears it down when the Job completes. Stateless request handler; state lives in the Job→Sandbox map.

- **Sandbox** — one createos microVM (real KVM VM), booted from a Template. Hosts exactly one Runner. Created on demand, destroyed after its Job finishes. (createos-sandbox-sdk term.)

- **Template** — pre-baked rootfs image (built from a Dockerfile) with the Actions runner binary and job tooling baked in. Boots fast; no per-job install. (createos-sandbox-sdk term.)

- **Runner** — the GitHub Actions self-hosted runner process inside a Sandbox. Ephemeral: takes exactly one Job then exits. Registered via JIT config, outbound-only (long-polls GitHub, no inbound).

- **Job** — a GitHub Actions `workflow_job`. `queued` action = provision trigger; `completed` action = teardown trigger. One Job maps to one Sandbox for its whole life.

- **JIT config** — single-use encoded runner config from `POST /orgs/{org}/actions/runners/generate-jitconfig`. Passed to `run.sh --jitconfig`. Ephemeral by construction; token never persisted to disk.

- **Org** — `nodeops-app` GitHub org. Runners register at org scope, not per-repo.

- **Self-destruct** — a Sandbox tearing down its own VM from inside the guest, triggered when its Runner exits. Proposed fc feature (NodeOps-app/fc#520), not yet shipped. When available, it makes the Controller near-stateless: the Sandbox reaps itself, so no `completed` webhook or Job→Sandbox map is needed for the happy path.

- **Reaper** — safety-net teardown for orphan Sandboxes: a Job that queued and booted a Sandbox but whose Runner never took work (crash, bad JIT config), so no completion/self-destruct signal ever fires. Worker cron trigger queries the DO, destroys orphans in the Worker.

- **Provisioning policy** — configurable switch deciding which Jobs get a Sandbox: `org-wide` (any repo, default), `repo-allowlist` (only listed repos), or `fork-gated` (skip fork-PR jobs). Set via env/config. Under `org-wide`, fork-PR safety rests solely on VM isolation + ephemerality.

- **Runner label** — `createos`. Workflows opt in with `runs-on: [createos]`; the Controller ignores any `workflow_job` whose labels omit it; the JIT config registers the Runner with it.

- **Concurrency cap** — max simultaneous Sandboxes the Controller will run (protects createos account quota + CF free tier + cost). Off by default (`MAX_CONCURRENT` unset/0 = unlimited, boot every Job); when set to N>0, Jobs beyond N wait in a pending queue in the DO until a slot frees.
