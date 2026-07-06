# Teardown keyed on runner identity, not the provisioning job

**Status:** accepted

Each VM registers its runner under a unique name, `ghar-<provisioningJobId>`, but with only the **shared** `createos` label. GitHub assigns a free runner to the *first* matching queued job, which — under a backlog — may not be the job whose `queued` webhook provisioned that VM. So "one Job ↔ one Sandbox for its whole life" only holds at steady state. Keying teardown on the completed job's own id (the previous design) could therefore destroy the wrong VM, or miss one, whenever queued jobs outnumber free runners.

We now key teardown on **runner identity**: the `completed` webhook carries `workflow_job.runner_name`, which is the VM that *actually* ran the job. The Coordinator records `runner_name` on the row when the VM is created and, on completion, tears down the VM matching that name (falling back to the job id for jobs cancelled before any runner picked them up). Because the runner is ephemeral (exactly one job per VM), every VM is destroyed exactly once — by whichever job ran on it — and the count stays consistent regardless of the queued-job↔runner pairing.

## Consequences

- The `jobs` table gains a `runner_name` column (migrated in on existing DOs via `ALTER TABLE`); `onCompleted(jobId, runnerName)` looks up by runner first, job id second.
- Teardown no longer depends on the "steady state only" assumption — the backlog edge case that previously fell through to the reaper is handled by layer 1 directly.
- The VM's row is held in a `destroying` state (not deleted) until the Worker confirms the `destroy()`; a thrown destroy leaves retry state for the reaper instead of losing the sandbox id. `destroying` rows do not count against the concurrency cap, so a completed job frees its slot immediately.
- A job cancelled before any runner picks it up has no `runner_name`; teardown falls back to the job id and drops the row (destroying its VM if one was already created).
