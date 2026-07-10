# Shape-selectable runner labels

**Date:** 2026-07-09
**Status:** approved, not yet implemented

## Problem

Every `runs-on: [createos]` job today boots the same VM size — whatever
`RUNNER_SHAPE` is set to (`s-4vcpu-4gb`). A job that needs 8 vCPU cannot ask for
it, and a job that needs 1 vCPU wastes three.

The createos control plane already publishes its full sizing catalog at
`GET /v1/shapes` (unauthenticated, paginated). We want that catalog to reach
GitHub Actions users as runner labels, without a controller redeploy each time a
shape is added.

## Contract

A job selects a VM size through its `runs-on` label:

```yaml
runs-on: [createos-2vcpu-2gb]   # → createos shape s-2vcpu-2gb
runs-on: [createos-8vcpu-16gb]  # → createos shape s-8vcpu-16gb
runs-on: [createos]             # → config.runnerShape (s-4vcpu-4gb)
```

**Label → shape:** strip the `createos-` prefix, prepend `s-`. The bare
`createos` label resolves to `config.runnerShape` and bypasses the resource
floor below, because an operator chose that value explicitly.

**One label per runner.** A JIT runner registers with exactly the single label
its job asked for — never both `createos` and `createos-8vcpu-16gb`. GitHub
AND-matches `runs-on` labels against a runner's label set, so a runner carrying
both labels could be handed a bare-`createos` job while an 8 vCPU VM sits under
it. This is the same class of mis-assignment that `coordinator.ts` already
guards against for `job_id` (see ADR-0003). One label per runner partitions the
pools.

## Shape discovery

New module `src/shapes.ts`, so `sandbox.ts` stays a thin createos wrapper.

`shapes.ts` needs an SDK client and `sandbox.ts` needs `shapeForLabel`, which
would be an import cycle. The SDK client factory and the `SandboxDeps` test seam
move to a new `src/createos.ts` that both import; `sandbox.ts` re-exports
`SandboxDeps` so its existing consumers are untouched.

### `usableShapes(config, deps): Promise<Set<string>>`

Calls the SDK's `listShapes()` (unauthenticated, already paginated by the SDK),
then filters the catalog down to shapes that can actually host an Actions
runner:

- `mem_mib >= MIN_RUNNER_MEM_MIB` (new config, default `2048`)
- `cpu_quota_pct` is absent — a fractional-vCPU shape is a throttled sliver, not
  a CPU

Against today's catalog of 11 shapes, that admits 7:

| Shape | Admitted | Why not |
| --- | --- | --- |
| `s-0.25vcpu-512mb` | no | `cpu_quota_pct: 25`, and under the mem floor |
| `s-0.5vcpu-1gb` | no | `cpu_quota_pct: 50`, and under the mem floor |
| `s-1vcpu-256mb` | no | under the mem floor |
| `s-1vcpu-1gb` | no | under the mem floor |
| `s-1vcpu-2gb` | yes | |
| `s-2vcpu-2gb` | yes | |
| `s-2vcpu-4gb` | yes | |
| `s-4vcpu-4gb` | yes | default |
| `s-4vcpu-8gb` | yes | |
| `s-8vcpu-8gb` | yes | |
| `s-8vcpu-16gb` | yes | |

A shape added to the API tomorrow is offered as a label on the next cache miss,
with no deploy. A tiny shape added tomorrow is discovered and excluded. The
floor is one env var to retune; it is not a per-shape allowlist.

### Caching

A module-level `{ fetchedAt, ids }` with a 5 minute TTL. Per-isolate, so a cold
isolate pays one cheap unauthenticated request. No Cache API, no DO state.

The fetch is blocking network I/O and lives in the Worker, never the Durable
Object — ADR-0002 requires the DO stay passive so it hibernates.

### Cold-cache fetch failure

Fall back to serving **only** the bare `createos` label (whose shape comes from
config and needs no catalog), and `console.warn` the failure. Shaped jobs get a
`202` and stay `queued` on GitHub; the `*/5` cron reconciler re-drives them on
the next tick.

The `console.warn` is mandatory, not decorative: a silent `202` is
indistinguishable from "this job was never ours", which is exactly the silent
bound CLAUDE.md forbids. Log the label, the job id, and the underlying error.

