# Single-DO multi-tenancy with org-level tenants

**Status:** accepted

All tenants share the one singleton Coordinator DO; a Tenant is a GitHub org
keyed by App installation id; a Project is an approved repo; quota (weighted
minutes, calendar-month UTC) is enforced on the Tenant and attributed per
Project. Tenant ownership lives in `jobs.tenant_id` — never in runner or VM
names, whose byte budgets (JIT blob ~4085/4096; sandbox name ≤22 chars) have
no room for a tenant tag.

Rejected: per-tenant DOs (serialization relief not yet needed; would have
required moving live rows between objects — the one migration a Worker
rollback cannot undo — and would have broken the name-based orphan sweep);
per-repo quota (repos are free to create — quota on the org, admission on the
repo); a global capacity arbiter (operator keeps Σ caps ≤ plan capacity).

Revisit when queued→provisioning p95 climbs under concurrent tenant bursts or
DO duration billing becomes visible; `jobs.tenant_id` makes the split
mechanical.
