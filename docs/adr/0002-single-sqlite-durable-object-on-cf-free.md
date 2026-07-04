# Controller state in one SQLite-backed Durable Object, on the CF Free plan

**Status:** accepted

The controller keeps all coordination state — the Job→Sandbox map, the concurrency counter, and the pending-job queue — in a single SQLite-backed Durable Object, and must run entirely within the Cloudflare Workers Free plan. We picked a Durable Object over KV (eventually consistent → races the fast `completed`/`queued` ordering) and over Queues/D1 (extra moving parts we don't need); we picked the **SQLite** storage backend specifically because the Free plan can only create SQLite-backed DOs (key-value DOs are Paid-only).

## Consequences

- DO migration must be `new_sqlite_classes`; a key-value DO would silently force the account onto the Paid plan.
- The DO holds **pure state only** — no outbound fetch. All network work (createSandbox, GitHub API, `destroy()`) runs in the plain Worker, so the DO stays hibernation-eligible and bills ~0 GB-s against the 13,000 GB-s/day free ceiling, and its methods are trivially unit-testable.
- The orphan **reaper is a Worker cron trigger** (not a DO alarm): the scheduled handler queries the DO for orphans, tears them down in the Worker, then tells the DO to clear the rows. Keeps fetch out of the DO and reaping off the hot path.
