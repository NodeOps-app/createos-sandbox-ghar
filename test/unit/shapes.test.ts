import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Shape } from "@nodeops-createos/sandbox";
import { loadConfig } from "../../src/config";
import {
  createosLabels,
  shapeForLabel,
  usableShapes,
  resolveRequestedLabel,
  validateShape,
  fetchCatalog,
  resetShapeCacheForTests,
  type Catalog,
} from "../../src/shapes";
import type { Config } from "../../src/types";

const config: Config = loadConfig({
  GITHUB_ORG: "nodeops-app",
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY: "pk",
  GITHUB_INSTALLATION_ID: "2",
  GITHUB_WEBHOOK_SECRET: "s",
  CREATEOS_BASE_URL: "https://api.sb.createos.sh",
  CREATEOS_API_KEY: "k",
  RUNNER_TEMPLATE: "ghar-runner",
});

const CATALOG = [
  { id: "s-0.25vcpu-512mb", vcpu: 1, mem_mib: 512, default_disk_mib: 10240, cpu_quota_pct: 25 },
  { id: "s-0.5vcpu-1gb", vcpu: 1, mem_mib: 1024, default_disk_mib: 10240, cpu_quota_pct: 50 },
  { id: "s-1vcpu-256mb", vcpu: 1, mem_mib: 256, default_disk_mib: 10240 },
  { id: "s-1vcpu-1gb", vcpu: 1, mem_mib: 1024, default_disk_mib: 10240 },
  { id: "s-2vcpu-2gb", vcpu: 2, mem_mib: 2048, default_disk_mib: 10240 },
  { id: "s-4vcpu-4gb", vcpu: 4, mem_mib: 4096, default_disk_mib: 10240 },
  { id: "s-8vcpu-16gb", vcpu: 8, mem_mib: 16384, default_disk_mib: 10240 },
];

function depsWith(listShapes: () => Promise<Shape[]>) {
  // CreateosClient is a flat interface (all 4 methods); createSandbox/getSandbox/
  // listSandboxes are unused by usableShapes/fetchCatalog but must be present to typecheck.
  return {
    makeClient: () => ({
      createSandbox: vi.fn(),
      getSandbox: vi.fn(),
      listShapes,
      listSandboxes: vi.fn().mockResolvedValue([]),
    }),
  };
}

beforeEach(() => {
  resetShapeCacheForTests();
  vi.restoreAllMocks();
});

describe("createosLabels", () => {
  it("keeps the bare label and shaped labels, drops everything else", () => {
    expect(createosLabels(["self-hosted", "linux", "createos-2vcpu-2gb"], config)).toEqual([
      "createos-2vcpu-2gb",
    ]);
    expect(createosLabels(["createos"], config)).toEqual(["createos"]);
    expect(createosLabels(["ubuntu-latest"], config)).toEqual([]);
  });
});

describe("shapeForLabel", () => {
  it("maps the bare label to the configured default shape", () => {
    expect(shapeForLabel("createos", config)).toBe("s-4vcpu-4gb");
  });

  it("maps a shaped label to its shape id", () => {
    expect(shapeForLabel("createos-8vcpu-16gb", config)).toBe("s-8vcpu-16gb");
    expect(shapeForLabel("createos-2vcpu-2gb", config)).toBe("s-2vcpu-2gb");
  });

  // Fix 1: a persisted row's label is validated against a *current*
  // config.runnerLabel. If an operator renames RUNNER_LABEL while jobs are in
  // flight, a stale bare label ("createos") no longer equals the new
  // runnerLabel ("gha") and matches neither the bare label nor its prefix —
  // that must throw (loud, caught by provisionAndRecord's try/catch), not
  // silently slice out a garbage shape like "s-eos".
  it("throws when the label matches neither the bare label nor its prefix", () => {
    const renamed: Config = { ...config, runnerLabel: "gha" };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => shapeForLabel("createos", renamed)).toThrow(/does not match/);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("stale/corrupt"))).toBe(true);
  });
});

