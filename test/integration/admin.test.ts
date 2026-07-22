import { env } from "cloudflare:test";
import { describe, it, expect, vi } from "vitest";
import { handleAdmin } from "../../src/admin";
import type { Bindings } from "../../src/index";
import type { TenantRecord } from "../../src/types";

const B = env as unknown as Bindings;

function req(method: string, path: string, body?: unknown, token = "test-admin-token") {
  return new Request(`https://ghar.test${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const tenantBody = (over: Record<string, unknown> = {}) => ({
  installation_id: 501,
  org_login: "acme",
  status: "pending",
  minute_grant: 5000,
  concurrency_cap: 5,
  max_shape: "s-4vcpu-8gb",
  ...over,
});

describe("admin auth", () => {
  it("404s a wrong token — no probeable surface", async () => {
    expect((await handleAdmin(req("GET", "/admin/tenants", undefined, "wrong"), B)).status).toBe(
      404,
    );
  });

  it("404s a missing Authorization header", async () => {
    expect((await handleAdmin(new Request("https://ghar.test/admin/tenants"), B)).status).toBe(404);
  });

  // Hard constraint: an unconfigured deployment and a probed one must be
  // indistinguishable — a byte-identical 404 (status AND body), not just the
  // same status code with different wording that would leak "there is an
  // admin surface here, you just guessed wrong".
  it("wrong token and missing token 404 byte-identically", async () => {
    const wrong = await handleAdmin(req("GET", "/admin/tenants", undefined, "wrong"), B);
    const missing = await handleAdmin(new Request("https://ghar.test/admin/tenants"), B);
    expect(wrong.status).toBe(missing.status);
    expect(await wrong.text()).toBe(await missing.text());
  });

  // Structural proof of the constant-time property, not just its outcome: a
  // pass/fail assertion on the auth result can never distinguish a constant-
  // time compare from a short-circuiting one (both classify right/wrong
  // tokens identically — that's the whole problem with timing side-channels).
  // What we CAN observe is the mechanism: both the header value and the
  // configured token get hashed to a fixed 32-byte digest before comparison,
  // regardless of the provided token's length, which is what denies the
  // byteLength check in timingSafeEqual anything to short-circuit on.
  it("hashes both the header and the configured token before comparing, for any token length", async () => {
    const digestSpy = vi.spyOn(crypto.subtle, "digest");
    await handleAdmin(req("GET", "/admin/tenants", undefined, "x"), B); // 1-char, wrong
    expect(digestSpy).toHaveBeenCalledTimes(2);
    digestSpy.mockClear();

    await handleAdmin(
      req("GET", "/admin/tenants", undefined, "a-much-longer-wrong-token-than-the-real-one"),
      B,
    );
    expect(digestSpy).toHaveBeenCalledTimes(2);
    digestSpy.mockRestore();
  });
});

describe("admin API", () => {
  it("creates, lists, and status-flips a tenant", async () => {
    const create = await handleAdmin(req("POST", "/admin/tenants", tenantBody()), B);
    expect(create.status).toBe(201);

    const list = await handleAdmin(req("GET", "/admin/tenants"), B);
    const tenants = (await list.json()) as TenantRecord[];
    expect(tenants.some((t) => t.installationId === 501 && t.status === "pending")).toBe(true);

    const flip = await handleAdmin(
      req("POST", "/admin/tenants/status", { installation_id: 501, status: "approved" }),
      B,
    );
    expect(flip.status).toBe(200);
  });

  it("400s an invalid body with zod issues", async () => {
    const res = await handleAdmin(
      req("POST", "/admin/tenants", { org_login: "", installation_id: -1 }),
      B,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toHaveProperty("error");
  });

  it("adds and removes projects", async () => {
    await handleAdmin(req("POST", "/admin/tenants", tenantBody({ installation_id: 502 })), B);
    const add = await handleAdmin(
      req("POST", "/admin/projects", {
        installation_id: 502,
        projects: [{ repo_full_name: "acme/api", repo_id: 11 }],
      }),
      B,
    );
    expect(((await add.json()) as { added: number }).added).toBe(1);

    const del = await handleAdmin(
      req("DELETE", "/admin/projects", { installation_id: 502, repo_full_name: "acme/api" }),
      B,
    );
    expect(del.status).toBe(200);
  });

  it("backfill endpoint reports claimed rows", async () => {
    // vitest-pool-workers isolates DO storage per test (confirmed empirically
    // — see task-4-report.md), so this cannot rely on tenant 501 from an
    // earlier `it`; seed its own tenant first.
    await handleAdmin(req("POST", "/admin/tenants", tenantBody({ installation_id: 503 })), B);
    const res = await handleAdmin(req("POST", "/admin/backfill", { installation_id: 503 }), B);
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty("claimed");
  });

  /**
   * Deviation 2 + 3, exercised through the REAL external stub (handleAdmin,
   * not runInDurableObject): adminAddProjects/adminBackfillTenantIds throw
   * inside the DO for a tenant that was never created. We verified directly
   * (a throwaway probe, since deleted) that letting such a throw actually
   * cross the real stub corrupts @cloudflare/vitest-pool-workers@0.8.71's
   * isolated-storage bookkeeping and crashes the whole test run — the same
   * harness bug test/integration/registry.test.ts documents working around
   * with runInDurableObject. admin.ts's pre-check (adminGetTenant before the
   * mutating call) sidesteps that: it never lets the throw happen for this
   * case, so this test exercises the real stub path start to finish. The
   * second assertion — an unrelated request still succeeding afterward — is
   * what would catch a regression back to "call-then-catch-the-throw", since
   * a poisoned/corrupted stub would fail it.
   */
  it("404s a projects-add for a nonexistent tenant, and a later request still works", async () => {
    const add = await handleAdmin(
      req("POST", "/admin/projects", {
        installation_id: 999_999,
        projects: [{ repo_full_name: "acme/ghost", repo_id: 1 }],
      }),
      B,
    );
    expect(add.status).toBe(404);
    expect(await add.json()).toEqual({ error: "tenant not found", installation_id: 999_999 });

    const list = await handleAdmin(req("GET", "/admin/tenants"), B);
    expect(list.status).toBe(200);
    expect(Array.isArray(await list.json())).toBe(true);
  });

  it("404s a backfill for a nonexistent tenant, and a later request still works", async () => {
    const backfill = await handleAdmin(
      req("POST", "/admin/backfill", { installation_id: 999_998 }),
      B,
    );
    expect(backfill.status).toBe(404);
    expect(await backfill.json()).toEqual({ error: "tenant not found", installation_id: 999_998 });

    // vitest-pool-workers isolates DO storage per test, so tenant 501 from an
    // earlier `it` isn't here either; seed one of our own for the flip.
    await handleAdmin(req("POST", "/admin/tenants", tenantBody({ installation_id: 506 })), B);
    const status = await handleAdmin(
      req("POST", "/admin/tenants/status", { installation_id: 506, status: "suspended" }),
      B,
    );
    expect(status.status).toBe(200);
  });

  // Finding 1: req.json() throws SyntaxError on a malformed body; that must
  // map to 400 like any other bad-input case, not fall through to a 500.
  it("400s a malformed JSON body instead of 500ing", async () => {
    const res = await handleAdmin(
      new Request("https://ghar.test/admin/tenants", {
        method: "POST",
        headers: { Authorization: "Bearer test-admin-token", "content-type": "application/json" },
        body: "{not valid json",
      }),
      B,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toHaveProperty("error");
  });

  // Finding 2: status had `.default("pending")`, so an upsert that changed a
  // quota field but forgot to restate status: "approved" would silently
  // demote an already-approved tenant back to pending. Making it required
  // turns the omission into a 400 instead of a silent moderation flip.
  it("400s a tenant upsert that omits status, rather than silently resetting it", async () => {
    const body = tenantBody({ installation_id: 504 });
    delete (body as Record<string, unknown>).status;
    const res = await handleAdmin(req("POST", "/admin/tenants", body), B);
    expect(res.status).toBe(400);
    expect(await res.json()).toHaveProperty("error");
  });

  // Finding 3: a status change or project delete for a mistyped
  // installation_id is an unconditional UPDATE/DELETE that touches zero rows
  // — it must 404, not silently 200 as if the moderation action took effect.
  it("404s a status change for a nonexistent tenant, and a later request still works", async () => {
    const status = await handleAdmin(
      req("POST", "/admin/tenants/status", { installation_id: 999_997, status: "suspended" }),
      B,
    );
    expect(status.status).toBe(404);
    expect(await status.json()).toEqual({ error: "tenant not found", installation_id: 999_997 });

    const list = await handleAdmin(req("GET", "/admin/tenants"), B);
    expect(list.status).toBe(200);
  });

  it("404s a project delete for a nonexistent tenant, and a later request still works", async () => {
    const del = await handleAdmin(
      req("DELETE", "/admin/projects", { installation_id: 999_996, repo_full_name: "acme/ghost" }),
      B,
    );
    expect(del.status).toBe(404);
    expect(await del.json()).toEqual({ error: "tenant not found", installation_id: 999_996 });

    const list = await handleAdmin(req("GET", "/admin/tenants"), B);
    expect(list.status).toBe(200);
  });

  // Finding 4: ProjectDeleteBody only had `.min(3)`, so a mistyped
  // repo_full_name (no "owner/repo" shape) passed validation and deleted zero
  // rows behind a 200. The delete path must reject it the same way the add
  // path already does.
  it("400s a project delete whose repo_full_name isn't owner/repo shaped", async () => {
    await handleAdmin(req("POST", "/admin/tenants", tenantBody({ installation_id: 505 })), B);
    const res = await handleAdmin(
      req("DELETE", "/admin/projects", { installation_id: 505, repo_full_name: "acmeapi" }),
      B,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toHaveProperty("error");
  });

  // Finding 5: installation_id (and other persisted ids) had no upper bound,
  // so a value past Number.MAX_SAFE_INTEGER would silently lose precision on
  // write. Reject it at the boundary instead.
  it("400s an installation_id past Number.MAX_SAFE_INTEGER", async () => {
    const res = await handleAdmin(
      req(
        "POST",
        "/admin/tenants",
        tenantBody({ installation_id: Number.MAX_SAFE_INTEGER + 1024 }),
      ),
      B,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toHaveProperty("error");
  });
});
