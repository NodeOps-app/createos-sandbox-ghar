# Shape-selectable runner labels, admitted from a live catalog

**Status:** accepted

The Controller provisioned every job onto one `RUNNER_SHAPE` for the whole org: a workflow that needed a bigger or smaller VM than that had no way to ask for it. `runs-on` is the only channel a workflow author has to express intent to the Controller — GitHub passes its labels through unopinionated as `workflow_job.labels` — and createos already publishes the sizes a workflow could ask for at `GET /v1/shapes`.

We now let `runs-on: [createos-<shape suffix>]` select a shape directly (strip the `createos-` prefix, prepend `s-`), while bare `createos` keeps meaning `RUNNER_SHAPE` so existing workflows are unaffected. The catalog is fetched live and cached for five minutes per isolate, floored to shapes with `mem_mib >= MIN_RUNNER_MEM_MIB` and no `cpu_quota_pct` (a fractional-vCPU shape is a throttled sliver, not a CPU an Actions runner can use) — so a shape added to the platform tomorrow becomes a usable label with no redeploy. A JIT runner registers with exactly the one label its job requested.

## Consequences

- The label vocabulary is a public interface: workflow authors write `runs-on` directly into their YAML, so renaming or removing a label breaks their workflows without warning. That reversibility cost is why this is an ADR rather than an ordinary change.
- One label per runner keeps each shape's pool disjoint under GitHub's AND-matching of `runs-on` against a runner's labels. Registering a runner with several createos labels (`createos` and `createos-8vcpu-16gb`) would make it eligible for bare-`createos` jobs while sitting on an 8 vCPU VM — reintroducing, for shape choice, the same mis-assignment ADR-0003 fixed for the provisioning job id.
- A job naming more than one createos label is refused (202, logged) rather than resolved by array order — there is no defensible way to pick a winner.
- `MAX_CONCURRENT` stays an unweighted slot count: it does not know or care how large each slot's VM is. A burst of large-shape jobs is bounded by the createos plan's quota, not by the Controller — `createSandbox` returns a `403` when the quota is exhausted, which `markProvisionFailed` turns into a freed slot and an alert rather than a stuck job.
