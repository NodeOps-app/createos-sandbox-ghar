import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { handleAdmin } from "../../src/admin";
import type { Bindings } from "../../src/index";

const B = env as unknown as Bindings;

const url = (path: string) => `https://ghar.test${path}`;
const pad = (n: number) => String(n).padStart(2, "0");

function req(method: string, path: string, token = "test-admin-token") {
  return new Request(url(path), { method, headers: { Authorization: `Bearer ${token}` } });
}

describe("admin dashboard login", () => {
  const login = (token: string) =>
    new Request(url("/admin/dashboard/login"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });

  /** Drive the real login exchange and hand back the cookie a browser would keep. */
  async function session(token = "test-admin-token"): Promise<string> {
    const res = await handleAdmin(login(token), B);
    expect(res.status).toBe(303);
    return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  }

  it("mints a scoped session on a correct token", async () => {
    const res = await handleAdmin(login("test-admin-token"), B);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin/dashboard");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/admin");
    expect(cookie).toContain("Max-Age=28800");
  });

  // THE finding this flow exists to close (Codex, high): the admin token is
  // reusable and opens every WRITE route, so what the browser stores must not
  // BE that token. A stolen cookie must be worth strictly less than the secret
  // that minted it.
  it("never puts the admin token in the cookie, and the cookie is not a Bearer token", async () => {
    const cookie = await session();
    expect(cookie).not.toContain("test-admin-token");

    // Replay the cookie's value as a Bearer credential — the escalation an
    // attacker with the cookie would try first. It must not open a write route.
    const value = decodeURIComponent(cookie.split("=").slice(1).join("="));
    const replayed = await handleAdmin(
      new Request(url("/admin/tenants"), { headers: { Authorization: `Bearer ${value}` } }),
      B,
    );
    expect(replayed.status).toBe(404);
  });

  it("opens the dashboard JSON with the session cookie", async () => {
    const cookie = await session();
    const res = await handleAdmin(
      new Request(url("/admin/dashboard.json"), { headers: { Cookie: `other=1; ${cookie}` } }),
      B,
    );
    expect(res.status).toBe(200);
  });

  // The session is a dashboard-read capability, not an admin credential. It
  // must not reach the tenant-registry routes.
  it("does not open the admin write routes", async () => {
    const cookie = await session();
    const res = await handleAdmin(
      new Request(url("/admin/tenants"), { headers: { Cookie: cookie } }),
      B,
    );
    expect(res.status).toBe(404);
  });

  it("401s a wrong token and mints nothing", async () => {
    const res = await handleAdmin(login("wrong"), B);
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.text()).toContain("not accepted");
  });

  it.each([
    ["a forged signature", "ghar_dash=99999999999999.deadbeef"],
    ["no signature at all", "ghar_dash=99999999999999"],
    ["a garbage value", "ghar_dash=wrong"],
    // Expiry is inside the signed payload, so a past one cannot be edited
    // forward without the key — but it must also be CHECKED, not just signed.
    ["an expired session", "ghar_dash=1.aaaa"],
  ])("rejects %s", async (_name, cookie) => {
    const res = await handleAdmin(
      new Request(url("/admin/dashboard.json"), { headers: { Cookie: cookie } }),
      B,
    );
    expect(res.status).toBe(404);
  });

  // A real expiry check, signed by the real key: mint a session, then assert a
  // cookie whose expiry has passed is refused. Built by re-signing through the
  // login route is impossible (it always stamps now+8h), so this pins the
  // structure instead — the signature covers the expiry, so tampering with the
  // expiry invalidates the signature.
  it("refuses a session whose expiry was edited", async () => {
    const cookie = await session();
    const [, value = ""] = cookie.split("=");
    const sig = decodeURIComponent(value).split(".")[1]!;
    const res = await handleAdmin(
      new Request(url("/admin/dashboard.json"), { headers: { Cookie: `ghar_dash=1.${sig}` } }),
      B,
    );
    expect(res.status).toBe(404);
  });

  // The expiry must be CHECKED, not merely signed. Every other rejection test
  // above trips the signature first, so none of them can see a missing expiry
  // check — this one signs a real cookie with the real key, exactly as the
  // server does, and only backdates the timestamp. It doubles as an
  // independent statement of the cookie format.
  it("refuses a correctly signed session whose expiry has passed", async () => {
    const sign = async (exp: string) => {
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode("test-admin-token"),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(exp));
      return btoa(String.fromCharCode(...new Uint8Array(sig)))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "");
    };
    const ask = async (exp: string) =>
      (
        await handleAdmin(
          new Request(url("/admin/dashboard.json"), {
            headers: { Cookie: `ghar_dash=${encodeURIComponent(`${exp}.${await sign(exp)}`)}` },
          }),
          B,
        )
      ).status;

    // Control: the same construction with a future expiry IS accepted, which is
    // what proves the refusal below is the expiry and not a broken fixture.
    expect(await ask(String(Date.now() + 60_000))).toBe(200);
    expect(await ask(String(Date.now() - 1000))).toBe(404);
  });

  // A browser cannot send a Bearer header on a navigation, so this one path
  // must answer without a credential. It gives up nothing: the form is
  // byte-identical whatever ADMIN_TOKEN is, and carries no data.
  it("serves the login form — not a 404 — to an unauthenticated page load", async () => {
    const res = await handleAdmin(new Request(url("/admin/dashboard")), B);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('action="/admin/dashboard/login"');
    expect(body).toContain('type="password"');
    expect(body).not.toContain("Jobs in flight"); // no data on the login page

    // Identical when ADMIN_TOKEN is unset — the probe must learn nothing.
    const unset = await handleAdmin(new Request(url("/admin/dashboard")), {
      ...B,
      ADMIN_TOKEN: undefined,
    } as unknown as Bindings);
    expect(await unset.text()).toBe(body);
  });

  it("keeps every other admin route 404ing without a credential", async () => {
    expect((await handleAdmin(new Request(url("/admin/dashboard.json")), B)).status).toBe(404);
    expect((await handleAdmin(new Request(url("/admin/tenants")), B)).status).toBe(404);
  });
});

