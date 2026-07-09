import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadConfig } from "../../src/config";
import {
  createosLabels,
  shapeForLabel,
  usableShapes,
  isUsableLabel,
  pickLabel,
  resetShapeCacheForTests,
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

function depsWith(listShapes: () => Promise<unknown>) {
  return { makeClient: () => ({ listShapes }) as never };
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
});

describe("isUsableLabel", () => {
  it("admits the bare label without touching the catalog", async () => {
    const listShapes = vi.fn(async () => CATALOG);
    expect(await isUsableLabel("createos", config, depsWith(listShapes))).toBe(true);
    expect(listShapes).not.toHaveBeenCalled();
  });

  it("admits a shaped label present in the catalog", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      await isUsableLabel(
        "createos-2vcpu-2gb",
        config,
        depsWith(async () => CATALOG),
      ),
    ).toBe(true);
  });

  it("denies a shaped label that exists but is under the floor, and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      await isUsableLabel(
        "createos-1vcpu-1gb",
        config,
        depsWith(async () => CATALOG),
      ),
    ).toBe(false);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("not offered"))).toBe(true);
  });

  it("denies a shaped label when the catalog fetch fails, and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const boom = depsWith(async () => {
      throw new Error("503");
    });
    expect(await isUsableLabel("createos-2vcpu-2gb", config, boom)).toBe(false);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("catalog fetch failed"))).toBe(true);
  });

  it("still admits the bare label when the catalog fetch fails", async () => {
    const boom = depsWith(async () => {
      throw new Error("503");
    });
    expect(await isUsableLabel("createos", config, boom)).toBe(true);
  });
});

describe("pickLabel", () => {
  const usable = new Set(["s-2vcpu-2gb", "s-4vcpu-4gb"]);

  it("returns null for a job that is not ours", () => {
    expect(pickLabel(["ubuntu-latest"], usable, config)).toBeNull();
  });

  it("returns the single createos label, ignoring incidental labels", () => {
    expect(pickLabel(["self-hosted", "createos-2vcpu-2gb"], usable, config)).toBe(
      "createos-2vcpu-2gb",
    );
  });

  it("refuses two createos labels rather than picking by order, and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(pickLabel(["createos", "createos-2vcpu-2gb"], usable, config)).toBeNull();
    expect(warn.mock.calls.some((c) => String(c[0]).includes("2 createos labels"))).toBe(true);
  });

  it("returns null for a shaped label absent from the catalog", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(pickLabel(["createos-99vcpu-1tb"], usable, config)).toBeNull();
  });
});
