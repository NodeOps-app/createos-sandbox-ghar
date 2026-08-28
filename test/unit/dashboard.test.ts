import { describe, it, expect } from "vitest";
import { aggregateUsage, DASHBOARD_HTML } from "../../src/dashboard";
import type { DashboardSnapshot } from "../../src/types";

const months = { current: "2026-08", previous: "2026-07" };

const row = (
  installationId: number,
  month: string,
  repoFullName: string,
  weightedMinutes: number,
  egressBytes = 0,
) => ({ installationId, month, repoFullName, weightedMinutes, egressBytes });

const snap = (usage: DashboardSnapshot["usage"], tenants: DashboardSnapshot["tenants"] = []) =>
  ({ nowMs: 0, jobs: [], usage, tenants, months }) as never;

describe("aggregateUsage", () => {
  // The bug this function exists to prevent, in the exact shape production
  // showed it: `markDestroyed` bills every VM lifetime TWICE — once under
  // repo_full_name "" (the tenant total the grant is enforced against) and
  // once under the real repo. Summing all rows reported NodeOps-app at 56,023
  // weighted minutes when the true figure was 28,038, and drew the "" row as a
  // nameless repo. It also doubled the "of grant" bar.
  it("does not double-count the tenant total against its per-repo rows", () => {
    const groups = aggregateUsage(
      snap(
        [
          row(144593770, "2026-08", "", 28037.8, 300),
          row(144593770, "2026-08", "NodeOps-app/createos-studio", 20948.5, 200),
          row(144593770, "2026-08", "NodeOps-app/createos-sandbox-sdk", 2967.6, 100),
          row(144593770, "2026-08", "NodeOps-app/OmniRoute", 4121.7),
        ],
        [
          {
            installationId: 144593770,
            orgLogin: "NodeOps-app",
            status: "approved",
            minuteGrant: 140000,
          },
        ],
      ),
    );

    expect(groups).toHaveLength(1);
    const g = groups[0]!;
    expect(g.label).toBe("NodeOps-app");
    // The "" row, not the sum of every row (which would be 56,075.6).
    expect(g.current).toBeCloseTo(28037.8, 1);
    expect(g.egress).toBe(300);
    // Three named repos — the "" row must never appear as one.
    expect(g.repos.map(([name]) => name)).toEqual([
      "NodeOps-app/createos-studio",
      "NodeOps-app/OmniRoute",
      "NodeOps-app/createos-sandbox-sdk",
    ]);
    expect(g.repos.some(([name]) => name === "")).toBe(false);
    // And the breakdown must reconcile with the total it sits under.
    const summed = g.repos.reduce((n, [, r]) => n + r.current, 0);
    expect(summed).toBeCloseTo(g.current, 1);
  });

  it("keeps the tenant total and the repo rows separate across both months", () => {
    const groups = aggregateUsage(
      snap([
        row(148729369, "2026-08", "", 6.5),
        row(148729369, "2026-08", "atlasnetwork-xyz/test-ghar", 6.5),
        row(148729369, "2026-07", "", 353.3),
        row(148729369, "2026-07", "atlasnetwork-xyz/test-ghar", 353.3),
      ]),
    );
    const g = groups[0]!;
    expect(g.current).toBeCloseTo(6.5, 1);
    expect(g.previous).toBeCloseTo(353.3, 1);
    expect(g.repos).toHaveLength(1);
  });

  // Row order is whatever SQLite returns, so the "" row arriving AFTER its
  // repos must reset the fallback rather than add to it.
  it("prefers the enforcement row whichever order the rows arrive in", () => {
    const forward = aggregateUsage(
      snap([row(1, "2026-08", "", 100), row(1, "2026-08", "a/b", 100)]),
    );
    const reverse = aggregateUsage(
      snap([row(1, "2026-08", "a/b", 100), row(1, "2026-08", "", 100)]),
    );
    expect(forward[0]!.current).toBe(100);
    expect(reverse[0]!.current).toBe(100);
  });

  // Defensive, not observed: if a tenant somehow has attribution rows and no
  // enforcement row, the line must still show a number rather than zero.
  it("falls back to summing repos when no enforcement row exists", () => {
    const groups = aggregateUsage(
      snap([row(1, "2026-08", "a/b", 10, 5), row(1, "2026-08", "a/c", 7, 3)]),
    );
    expect(groups[0]!.current).toBe(17);
    expect(groups[0]!.egress).toBe(8);
  });

  it("labels a tenant with no registry row by its installation id", () => {
    const groups = aggregateUsage(snap([row(999, "2026-08", "", 5)]));
    expect(groups[0]!.label).toBe("installation 999");
    expect(groups[0]!.grant).toBe(0);
  });

  it("sorts tenants, and each tenant's repos, by this month's spend", () => {
    const groups = aggregateUsage(
      snap([
        row(1, "2026-08", "", 10),
        row(1, "2026-08", "a/small", 3),
        row(1, "2026-08", "a/big", 7),
        row(2, "2026-08", "", 50),
      ]),
    );
    expect(groups.map((g) => g.current)).toEqual([50, 10]);
    expect(groups[1]!.repos.map(([n]) => n)).toEqual(["a/big", "a/small"]);
  });
});

describe("dashboard page", () => {
  // The page inlines aggregateUsage via .toString(), so the browser and the
  // tests above run the SAME code. If the interpolation ever breaks, the page
  // silently loses the function and every tenant row disappears.
  it("inlines the real aggregateUsage into the page", () => {
    expect(DASHBOARD_HTML).toContain("function aggregateUsage");
    expect(DASHBOARD_HTML).toContain("const groups = aggregateUsage(snap)");
    // Comments do NOT survive the transpile into .toString(), so the page
    // carries the logic without its rationale. Assert the load-bearing branch
    // instead: the "" enforcement row must still be special-cased in there.
    expect(DASHBOARD_HTML).toContain('u.repoFullName === ""');
  });

  // The numbers are weighted minutes (wall-clock x vCPU/2), not GitHub's
  // Actions minutes. A reader who compares the two without being told will
  // report a bug that is not one — createos-studio read 20,948 here against
  // GitHub's 9,550 for the same month.
  it("says on the page that the minutes are weighted, and why they differ from GitHub", () => {
    expect(DASHBOARD_HTML).toContain("weighted");
    expect(DASHBOARD_HTML).toContain("vCPU / 2");
    expect(DASHBOARD_HTML).toContain("GitHub");
  });
});
