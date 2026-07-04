# Ephemeral createos microVM per GitHub Actions job

**Status:** accepted

We run each `nodeops-app` GitHub Actions job on its own freshly-booted createos microVM (a real KVM VM), registered as a JIT `--ephemeral` self-hosted runner, torn down the moment the job finishes. We chose this over the obvious alternatives — GitHub-hosted runners (cost/no-custom-hardware), a persistent self-hosted runner pool (state bleed between untrusted jobs, standing cost), and Kubernetes actions-runner-controller (operational weight of a cluster we don't otherwise need) — because createos gives us per-job KVM isolation with a plain HTTP SDK that runs on a Cloudflare Worker, so a hostile fork-PR job gets exactly one throwaway VM and no orchestrator to compromise.

## Consequences

- Fork-PR safety under the default `org-wide` provisioning policy rests entirely on VM isolation + ephemerality (no allowlist by default) — see `PROVISION_POLICY` switch.
- Teardown is layered three ways (completed-webhook `destroy()`, runner-exit `halt` reaped by fc's liveness watcher, DO alarm reaper) so a VM cannot leak even if one path fails; the `halt` layer is a deliberate on-ramp to guest self-destruct (NodeOps-app/fc#520).
- A pre-baked rootfs template (runner + docker baked in) is required so boot is fast and offline; `RUN`-only Dockerfiles mean the runner comes in via `curl`, not `COPY`.