describe("usableShapes", () => {
  it("excludes shapes under the memory floor and throttled shapes, and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ids = await usableShapes(
      config,
      depsWith(async () => CATALOG),
    );
    const sortedIds = [...ids];
    sortedIds.sort((a, b) => a.localeCompare(b));
    expect(sortedIds).toEqual(["s-2vcpu-2gb", "s-4vcpu-4gb", "s-8vcpu-16gb"]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain("s-1vcpu-1gb");
    expect(warn.mock.calls[0]![0]).toContain("s-0.25vcpu-512mb");
  });

  it("serves the cache inside the TTL and refetches past it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const listShapes = vi.fn(async () => CATALOG);
    await usableShapes(config, depsWith(listShapes), 1_000_000);
    await usableShapes(config, depsWith(listShapes), 1_000_000 + 299_999);
    expect(listShapes).toHaveBeenCalledTimes(1);
    await usableShapes(config, depsWith(listShapes), 1_000_000 + 300_000);
    expect(listShapes).toHaveBeenCalledTimes(2);
  });

  // A1: concurrent callers arriving before a cold-cache fetch resolves must
  // coalesce onto the one in-flight request, not each issue their own.
  it("coalesces concurrent misses into a single listShapes call", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const listShapes = vi.fn(
      () => new Promise<Shape[]>((resolve) => setTimeout(() => resolve(CATALOG), 10)),
    );
    const results = await Promise.all(
      Array.from({ length: 10 }, () => usableShapes(config, depsWith(listShapes))),
    );
    expect(listShapes).toHaveBeenCalledTimes(1);
    const expected = [...results[0]!];
    expected.sort();
    for (const ids of results) {
      const sorted = [...ids];
      sorted.sort();
      expect(sorted).toEqual(expected);
    }
  });

  // A1: a rejected fetch must not poison the in-flight slot — the next call
  // has to re-attempt, not inherit the same rejected promise forever.
  it("clears the in-flight entry on rejection so a later call re-attempts", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    const listShapes = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("503");
      return CATALOG;
    });

    await expect(usableShapes(config, depsWith(listShapes))).rejects.toThrow("503");
    const ids = await usableShapes(config, depsWith(listShapes));

    expect(ids.size).toBeGreaterThan(0);
    expect(listShapes).toHaveBeenCalledTimes(2);
  });

  // Fix 3: every one of N concurrent callers coalesced onto the same failing
  // fetch used to independently catch the shared rejection and warn its own
  // copy of the cause — 10 callers, 10 identical log lines. The warn now
  // lives inside the one coalesced fetch attempt, so it must fire exactly
  // once no matter how many callers share it. `listShapes` rejects on a timer
  // so the 10 calls genuinely overlap rather than resolving sequentially.
  it("warns exactly once when N concurrent callers share a failing fetch", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const listShapes = vi.fn(
      () =>
        new Promise<Shape[]>((_resolve, reject) =>
          setTimeout(() => reject(new Error("503 upstream")), 10),
        ),
    );

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        usableShapes(config, depsWith(listShapes)).then(
          () => "resolved",
          () => "rejected",
        ),
      ),
    );

    expect(listShapes).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r === "rejected")).toBe(true);
    const causeWarnings = warn.mock.calls.filter((c) => String(c[0]).includes("503 upstream"));
    expect(causeWarnings).toHaveLength(1);
  });

  // Fix 2: an empty catalog is exactly the no-silent-bounds case — it denies
  // every shaped label, and that must be logged at the fetch site, not left
  // to be inferred later from a string of "not offered" denials.
  it("warns when the fetched catalog is empty", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ids = await usableShapes(
      config,
      depsWith(async () => []),
    );
    expect(ids.size).toBe(0);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("empty"))).toBe(true);
  });

  // Fix 3: the cache must not serve an admission decision computed under a
  // floor that no longer applies. A changed minRunnerMemMib is a miss even
  // well inside CACHE_TTL_MS.
  it("treats a changed memory floor as a cache miss inside the TTL", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const listShapes = vi.fn(async () => CATALOG);
    await usableShapes(config, depsWith(listShapes), 1_000_000);
    expect(listShapes).toHaveBeenCalledTimes(1);

    const lowerFloor: Config = { ...config, minRunnerMemMib: 256 };
    await usableShapes(lowerFloor, depsWith(listShapes), 1_000_050); // well inside the TTL
    expect(listShapes).toHaveBeenCalledTimes(2);
  });
});

