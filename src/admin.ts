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
  if (!token) return false;
  const header = req.headers.get("Authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  // Hash both sides to equal length so the constant-time compare never
  // short-circuits on length — the only thing it may leak is "wrong".
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(header.slice("Bearer ".length))),
    crypto.subtle.digest("SHA-256", enc.encode(token)),
  ]);
  return timingSafeEqual(a, b);
}

const Status = z.enum(["pending", "approved", "suspended", "revoked"]);

// Upper bound is Number.MAX_SAFE_INTEGER, not just .positive() — GitHub ids
// persist through SQLite's REAL-backed integer column, so anything past that
// silently loses precision on write and reads back wrong (finding 5).
const SafeId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const TenantBody = z.object({
  installation_id: SafeId,
  org_login: z.string().min(1).max(39), // GitHub org login ceiling
  // No .default() — this is an upsert of the whole row, so a POST that omits
  // status must fail loudly rather than silently demoting an already-
  // approved tenant back to pending (finding 2).
  status: Status,
  allow_all_repos: z.boolean().default(false),
  minute_grant: z.number().int().positive(),
  concurrency_cap: z.number().int().positive(),
  max_shape: z.string().regex(/^s-\d+vcpu-\d+gb$/),
  job_ttl_ms: z.number().int().positive().default(1_800_000),
  runner_group_id: SafeId.nullable().default(null),
  contact: z.string().max(10_000).nullable().default(null), // holds a JSON blob from the onboarding form
  notes: z.string().max(2_000).nullable().default(null),
  approved_by: z.string().max(100).nullable().default(null),
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
        approvedAt: b.status === "approved" ? Date.now() : null,
        approvedBy: b.approved_by,
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
      // Same pre-check as POST /admin/tenants/status (finding 3): removeProject
      // is also an unconditional DELETE, zero-rows-affected and all.
      if (!(await co.adminGetTenant(b.installation_id))) {
        return json({ error: "tenant not found", installation_id: b.installation_id }, 404);
      }
      await co.adminRemoveProject(b.installation_id, b.repo_full_name);
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