### Label selection

`matchesLabel` is replaced by a pure decision function plus one fetch, kept
strictly apart so the catalog is only ever touched where — and when — it is
actually needed. Earlier drafts of this feature put the fetch and the
decision in one function (`isUsableLabel`) and let `GitHubClient.listQueuedJobs`
take the catalog and call a `pickLabel` internally — a transport client
making an admission decision, which meant the reconciler had to fetch the
catalog before it even knew whether any queued job needed one, and a job id
was never available to name in a warning. `selectLabel`/`fetchCatalog` fix
that:

- `createosLabels(labels, config): string[]` — pure. The createos labels in a
  job's `runs-on`: the bare `config.runnerLabel`, plus anything prefixed
  `createos-`. A job's `runs-on` is a set that GitHub AND-matches, so its other
  labels (`self-hosted`, `linux`, `x64`) are irrelevant — a JIT runner carries
  those implicitly, and this ignores them.
- `shapeForLabel(label, config): string` — pure. Bare label → `config.runnerShape`;
  otherwise `s-` + the label's suffix.
- `type Catalog = { ok: true; usable: Set<string> } | { ok: false }` — the
  shape catalog, or the fact it couldn't be fetched. `{ok: false}` is distinct
  from an empty `Set` on purpose: an outage and an authoritative empty catalog
  mean different things and must not be conflated.
- `type LabelSelection = { ok: true; label: string } | { ok: false; reason:
  "not-ours" | "ambiguous" | "unknown-shape" | "catalog-unavailable" }` — the
  outcome of admitting one job's labels. Four reasons, not one boolean,
  because "not ours" and "the shapes API is down" are not the same 202 and a
  caller building a log line or a response body needs to say which happened.
- `selectLabel(labels, config, catalog): LabelSelection` — pure **and
  silent**. It never `console.warn`s: it doesn't have the job id, and the
  caller does, so the caller is the one who logs. It resolves the bare label
  and returns *before* even looking at `catalog` — the bare label's shape
  comes from config, so a shapes-API outage (or a caller that skipped the
  fetch because nothing needed it) can never stop the jobs that work today.
  Only a shaped label consults `catalog`.
- `fetchCatalog(config, deps): Promise<Catalog>` — the one function that
  actually calls `usableShapes()` (the network fetch), converting a throw into
  `{ok: false}` instead of propagating it. This is the only impure half of
  label selection, and the only one worth calling lazily: a caller checks
  whether any candidate job could possibly need a catalog *before* calling
  this, so a tick with no shaped jobs, or a caller that only ever sees bare
  labels, never pays for (or is blocked by) a fetch nothing needs.

**Exactly one createos label may resolve.** Two (`[createos, createos-2vcpu-2gb]`,
or two shaped labels) is a contradiction with no defensible winner:
`selectLabel` returns `{ok: false, reason: "ambiguous"}` rather than silently
picking by array order, and the caller `console.warn`s, naming the job id. The
job stays `queued` on GitHub and its author sees no runner, which is the
correct signal that the workflow is wrong.