describe("resolveRequestedLabel", () => {
  it("returns none for a job naming no createos label", () => {
    expect(resolveRequestedLabel(["ubuntu-latest"], config)).toEqual({ kind: "none" });
  });

  it("returns ambiguous for two createos labels", () => {
    expect(resolveRequestedLabel(["createos", "createos-2vcpu-2gb"], config)).toEqual({
      kind: "ambiguous",
      labels: ["createos", "createos-2vcpu-2gb"],
    });
  });

  it("returns one for the bare label", () => {
    expect(resolveRequestedLabel(["createos"], config)).toEqual({ kind: "one", label: "createos" });
  });

  it("returns one for a shaped label, ignoring incidental labels", () => {
    expect(resolveRequestedLabel(["self-hosted", "linux", "createos-2vcpu-2gb"], config)).toEqual({
      kind: "one",
      label: "createos-2vcpu-2gb",
    });
  });

  it("never logs — the caller owns the job id and does the logging", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveRequestedLabel(["createos", "createos-2vcpu-2gb"], config);
    resolveRequestedLabel(["ubuntu-latest"], config);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("validateShape", () => {
  const usable = new Set(["s-2vcpu-2gb", "s-4vcpu-4gb"]);
  const healthy: Catalog = { ok: true, usable };
  const down: Catalog = { ok: false };

  it("admits a shaped label present in a healthy catalog", () => {
    expect(validateShape("createos-2vcpu-2gb", config, healthy)).toEqual({ ok: true });
  });

  it("returns unknown-shape for a shaped label absent from a healthy catalog", () => {
    expect(validateShape("createos-99vcpu-1tb", config, healthy)).toEqual({
      ok: false,
      reason: "unknown-shape",
    });
  });

  it("returns catalog-unavailable when the catalog could not be fetched", () => {
    expect(validateShape("createos-2vcpu-2gb", config, down)).toEqual({
      ok: false,
      reason: "catalog-unavailable",
    });
  });

  // Fix 1: validateShape must be total. Both call sites gate it behind
  // isShapedLabel, but a caller that forgets the gate must still get the
  // right answer — a bare label's shape comes from config, so a shapes-API
  // outage must never be able to block it.
  it("admits the bare label even when the catalog is unavailable", () => {
    expect(validateShape(config.runnerLabel, config, down)).toEqual({ ok: true });
  });

  it("never logs — the caller owns the job id and does the logging", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    validateShape("createos-99vcpu-1tb", config, healthy);
    validateShape("createos-2vcpu-2gb", config, down);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("fetchCatalog", () => {
  it("resolves ok:true with the usable set on a healthy fetch", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await fetchCatalog(
      config,
      depsWith(async () => CATALOG),
    );
    expect(result.ok).toBe(true);
  });

  it("converts a throwing listShapes into {ok: false} rather than propagating", async () => {
    const boom = depsWith(async () => {
      throw new Error("503");
    });
    await expect(fetchCatalog(config, boom)).resolves.toEqual({ ok: false });
  });

  it("warns the underlying cause before discarding it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const boom = depsWith(async () => {
      throw new Error("503 upstream");
    });

    await fetchCatalog(config, boom);

    // The warn itself now lives inside usableShapes' coalesced fetch attempt
    // (see the "warns exactly once" test above), not here — but a single
    // uncontended fetchCatalog call still observes it. Callers only ever see
    // `{ok: false}` and log a job id against the `catalog-unavailable`
    // reason; if the cause were never surfaced, a DNS failure, a 500, and an
    // auth error would be indistinguishable in the logs.
    expect(warn.mock.calls.some((c) => String(c[0]).includes("503 upstream"))).toBe(true);
  });
});