describe("admin dashboard", () => {
  it("serves a self-contained HTML page", async () => {
    const res = await handleAdmin(req("GET", "/admin/dashboard"), B);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("/admin/dashboard.json");
    // No external subresource may creep in — the CSP forbids it, and a page
    // that silently loses its chart library is worse than one that never had it.
    expect(body).not.toMatch(/src="https?:/);
  });

  it("reports live jobs and this/last month usage", async () => {
    const id = B.COORDINATOR.idFromName("singleton");
    const stub = B.COORDINATOR.get(id);
    const now = Date.now();
    const d = new Date(now);
    const current = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
    const prevD = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
    const previous = `${prevD.getUTCFullYear()}-${pad(prevD.getUTCMonth() + 1)}`;

    await runInDurableObject(stub, async (_i, state) => {
      state.storage.sql.exec(
        `INSERT INTO jobs (job_id, run_id, repo, state, created_at, label, region, attempts, tenant_id)
         VALUES (91, 7, 'acme/app', 'running', ?, 'ghar-4vcpu-8gb', 'eu', 1, 900)`,
        now - 60_000,
      );
      state.storage.sql.exec(
        `INSERT INTO tenants (installation_id, org_login, status, allow_all_repos, minute_grant,
                              concurrency_cap, max_shape, job_ttl_ms)
         VALUES (900, 'acme', 'approved', 0, 5000, 5, 's-4vcpu-8gb', 1800000)`,
      );
      state.storage.sql.exec(
        `INSERT INTO usage (installation_id, month, repo_full_name, weighted_minutes, egress_bytes)
         VALUES (900, ?, 'acme/app', 120.5, 4096), (900, ?, 'acme/app', 80, 1024)`,
        current,
        previous,
      );
    });

    const res = await handleAdmin(req("GET", "/admin/dashboard.json"), B);
    expect(res.status).toBe(200);
    const snap = (await res.json()) as {
      months: { current: string; previous: string };
      jobs: { jobId: number; state: string; region: string | null }[];
      usage: { month: string; weightedMinutes: number }[];
      tenants: { orgLogin: string; minuteGrant: number }[];
    };

    expect(snap.months).toEqual({ current, previous });
    expect(snap.jobs).toHaveLength(1);
    expect(snap.jobs[0]).toMatchObject({ jobId: 91, state: "running", region: "eu" });
    expect(snap.tenants).toContainEqual(
      expect.objectContaining({ orgLogin: "acme", minuteGrant: 5000 }),
    );
    expect(new Set(snap.usage.map((u) => u.month))).toEqual(new Set([current, previous]));
    expect(snap.usage.find((u) => u.month === current)?.weightedMinutes).toBe(120.5);
  });
});
