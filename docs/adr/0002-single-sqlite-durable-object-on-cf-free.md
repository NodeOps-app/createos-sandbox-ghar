# Controller state in one SQLite-backed Durable Object, on the CF Free plan

**Status:** accepted

The controller keeps all coordination state — the Job→Sandbox map, the concurrency counter, the pending-job queue, and the orphan-reaper alarm — in a single SQLite-backed Durable Object, and must run entirely within the Cloudflare Workers Free plan. We picked a Durable Object over KV (eventually consistent → races the fast `completed`/`queued` ordering) and over Queues/D1 (extra moving parts we don't need); we picked the **SQLite** storage backend specifically because the Free plan can only create SQLite-backed DOs (key-value DOs are Paid-only).

## Consequences

- DO migration must be `new_sqlite_classes`; a key-value DO would silently force the account onto the Paid plan.
- Blocking/long network work (createSandbox poll, GitHub API calls, `destroy()`) runs in the plain Worker, never inside the DO, so the DO stays hibernation-eligible and bills ~0 GB-s against the 13,000 GB-s/day free ceiling.
- `setAlarm()` and deletes each cost one SQLite row-write (100k/day free); a single singleton coordinator with a sparse alarm sweep stays far under that. See memory `cf-free-tier-constraint`.
