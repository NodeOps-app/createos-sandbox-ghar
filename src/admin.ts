import { z } from "zod";
import type { Bindings } from "./index";
import { loadConfig } from "./config";
import { timingSafeEqual } from "./webhook";
import type { TenantRecord } from "./types";

/**
 * Operator-only tenant registry API. Manual approval is the design (spec D16):
 * a Google-Form applicant is vetted by a human, then these endpoints record the
 * decision — approval must never require a deploy, because a push to main IS a
 * production deploy. Missing token and wrong token both 404, so an unconfigured
 * deployment exposes no probeable surface.
 */

const enc = new TextEncoder();

async function authorized(req: Request, token: string | undefined): Promise<boolean> {
  const header = req.headers.get("Authorization") ?? "";
  const bearer = header.startsWith("Bearer ");
  // Every path — unset ADMIN_TOKEN, missing header, non-Bearer header, and a
  // well-formed wrong token — must perform the same two SHA-256 digests before
  // deciding, using fixed fallback strings when there is nothing real to hash.
  // Otherwise the early-return paths are measurably cheaper than the full
  // compare, and repeated timing lets a prober infer "ADMIN_TOKEN is set on
  // this deployment" without ever guessing it (finding 4). Hashing both sides
  // to equal length so the compare never short-circuits on byteLength.
  const [a, b] = await Promise.all([
    crypto.subtle.digest(
      "SHA-256",
      enc.encode(bearer ? header.slice("Bearer ".length) : "no-header"),
    ),
    crypto.subtle.digest("SHA-256", enc.encode(token ?? "no-token")),
  ]);
  return Boolean(token) && bearer && timingSafeEqual(a, b);
}

const Status = z.enum(["pending", "approved", "suspended", "revoked"]);

// Upper bound is Number.MAX_SAFE_INTEGER, not just .positive() — GitHub ids
// persist through SQLite's REAL-backed integer column, so anything past that
// silently loses precision on write and reads back wrong (finding 5).
const SafeId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const TenantBody = z.object({
  installation_id: SafeId,
  org_login: z.string().min(1).max(39), // GitHub org login ceiling
  // No .default() anywhere in this object — it is a full-record upsert, so a
  // POST that omits ANY optional field must fail loudly (400) rather than
  // silently resetting that field to its creation default. A `.default()`
  // here previously let a routine "bump minute_grant" POST silently wipe
  // runner_group_id (Plan 2's gate-3 security boundary), contact, notes,
  // approved_by, job_ttl_ms and allow_all_repos back to their defaults
  // (fix wave 2, finding 1). `.nullable()` without `.default()` still
  // requires the key to be present — `null` must be sent explicitly, which is
  // the point: every write states its full intent.
  status: Status,
  allow_all_repos: z.boolean(),
  minute_grant: z.number().int().positive(),
  concurrency_cap: z.number().int().positive(),
  max_shape: z.string().regex(/^s-\d+vcpu-\d+gb$/),
  job_ttl_ms: z.number().int().positive(),
  runner_group_id: SafeId.nullable(),
  contact: z.string().max(10_000).nullable(), // holds a JSON blob from the onboarding form
  notes: z.string().max(2_000).nullable(),
  approved_by: z.string().max(100).nullable(),
});

const StatusBody = z.object({ installation_id: SafeId, status: Status });

const ProjectsBody = z.object({
  installation_id: SafeId,
  projects: z
    .array(
      z.object({
        repo_full_name: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
        repo_id: SafeId,
      }),
    )
    .min(1),
});

const ProjectDeleteBody = z.object({
  installation_id: SafeId,
  // Same regex as ProjectsBody.repo_full_name (finding 4) — a mistyped name
  // must fail validation, not pass and delete zero rows behind a 200.
  repo_full_name: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
});