**The catalog is consulted only on the `queued` action, and only lazily even
then.** A `completed` webhook needs to know a job is ours (one createos label)
and nothing more — the DO looks up the VM by `runner_name`; gating teardown on
the shapes API would mean a shapes outage leaks every shaped VM until the
reaper. On `queued`, `handleWebhook` calls `fetchCatalog` only when the job's
label isn't bare. The cron reconciler fetches one `Catalog` for the whole
tick, and only when at least one candidate names a shaped (non-bare) label —
`GitHubClient.listQueuedJobs()` is now dumb transport (no arguments, no
`pickLabel`, returns every queued job's raw labels), so the reconciler can
run this check before deciding whether to fetch anything at all.

## The requested label must persist on the pending row

`#dequeuePending()` reconstructs a `PendingJob` from a `jobs` row and hands it
to `provisionAndRecord`. Without a stored label, a `createos-8vcpu-16gb` job
that queued behind the concurrency cap comes back out of the queue and boots as
`s-4vcpu-4gb`.

The row stores the **label**, not the shape. Shape does not determine label:
`createos` and `createos-4vcpu-4gb` both resolve to `s-4vcpu-4gb`, but a runner
registered under the wrong one of those is offered the wrong pool's jobs. The
shape is re-derived from the label at provision time via `shapeForLabel`, which
needs no catalog.

So:

- `PendingJob` gains `label: string`.
- `jobs` gains a `label TEXT` column, migrated in the DO constructor by the same
  `PRAGMA table_info` + `ALTER TABLE` pattern that added `runner_name`.
- A `NULL` label (a row written before this migration) reads as the DO's
  `RUNNER_LABEL` binding, i.e. the bare label. The DO gains that binding; it is
  already a `wrangler.toml` var.

## Call sites

| Site | Change |
| --- | --- |
| `handler.ts:92` | `matchesLabel` → `createosLabels` (all actions) + `isUsableLabel` (queued only); carry the label into `PendingJob` |
| `handler.ts:219` | the reconciler synthesizes `labels: [config.runnerLabel]`; it must use `job.label`, which `listQueuedJobs` now resolves |
| `github/client.ts:50` | `generateJitConfig(runnerName, label)` — register the label the job requested, not `config.runnerLabel` |
| `github/client.ts:142` | `listQueuedJobs(usable)` takes the catalog, fetched once per reconcile tick |
| `github/client.ts:186` | `labels.includes(runnerLabel)` → `pickLabel(j.labels, usable, config)` |
| `sandbox.ts` | `createSandbox({ shape })` takes `shapeForLabel(job.label, config)`, not `config.runnerShape` |

`RUNNER_DISK_MIB` stays global at `10240` (the plan's disk cap) across every
shape.

## Deliberately unchanged

- **`MAX_CONCURRENT` stays a flat slot count**, not a vCPU budget. Weighting the
  counter would touch the DO schema, `#dequeuePending`, `#drainPending`, `sweep`,
  and every integration test — far more than the labels themselves. The createos
  plan quota is the real backstop: a burst of 8 vCPU jobs gets a `403` from
  `createSandbox`, which already routes to `markProvisionFailed` (slot freed) and
  an alert. Revisit if that `403` ever fires in practice.
- **`RUNNER_SHAPE` stays `s-4vcpu-4gb`.** Bare `createos` keeps its current
  meaning; no existing workflow changes behavior.
- Teardown by `runner_name`, the in-guest self-delete path, and the runner
  template are untouched. One rootfs serves every shape.

## Verification

Plain `vitest`:

- `createosLabels` / `pickLabel` — bare label, shaped label, unknown label,
  non-createos label, a shaped label naming a real-but-floored shape
  (`createos-1vcpu-1gb` → `null`), incidental labels ignored
  (`[self-hosted, linux, createos-2vcpu-2gb]`), two createos labels → `null` + warn
- `shapeForLabel` — bare → `config.runnerShape`; `createos-8vcpu-16gb` → `s-8vcpu-16gb`
- the floor — excludes on `mem_mib`, excludes on `cpu_quota_pct`
- the cache — a second call inside the TTL does not refetch; a call past it does
- cold-cache fetch failure — `isUsableLabel` is `true` for the bare label without
  a fetch, `false` for a shaped label, and `console.warn` fired

`@cloudflare/vitest-pool-workers` (createos mocked at the `fetch` boundary):

- a shaped webhook reaches `createSandbox` with the matching shape, and
  `generate-jitconfig` with the matching label
- an unknown shaped label returns `202` and warns
- a job queued at the concurrency cap dequeues with its label intact
- a `completed` webhook for a shaped job tears the VM down with the shapes API
  unreachable
- the migration adds `label` to a pre-existing `jobs` table

Live, after deploy: add a `runs-on: [createos-2vcpu-2gb]` job to `ghar-test.yml`
and confirm the VM boots at 2 vCPU.

## Documentation

- `CONTEXT.md` — add **shape label** to the glossary.
- **ADR-0004** — the label naming scheme and the one-label-per-runner rule.
  `runs-on` is a public interface that users write into their workflows;
  renaming it later breaks them. That makes it a hard-to-reverse decision worth
  recording.
- `README.md` — document the available labels and `MIN_RUNNER_MEM_MIB`.
