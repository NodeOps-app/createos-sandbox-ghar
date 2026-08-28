import { z } from "zod";
import type { Bindings } from "./index";
import { loadConfig } from "./config";
import { timingSafeEqual } from "./webhook";
import { GitHubClient } from "./github/client";
import { listAppInstallations, type AppInstallation } from "./github/auth";
import type { TenantRecord } from "./types";
import { DASHBOARD_HTML, loginHtml } from "./dashboard";
import { monthKey } from "./quota";

/**
 * Operator-only tenant registry API. Manual approval is the design (spec D16):
 * a Google-Form applicant is vetted by a human, then these endpoints record the
 * decision — approval must never require a deploy, because a push to main IS a
 * production deploy. Missing token and wrong token both 404, so an unconfigured
 * deployment exposes no probeable surface.
 */

const enc = new TextEncoder();

/**
 * The dashboard session cookie. A browser cannot put a Bearer header on a
 * top-level navigation, so the operator posts the token once to
 * `/admin/dashboard/login` and every later load — and every JSON poll — carries
 * this instead. Scoped to `/admin`, HttpOnly, Secure and SameSite=Strict, so no
 * other origin and no script can make the browser spend it.
 *
 * Its VALUE IS NOT THE ADMIN TOKEN. It is `<expiryMs>.<HMAC(ADMIN_TOKEN,
 * expiryMs)>` — an opaque, self-expiring bearer of one capability: read the
 * dashboard. Stolen, it cannot be replayed as `Authorization: Bearer` against
 * the admin WRITE routes, and it dies on its own at SESSION_TTL_MS. Signing it
 * with the admin token rather than a stored session id keeps the DO out of the
 * auth path entirely; the cost is that individual sessions cannot be revoked —
 * rotating ADMIN_TOKEN invalidates every one of them at once, which is the
 * revocation this single-operator surface actually has.
 */
const COOKIE = "ghar_dash";

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

function cookieValue(req: Request, name: string): string | null {
  for (const part of (req.headers.get("Cookie") ?? "").split(";")) {
    const t = part.trim();
    if (t.startsWith(`${name}=`)) return decodeURIComponent(t.slice(name.length + 1));
  }
  return null;
}

async function hmac(token: string, message: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", key, enc.encode(message));
}