const BackfillBody = z.object({ installation_id: SafeId });

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function handleAdmin(req: Request, env: Bindings): Promise<Response> {
  const config = loadConfig(env as Record<string, unknown>);
  if (!(await authorized(req, config.adminToken)))
    return new Response("not found", { status: 404 });

  const co = env.COORDINATOR.get(env.COORDINATOR.idFromName("singleton"));
  const route = `${req.method} ${new URL(req.url).pathname}`;

  try {
    if (route === "GET /admin/tenants") return json(await co.adminListTenants());

    if (route === "POST /admin/tenants") {
      const b = TenantBody.parse(await req.json());
      // Read-before-write is safe here: adminGetTenant never throws, so it
      // cannot poison the stub ahead of the single mutating call below (see
      // the stub-reuse note on the /admin/projects and DELETE routes).
      const existing = await co.adminGetTenant(b.installation_id);
      const wasApproved = existing?.tenant.status === "approved";
      const enteringApproved = b.status === "approved" && !wasApproved;
      // approved_at/approved_by together are one audit record of the most
      // recent time — and by whom — the tenant entered `approved`, so they
      // must never disagree about whether an approval happened. Both are
      // stamped fresh ONLY on an actual transition INTO approved (no prior
      // row, or the prior row's status wasn't approved): that write is the
      // real approval event, so approved_by comes from what this request
      // submitted. Both are otherwise carried forward unchanged from the
      // existing row — while an already-approved tenant is edited (an
      // unrelated grant bump must not silently reassign the approver, fix
      // wave 2 finding 3), AND when a write moves the tenant to
      // pending/suspended/revoked. That retention on the way out of approved
      // is deliberate, not an oversight: approved_at/by record a real event
      // in the tenant's history, and a later status change does not un-happen
      // it — nulling them on suspend destroyed the audit trail a subsequent
      // re-approval would otherwise extend. A later re-approval stamps both
      // fresh again, same as any other transition into approved.
      const approvedAt = enteringApproved ? Date.now() : (existing?.tenant.approvedAt ?? null);
      const approvedBy = enteringApproved ? b.approved_by : (existing?.tenant.approvedBy ?? null);
      const record: TenantRecord = {
        installationId: b.installation_id,
        orgLogin: b.org_login,
        status: b.status,
        allowAllRepos: b.allow_all_repos,
        minuteGrant: b.minute_grant,
        concurrencyCap: b.concurrency_cap,
        maxShape: b.max_shape,
        jobTtlMs: b.job_ttl_ms,
        runnerGroupId: b.runner_group_id,
        contact: b.contact,
        notes: b.notes,
        approvedAt,
        approvedBy,
      };
      await co.adminUpsertTenant(record);
      return json(record, 201);
    }

    if (route === "POST /admin/tenants/status") {
      const b = StatusBody.parse(await req.json());
      // Same pre-check pattern as /admin/projects and /admin/backfill (finding
      // 3): adminSetTenantStatus is an unconditional UPDATE, so a mistyped
      // installation_id would otherwise update zero rows and still 200 — on a
      // moderation surface that reads as "suspended" when nothing happened.
      if (!(await co.adminGetTenant(b.installation_id))) {
        return json({ error: "tenant not found", installation_id: b.installation_id }, 404);
      }
      await co.adminSetTenantStatus(b.installation_id, b.status);
      return json({ ok: true });
    }

    if (route === "POST /admin/projects") {
      const b = ProjectsBody.parse(await req.json());
      // adminAddProjects throws inside the DO for a nonexistent tenant (Task 3
      // guard, spec: an orphan project row must never be silently inherited by
      // a tenant created later with the same id). Checking existence first
      // turns that into a clean 404 without ever letting the throw cross the
      // stub — Cloudflare docs say a stub is unusable after one of its calls
      // rejects, and empirically (see admin.ts test suite) an exception that
      // DOES cross the real external stub corrupts vitest-pool-workers'
      // isolated-storage bookkeeping badly enough to crash the whole test run,
      // the same harness bug registry.test.ts works around with
      // runInDurableObject. A pre-check sidesteps both problems at once: it
      // reads a plain value over RPC (no error to misinterpret) instead of
      // inspecting a thrown error, and it never exercises the fragile
      // throw-across-stub path in the first place.
      if (!(await co.adminGetTenant(b.installation_id))) {
        return json({ error: "tenant not found", installation_id: b.installation_id }, 404);
      }
      await co.adminAddProjects(
        b.installation_id,
        b.projects.map((p) => ({ repoFullName: p.repo_full_name, repoId: p.repo_id })),
      );
      return json({ ok: true, added: b.projects.length });
    }

    if (route === "DELETE /admin/projects") {
      const b = ProjectDeleteBody.parse(await req.json());
      // Same pre-check as POST /admin/tenants/status: proves the TENANT
      // exists, but not that this repo was ever a project under it.
      if (!(await co.adminGetTenant(b.installation_id))) {
        return json({ error: "tenant not found", installation_id: b.installation_id }, 404);
      }
      // removeProject is an unconditional DELETE; a valid-shaped but mistyped
      // repo_full_name affects zero rows. Reporting {ok:true} anyway told the
      // operator a repo was revoked when it is still approved (fix wave 2,
      // finding 2) — the same failure class as the status no-op fixed above.
      const removed = await co.adminRemoveProject(b.installation_id, b.repo_full_name);
      if (removed === 0) {
        return json({ error: "project not found", repo_full_name: b.repo_full_name }, 404);
      }
      return json({ ok: true });
    }

    if (route === "POST /admin/backfill") {
      const b = BackfillBody.parse(await req.json());
      // Same pre-check as /admin/projects — adminBackfillTenantIds throws for
      // a nonexistent tenant (the backfill is irreversible; see registry.ts).
      if (!(await co.adminGetTenant(b.installation_id))) {
        return json({ error: "tenant not found", installation_id: b.installation_id }, 404);
      }
      return json({ ok: true, claimed: await co.adminBackfillTenantIds(b.installation_id) });
    }

    return new Response("not found", { status: 404 });
  } catch (err) {
    if (err instanceof z.ZodError) return json({ error: err.issues }, 400);
    // req.json() throws SyntaxError on a malformed/empty/truncated body — a
    // client mistake, not a server fault (finding 1; mirrors webhook.ts's
    // parseWorkflowJob, which catches JSON.parse failures the same way).
    if (err instanceof SyntaxError) return json({ error: "invalid JSON body" }, 400);
    throw err;
  }
}