const b64url = (buf: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

/** The `Set-Cookie` value for a fresh dashboard session. */
async function mintSession(token: string, nowMs: number): Promise<string> {
  const exp = String(nowMs + SESSION_TTL_MS);
  const value = `${exp}.${b64url(await hmac(token, exp))}`;
  return (
    `${COOKIE}=${encodeURIComponent(value)}; Path=/admin; HttpOnly; Secure; ` +
    `SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  );
}

async function sessionValid(
  cookie: string | null,
  token: string | undefined,
  nowMs: number,
): Promise<boolean> {
  const [expPart = "", sigPart = ""] = (cookie ?? "").split(".");
  // Same constant-work discipline as secretMatches: the HMAC is computed on
  // every path, with a fixed fallback key when ADMIN_TOKEN is unset, so timing
  // never reveals whether this deployment has one.
  const expected = b64url(await hmac(token ?? "no-token", expPart));
  const exp = Number(expPart);
  // A plain === on the digests is deliberate: what it compares is an HMAC
  // OUTPUT, not a secret. An attacker who can time it learns a prefix of a
  // digest they still cannot forge without the key.
  return Boolean(token) && Number.isSafeInteger(exp) && exp > nowMs && expected === sigPart;
}

async function secretMatches(
  presented: string | null,
  token: string | undefined,
): Promise<boolean> {
  // Every path — unset ADMIN_TOKEN, no credential at all, and a well-formed
  // wrong token — must perform the same two SHA-256 digests before deciding,
  // using fixed fallback strings when there is nothing real to hash. Otherwise
  // the early-return paths are measurably cheaper than the full compare, and
  // repeated timing lets a prober infer "ADMIN_TOKEN is set on this
  // deployment" without ever guessing it (finding 4). Hashing both sides to
  // equal length so the compare never short-circuits on byteLength.
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(presented ?? "no-header")),
    crypto.subtle.digest("SHA-256", enc.encode(token ?? "no-token")),
  ]);
  return Boolean(token) && presented !== null && timingSafeEqual(a, b);
}

/**
 * Two credentials, deliberately unequal in POWER — which is the whole point of
 * the session, so the caller must branch on which one arrived, never on a bare
 * boolean. `token` is the admin token itself and opens every route, read and
 * write. `session` is the signed cookie minted from it and opens the dashboard
 * reads and nothing else: stolen, it cannot be replayed as a Bearer credential
 * (it is not the token) and it cannot reach the tenant registry (this
 * distinction), so it is worth strictly less than the secret behind it.
 */
type Credential = "token" | "session" | null;

async function authenticate(
  req: Request,
  token: string | undefined,
  nowMs: number,
): Promise<Credential> {
  const header = req.headers.get("Authorization") ?? "";
  if (header.startsWith("Bearer ")) {
    return (await secretMatches(header.slice("Bearer ".length), token)) ? "token" : null;
  }
  return (await sessionValid(cookieValue(req, COOKIE), token, nowMs)) ? "session" : null;
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

const StatusBody = z.object({
  installation_id: SafeId,
  // Approval is deliberately NOT settable here: only the full upsert stamps
  // approved_at/approved_by, and this route only ever calls
  // adminSetTenantStatus, which updates status alone — accepting "approved"
  // here would misrecord an approval with no audit trail (fix wave 4).
  status: z.enum(["pending", "suspended", "revoked"]),
});

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

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Both pages are entirely self-contained: no external script, style, font
      // or image. Say so, so an injected one cannot run.
      "content-security-policy":
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
        "form-action 'self'; connect-src 'self'",
      // The login form carries a secret in its body — no URL of ours should
      // ever travel to a third party, and nothing here should be cached.
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    },
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function handleAdmin(
  req: Request,
  env: Bindings,
  // Test seam only — production callers omit it and GitHubClient falls back
  // to fetch.bind(globalThis). Never hit the network in tests (mockFetch).
  fetchImpl?: typeof fetch,
): Promise<Response> {
  const config = loadConfig(env as Record<string, unknown>);
  const url = new URL(req.url);

  const now = Date.now();
  const credential = await authenticate(req, config.adminToken, now);

  // The login exchange, BEFORE any session exists. A POST body — never a query
  // string: a URL is written to browser history, to the Referer of anything the
  // page later loads, and to every access log in front of the Worker, and the
  // admin token is reusable and opens the WRITE routes. What the browser gets
  // back is a signed, expiring session, not the token it sent.
  if (req.method === "POST" && url.pathname === "/admin/dashboard/login") {
    const form = await req.formData().catch(() => null);
    const presented = form ? String(form.get("token") ?? "") : "";
    if (!(await secretMatches(presented, config.adminToken))) {
      // 401 + the form again, not 404: the page is already public (see below),
      // so there is nothing left to hide here, and an operator who fat-fingers
      // the token needs to be told.
      return htmlResponse(loginHtml(true), 401);
    }
    return new Response(null, {
      status: 303,
      headers: {
        location: "/admin/dashboard",
        "set-cookie": await mintSession(config.adminToken as string, now),
      },
    });
  }

  // The dashboard page is the ONE admin path that answers without a credential
  // — it has to, since a browser cannot present one on a navigation. It gives
  // up nothing: the login form is byte-identical whether or not ADMIN_TOKEN is
  // set, so the "an unconfigured deployment is indistinguishable from a
  // configured one" property still holds, and the page itself carries no data.
  // Every other admin route keeps 404-ing below.
  if (req.method === "GET" && url.pathname === "/admin/dashboard") {
    return htmlResponse(credential ? DASHBOARD_HTML : loginHtml(false));
  }

  // The session cookie stops here. `/admin/dashboard.json` is the one read it
  // is a capability FOR; everything past this line is the tenant registry,
  // which only the admin token itself opens. Without this line the cookie would
  // be a full admin credential in a browser jar, and the whole point of not
  // storing the token would be lost.
  const sessionMayRead = credential === "session" && url.pathname === "/admin/dashboard.json";
  if (credential !== "token" && !sessionMayRead) {
    return new Response("not found", { status: 404 });
  }

  const co = env.COORDINATOR.get(env.COORDINATOR.idFromName("singleton"));
  const route = `${req.method} ${url.pathname}`;

  try {
    if (route === "GET /admin/dashboard.json") {
      // Live rows plus the only history the DO keeps: this UTC month and the
      // one before it. Date.UTC normalises month -1 back into December.
      const d = new Date(now);
      const months = {
        current: monthKey(now),
        previous: monthKey(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)),
      };
      const snapshot = await co.dashboard(now, [months.current, months.previous]);
      return json({ ...snapshot, months });
    }

    if (route === "GET /admin/installations") {
      // The onboarding lookup: which orgs have installed our App, and under
      // which installation id. Read-only, and the ONLY way an operator can
      // resolve a community tenant's installation id — see listAppInstallations
      // for why neither `gh` nor a local key can do it. `?org=<login>` filters
      // (case-insensitively, since GitHub logins are).
      const org = url.searchParams.get("org");
      let installations: AppInstallation[];
      try {
        installations = await listAppInstallations(config, fetchImpl);
      } catch (err) {
        console.error(`list app installations failed: ${String(err)}`);
        return json({ error: `list app installations failed: ${String(err)}` }, 502);
      }
      if (org !== null) {
        const wanted = org.toLowerCase();
        const hit = installations.find((i) => i.accountLogin.toLowerCase() === wanted);
        // 404 rather than an empty list, matching GET /admin/tenants?id=: a
        // mistyped org must read as "not found", never as "installed nothing".
        if (!hit) return json({ error: "no installation for org", org }, 404);
        return json(hit);
      }
      return json(installations);
    }

    if (route === "GET /admin/tenants") {
      // ?id=<installation_id> reads a single tenant (+ its projects) via
      // adminGetTenant — the read the onboarding script and operators actually
      // want. No id = the full list. 404 (not an empty list) for an unknown id,
      // so a mistyped id reads as "not found", not "no tenants".
      const idParam = url.searchParams.get("id");
      if (idParam !== null) {
        const id = Number(idParam);
        if (!Number.isSafeInteger(id) || id <= 0) {
          return json({ error: "invalid id", installation_id: idParam }, 400);
        }
        const got = await co.adminGetTenant(id);
        if (!got) return json({ error: "tenant not found", installation_id: id }, 404);
        return json(got);
      }
      return json(await co.adminListTenants());
    }

    if (route === "GET /admin/stale-jobs") {
      // Debug/incident-response read: the same "stuck longer than threshold"
      // check the cron alert (alertStaleJobs) runs, exposed on demand across
      // every tenant — an operator chasing a live incident for one org can't
      // wait for the next 5-minute tick, and has no other way to see a
      // community tenant's job state (no CreateOS/GitHub access of their own).
      // Unfiltered by tenant on purpose (spans every org in one call); a
      // caller narrows by grepping repoFullName ("org/repo") client-side.
      const thresholdParam = url.searchParams.get("threshold_ms");
      let thresholdMs = config.slowJobThresholdMs;
      if (thresholdParam !== null) {
        thresholdMs = Number(thresholdParam);
        if (!Number.isSafeInteger(thresholdMs) || thresholdMs < 0) {
          return json({ error: "invalid threshold_ms", threshold_ms: thresholdParam }, 400);
        }
      }
      return json(await co.staleJobs(Date.now(), thresholdMs));
    }

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

      let runnerGroupId = b.runner_group_id;
      if (b.status === "approved" && !b.allow_all_repos) {
        // Gate 3 is GitHub-side: EVERY approved-scoped write must carry a
        // scoped runner group, not just the transition into `approved` — an
        // already-approved tenant re-upserted with a null/absent group (or
        // flipped from allow_all_repos) must not silently fall back to the
        // org's Default group (visibility: all repos), which would let an
        // unapproved repo schedule onto the tenant's runners (D12). This
        // makes createRunnerGroup idempotent-adopt (409 → existing group id)
        // on every such upsert — one extra GitHub call, cheap at admin
        // frequency, and the price of the fail-closed guarantee.
        const projects = existing ? existing.projects : [];
        if (projects.length === 0) {
          return json({ error: "cannot approve: no approved projects; add projects first" }, 400);
        }
        try {
          const gh = new GitHubClient(config, fetchImpl, {
            orgLogin: b.org_login,
            installationId: b.installation_id,
          });
          runnerGroupId = await gh.createRunnerGroup(
            "createos",
            projects.map((p) => p.repoId),
          );
        } catch (err) {
          console.error(`runner group creation failed org=${b.org_login}: ${String(err)}`);
          return json({ error: `runner group creation failed: ${String(err)}` }, 502);
        }
      }

      const record: TenantRecord = {
        installationId: b.installation_id,
        orgLogin: b.org_login,
        status: b.status,
        allowAllRepos: b.allow_all_repos,
        minuteGrant: b.minute_grant,
        concurrencyCap: b.concurrency_cap,
        maxShape: b.max_shape,
        jobTtlMs: b.job_ttl_ms,
        runnerGroupId,
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
      const existing = await co.adminGetTenant(b.installation_id);
      if (!existing) {
        return json({ error: "tenant not found", installation_id: b.installation_id }, 404);
      }
      // Write-then-sync, in that order, so a GitHub failure can never leave
      // the group WIDER than the registry — only the reverse (group
      // narrower, registry ahead) is tolerated: that repo simply can't get a
      // runner until the sync retries and catches up.
      await co.adminAddProjects(
        b.installation_id,
        b.projects.map((p) => ({ repoFullName: p.repo_full_name, repoId: p.repo_id })),
      );
      if (
        existing.tenant.status === "approved" &&
        !existing.tenant.allowAllRepos &&
        existing.tenant.runnerGroupId !== null
      ) {
        const union = new Set(existing.projects.map((p) => p.repoId));
        for (const p of b.projects) union.add(p.repo_id);
        try {
          const gh = new GitHubClient(config, fetchImpl, {
            orgLogin: existing.tenant.orgLogin,
            installationId: existing.tenant.installationId,
          });
          await gh.setRunnerGroupRepos(existing.tenant.runnerGroupId, [...union]);
        } catch (err) {
          console.error(`runner group sync failed org=${existing.tenant.orgLogin}: ${String(err)}`);
          return json({ error: `runner group sync failed: ${String(err)}` }, 502);
        }
      }
      return json({ ok: true, added: b.projects.length });
    }

    if (route === "DELETE /admin/projects") {
      const b = ProjectDeleteBody.parse(await req.json());
      // Same pre-check as POST /admin/tenants/status: proves the TENANT
      // exists, but not that this repo was ever a project under it.
      const existing = await co.adminGetTenant(b.installation_id);
      if (!existing) {
        return json({ error: "tenant not found", installation_id: b.installation_id }, 404);
      }
      const target = existing.projects.find((p) => p.repoFullName === b.repo_full_name);
      // Only sync when the repo is actually a tracked project — otherwise the
      // delete below is a guaranteed 404 no-op and the removal changes nothing
      // for GitHub to reflect. A dropped repo narrows the group, which is the
      // permitted direction (never wider than the registry is about to be).
      if (
        target &&
        existing.tenant.status === "approved" &&
        !existing.tenant.allowAllRepos &&
        existing.tenant.runnerGroupId !== null
      ) {
        const remaining = existing.projects
          .filter((p) => p.repoFullName !== b.repo_full_name)
          .map((p) => p.repoId);
        try {
          const gh = new GitHubClient(config, fetchImpl, {
            orgLogin: existing.tenant.orgLogin,
            installationId: existing.tenant.installationId,
          });
          await gh.setRunnerGroupRepos(existing.tenant.runnerGroupId, remaining);
        } catch (err) {
          console.error(`runner group sync failed org=${existing.tenant.orgLogin}: ${String(err)}`);
          return json({ error: `runner group sync failed: ${String(err)}` }, 502);
        }
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
