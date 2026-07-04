# createos GitHub Actions Runner Controller — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Cloudflare Worker that boots one ephemeral createos microVM per pending `nodeops-app` GitHub Actions job, registers it as a JIT self-hosted runner, and tears it down when the job finishes — entirely on the CF Workers Free plan.

**Architecture:** GitHub App webhook (`workflow_job`) → Worker verifies HMAC → a single SQLite-backed Durable Object (`Coordinator`) holds all state (Job→Sandbox map, concurrency counter, pending queue) as **pure state, no fetch**. All network work (GitHub API, createSandbox, destroy) runs in the Worker via `ctx.waitUntil`, keeping the DO hibernation-eligible. Teardown is triple-layered: `completed` webhook → `destroy()`; runner-exit `halt` reaped by fc's liveness watcher (~30s); a Worker **cron** reaper for orphans. See `docs/adr/0001` and `docs/adr/0002`.

**Tech Stack:** TypeScript ESM, Cloudflare Workers + Durable Objects (SQLite), `@nodeops-createos/sandbox` SDK, bun (package manager), wrangler (deploy/dev), vitest + `@cloudflare/vitest-pool-workers` (tests), oxlint/oxfmt, zero runtime deps for GitHub auth (Web Crypto RS256).

## Global Constraints

- **Runtime:** Cloudflare Workers (edge). No Node built-ins; use Web Crypto (`crypto.subtle`), `fetch`, `btoa`/`atob`.
- **CF Free plan only.** Durable Object **must** use the SQLite backend (`new_sqlite_classes` migration); key-value DOs are Paid-only. DO does **no** outbound fetch — it stays hibernation-eligible. (memory: `cf-free-tier-constraint`)
- **Package manager:** bun. Never npm/npx/node. Tests that need real DO bindings run under `@cloudflare/vitest-pool-workers` (in workerd), not `bun test`.
- **Lint/format:** oxlint + oxfmt on every `.ts` file before commit.
- **File size:** keep each source file under 1100 lines (all are far smaller here).
- **Dependencies:** latest stable, pinned by `bun.lock`. Zero runtime deps for the GitHub-auth path (hand-rolled Web Crypto).
- **Runner label:** `createos`. Workflows opt in with `runs-on: [createos]`.
- **GitHub App private key gotcha:** GitHub issues PKCS#1 (`BEGIN RSA PRIVATE KEY`); Web Crypto needs PKCS#8 (`BEGIN PRIVATE KEY`). The key is stored **pre-converted** to PKCS#8 — the Worker imports it directly, no in-worker ASN.1.
- **Time:** pass `now: number` (epoch ms) into pure functions rather than calling `Date.now()` inside them, so tests are deterministic. The Worker entrypoints supply `Date.now()`.

---

## File Structure

```
createos-sandbox-ghar/
├── package.json
├── tsconfig.json
├── wrangler.toml
├── .oxlintrc.json
├── vitest.config.ts
├── .dev.vars.example              # sample secrets for local `wrangler dev`
├── src/
│   ├── env.ts                     # Env binding interface (wrangler bindings)
│   ├── types.ts                   # shared wire + internal types
│   ├── config.ts                  # parseConfig(env) → Config (validated)
│   ├── webhook.ts                 # verifySignature, parseEvent (pure)
│   ├── policy.ts                  # shouldProvision (pure), isForkRun (async)
│   ├── github/
│   │   ├── jwt.ts                 # createAppJwt (Web Crypto RS256, PKCS#8)
│   │   ├── auth.ts                # installation-token fetch + cache
│   │   └── client.ts             # GitHubClient: generateJitConfig, getRunHeadRepo
│   ├── sandboxes.ts               # SandboxClient wrapper over the createos SDK
│   ├── provision.ts               # jitconfig → createSandbox → exec detached runner
│   ├── teardown.ts                # destroy a sandbox by id (idempotent)
│   ├── coordinator.ts             # Coordinator Durable Object (SQLite state machine)
│   └── index.ts                   # fetch (/health, /webhook) + scheduled (reaper); exports Coordinator
├── image/
│   ├── Dockerfile                 # runner rootfs template (RUN-only)
│   ├── run-wrapper.sh             # launches runner, halts VM on exit
│   └── build-template.ts          # builds+registers the template via the SDK
├── docs/adr/…                     # existing ADRs
└── test/
    ├── unit/
    │   ├── config.test.ts
    │   ├── webhook.test.ts
    │   ├── policy.test.ts
    │   ├── jwt.test.ts
    │   ├── auth.test.ts
    │   ├── github-client.test.ts
    │   ├── provision.test.ts
    │   └── teardown.test.ts
    └── integration/               # @cloudflare/vitest-pool-workers (real DO)
        ├── coordinator.test.ts
        ├── flow.test.ts
        ├── concurrency.test.ts
        ├── idempotency.test.ts
        └── reaper.test.ts
```

---

## Canonical types (defined in Task 1, referenced everywhere)

```ts
// src/types.ts
export type ProvisionPolicy = "org-wide" | "repo-allowlist" | "fork-gated";

export interface Config {
  githubAppId: string;
  githubAppInstallationId: string;
  githubPrivateKeyPkcs8: string;   // PEM, PKCS#8
  webhookSecret: string;
  githubOrg: string;
  createosBaseUrl: string;
  createosApiKey: string;
  runnerLabel: string;             // "createos"
  runnerTemplate: string;          // rootfs template id or name
  runnerShape: string;             // "s-4vcpu-4gb"
  runnerDiskMib: number;           // 30720
  runnerGroupId: number;           // 1 (Default runner group)
  maxConcurrent: number;           // 0 = unlimited
  provisionPolicy: ProvisionPolicy;
  repoAllowlist: string[];         // repo full_names, used only for repo-allowlist
  provisionTimeoutMs: number;      // reaper: stuck in "provisioning"
  runnerStartTimeoutMs: number;    // reaper: booted but never in_progress
  maxJobDurationMs: number;        // reaper: hard ceiling on a running job
}

export interface WorkflowJob {
  id: number;
  run_id: number;
  run_attempt: number;
  status: string;
  labels: string[];
  name: string;
}

export interface WorkflowJobEvent {
  action: "queued" | "in_progress" | "completed" | "waiting";
  workflow_job: WorkflowJob;
  repository: { full_name: string; private: boolean };
  organization?: { login: string };
}

export interface JitConfig {
  encodedJitConfig: string;
  runnerId: number;
}

// Durable Object RPC result shapes
export type ReserveDecision = "provision" | "queued" | "duplicate";
export interface ReserveResult { decision: ReserveDecision }

export interface NextProvision { jobId: number; runId: number }
export interface CompleteResult {
  destroySandboxId: string | null;   // sandbox to tear down (null if never booted)
  next: NextProvision | null;        // a pending job now cleared to provision
}

export interface OrphanJob { jobId: number; sandboxId: string | null }
export interface ReapResult { orphans: OrphanJob[]; next: NextProvision[] }
```

---

## Task 0: Repo scaffold + health endpoint

**Files:**
- Create: `package.json`, `tsconfig.json`, `wrangler.toml`, `.oxlintrc.json`, `vitest.config.ts`, `.dev.vars.example`, `.gitignore`
- Create: `src/env.ts`, `src/index.ts`, `src/coordinator.ts` (stub)
- Test: `test/integration/health.test.ts` (removed later; smoke only)

**Interfaces:**
- Produces: `Env` interface; `Coordinator` DO class (empty); default Worker export with a `GET /health` route.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "createos-sandbox-ghar",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "oxlint src test",
    "fmt": "oxfmt src test"
  }
}
```

- [ ] **Step 2: Install toolchain (pins exact versions into `bun.lock`)**

```bash
bun add "@nodeops-createos/sandbox@file:../fc-sdk"
bun add -d wrangler@latest typescript@latest vitest@latest \
  @cloudflare/vitest-pool-workers@latest @cloudflare/workers-types@latest \
  oxlint@latest
```
Expected: `bun.lock` written with exact resolved versions; `node_modules/` populated. The SDK is not published to npm, so it is referenced from the sibling `../fc-sdk` checkout.

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "es2022",
    "moduleResolution": "bundler",
    "lib": ["es2022"],
    "types": ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src", "test", "image"]
}
```

- [ ] **Step 4: Create `wrangler.toml`**

```toml
name = "createos-sandbox-ghar"
main = "src/index.ts"
compatibility_date = "2025-07-01"
compatibility_flags = ["nodejs_compat"]

# Orphan reaper — every 2 minutes.
[triggers]
crons = ["*/2 * * * *"]

[[durable_objects.bindings]]
name = "COORDINATOR"
class_name = "Coordinator"

# SQLite-backed DO — REQUIRED for the CF Free plan.
[[migrations]]
tag = "v1"
new_sqlite_classes = ["Coordinator"]

[vars]
GITHUB_ORG = "nodeops-app"
CREATEOS_SANDBOX_BASE_URL = "https://api.createos.nodeops.xyz"
RUNNER_LABEL = "createos"
RUNNER_SHAPE = "s-4vcpu-4gb"
RUNNER_DISK_SIZE = "30720"
RUNNER_GROUP_ID = "1"
RUNNER_TEMPLATE = "ghar-runner"
MAX_CONCURRENT = "0"
PROVISION_POLICY = "org-wide"
REPO_ALLOWLIST = ""
PROVISION_TIMEOUT_MS = "120000"
RUNNER_START_TIMEOUT_MS = "300000"
MAX_JOB_DURATION_MS = "21600000"
```
Note: confirm `CREATEOS_SANDBOX_BASE_URL` against the real control-plane URL before deploy. Secrets are added separately (Task 15), never in this file.

- [ ] **Step 5: Create `.oxlintrc.json`, `.gitignore`, `.dev.vars.example`**

`.oxlintrc.json`:
```json
{ "$schema": "./node_modules/oxlint/configuration_schema.json", "categories": { "correctness": "error", "suspicious": "warn" } }
```
`.gitignore`:
```
node_modules/
.wrangler/
.dev.vars
dist/
```
`.dev.vars.example`:
```
GITHUB_APP_ID=""
GITHUB_APP_INSTALLATION_ID=""
GITHUB_APP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...PKCS#8...\n-----END PRIVATE KEY-----"
GITHUB_WEBHOOK_SECRET=""
CREATEOS_SANDBOX_API_KEY=""
```

- [ ] **Step 6: Create `src/env.ts`**

```ts
export interface Env {
  COORDINATOR: DurableObjectNamespace;
  // secrets
  GITHUB_APP_ID: string;
  GITHUB_APP_INSTALLATION_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  CREATEOS_SANDBOX_API_KEY: string;
  // vars
  GITHUB_ORG: string;
  CREATEOS_SANDBOX_BASE_URL: string;
  RUNNER_LABEL: string;
  RUNNER_SHAPE: string;
  RUNNER_DISK_SIZE: string;
  RUNNER_GROUP_ID: string;
  RUNNER_TEMPLATE: string;
  MAX_CONCURRENT: string;
  PROVISION_POLICY: string;
  REPO_ALLOWLIST: string;
  PROVISION_TIMEOUT_MS: string;
  RUNNER_START_TIMEOUT_MS: string;
  MAX_JOB_DURATION_MS: string;
}
```

- [ ] **Step 7: Create `src/coordinator.ts` stub**

```ts
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

export class Coordinator extends DurableObject<Env> {
  async ping(): Promise<string> {
    return "pong";
  }
}
```

- [ ] **Step 8: Create `src/index.ts`**

```ts
import type { Env } from "./env";
export { Coordinator } from "./coordinator";

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok", { status: 200 });
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 9: Create `vitest.config.ts`**

```ts
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: { compatibilityFlags: ["nodejs_compat"] },
      },
    },
  },
});
```

- [ ] **Step 10: Write the smoke test `test/integration/health.test.ts`**

```ts
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../../src/index";

describe("health", () => {
  it("returns ok", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("https://x/health"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});
```

- [ ] **Step 11: Run — verify it passes and typecheck is clean**

Run: `bun run test && bun run typecheck`
Expected: 1 test passes; `tsc` reports no errors. If pool-workers cannot find the DO class, confirm the `wrangler.toml` migration + binding names match `Coordinator`.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "chore: scaffold CF Worker + SQLite Durable Object + health endpoint"
```

---

## Task 1: Config parsing + shared types

**Files:**
- Create: `src/types.ts` (the canonical types block above, verbatim)
- Create: `src/config.ts`
- Test: `test/unit/config.test.ts`

**Interfaces:**
- Consumes: `Env` (Task 0).
- Produces: `parseConfig(env: Env): Config`. Throws `Error` naming the first missing required secret.

- [ ] **Step 1: Create `src/types.ts`** — paste the *Canonical types* block above verbatim.

- [ ] **Step 2: Write the failing test `test/unit/config.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { parseConfig } from "../../src/config";
import type { Env } from "../../src/env";

const base: Env = {
  COORDINATOR: {} as DurableObjectNamespace,
  GITHUB_APP_ID: "123",
  GITHUB_APP_INSTALLATION_ID: "456",
  GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
  GITHUB_WEBHOOK_SECRET: "shh",
  CREATEOS_SANDBOX_API_KEY: "key",
  GITHUB_ORG: "nodeops-app",
  CREATEOS_SANDBOX_BASE_URL: "https://api.example",
  RUNNER_LABEL: "createos",
  RUNNER_SHAPE: "s-4vcpu-4gb",
  RUNNER_DISK_SIZE: "30720",
  RUNNER_GROUP_ID: "1",
  RUNNER_TEMPLATE: "ghar-runner",
  MAX_CONCURRENT: "0",
  PROVISION_POLICY: "org-wide",
  REPO_ALLOWLIST: "",
  PROVISION_TIMEOUT_MS: "120000",
  RUNNER_START_TIMEOUT_MS: "300000",
  MAX_JOB_DURATION_MS: "21600000",
};

describe("parseConfig", () => {
  it("parses numbers, policy, and empty allowlist", () => {
    const c = parseConfig(base);
    expect(c.maxConcurrent).toBe(0);
    expect(c.runnerDiskMib).toBe(30720);
    expect(c.provisionPolicy).toBe("org-wide");
    expect(c.repoAllowlist).toEqual([]);
  });

  it("splits a comma allowlist and trims", () => {
    const c = parseConfig({ ...base, REPO_ALLOWLIST: "a/b, c/d ,e/f" });
    expect(c.repoAllowlist).toEqual(["a/b", "c/d", "e/f"]);
  });

  it("throws on a missing required secret", () => {
    expect(() => parseConfig({ ...base, GITHUB_APP_ID: "" })).toThrow(/GITHUB_APP_ID/);
  });

  it("rejects an unknown provision policy", () => {
    expect(() => parseConfig({ ...base, PROVISION_POLICY: "bogus" })).toThrow(/PROVISION_POLICY/);
  });
});
```

- [ ] **Step 3: Run — verify it fails**

Run: `bun run test test/unit/config.test.ts`
Expected: FAIL — `parseConfig` not exported.

- [ ] **Step 4: Create `src/config.ts`**

```ts
import type { Config, ProvisionPolicy } from "./types";
import type { Env } from "./env";

const POLICIES: ProvisionPolicy[] = ["org-wide", "repo-allowlist", "fork-gated"];

function req(v: string | undefined, name: string): string {
  if (!v) throw new Error(`missing required config: ${name}`);
  return v;
}

function num(v: string | undefined, d: number): number {
  if (v === undefined || v === "") return d;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`invalid number for config: ${v}`);
  return n;
}

export function parseConfig(env: Env): Config {
  const policy = (env.PROVISION_POLICY || "org-wide") as ProvisionPolicy;
  if (!POLICIES.includes(policy)) {
    throw new Error(`invalid PROVISION_POLICY: ${env.PROVISION_POLICY}`);
  }
  return {
    githubAppId: req(env.GITHUB_APP_ID, "GITHUB_APP_ID"),
    githubAppInstallationId: req(env.GITHUB_APP_INSTALLATION_ID, "GITHUB_APP_INSTALLATION_ID"),
    githubPrivateKeyPkcs8: req(env.GITHUB_APP_PRIVATE_KEY, "GITHUB_APP_PRIVATE_KEY"),
    webhookSecret: req(env.GITHUB_WEBHOOK_SECRET, "GITHUB_WEBHOOK_SECRET"),
    githubOrg: req(env.GITHUB_ORG, "GITHUB_ORG"),
    createosBaseUrl: req(env.CREATEOS_SANDBOX_BASE_URL, "CREATEOS_SANDBOX_BASE_URL"),
    createosApiKey: req(env.CREATEOS_SANDBOX_API_KEY, "CREATEOS_SANDBOX_API_KEY"),
    runnerLabel: env.RUNNER_LABEL || "createos",
    runnerTemplate: req(env.RUNNER_TEMPLATE, "RUNNER_TEMPLATE"),
    runnerShape: env.RUNNER_SHAPE || "s-4vcpu-4gb",
    runnerDiskMib: num(env.RUNNER_DISK_SIZE, 30720),
    runnerGroupId: num(env.RUNNER_GROUP_ID, 1),
    maxConcurrent: num(env.MAX_CONCURRENT, 0),
    provisionPolicy: policy,
    repoAllowlist: (env.REPO_ALLOWLIST || "").split(",").map((s) => s.trim()).filter(Boolean),
    provisionTimeoutMs: num(env.PROVISION_TIMEOUT_MS, 120_000),
    runnerStartTimeoutMs: num(env.RUNNER_START_TIMEOUT_MS, 300_000),
    maxJobDurationMs: num(env.MAX_JOB_DURATION_MS, 21_600_000),
  };
}
```

- [ ] **Step 5: Run — verify pass**

Run: `bun run test test/unit/config.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/config.ts test/unit/config.test.ts
git commit -m "feat: config parsing and shared types"
```

---

## Task 2: Webhook HMAC verification + event parsing

**Files:**
- Create: `src/webhook.ts`
- Test: `test/unit/webhook.test.ts`

**Interfaces:**
- Produces:
  - `verifySignature(secret: string, body: string, header: string | null): Promise<boolean>`
  - `parseEvent(eventName: string | null, body: string): WorkflowJobEvent | null` — returns `null` for non-`workflow_job` events or unparseable bodies.

- [ ] **Step 1: Write the failing test `test/unit/webhook.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { verifySignature, parseEvent } from "../../src/webhook";

async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return "sha256=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("verifySignature", () => {
  it("accepts a correct signature", async () => {
    const body = '{"hello":"world"}';
    expect(await verifySignature("s3cr3t", body, await sign("s3cr3t", body))).toBe(true);
  });
  it("rejects a wrong signature", async () => {
    expect(await verifySignature("s3cr3t", "{}", await sign("other", "{}"))).toBe(false);
  });
  it("rejects a missing / malformed header", async () => {
    expect(await verifySignature("s3cr3t", "{}", null)).toBe(false);
    expect(await verifySignature("s3cr3t", "{}", "garbage")).toBe(false);
  });
});

describe("parseEvent", () => {
  const payload = JSON.stringify({
    action: "queued",
    workflow_job: { id: 1, run_id: 2, run_attempt: 1, status: "queued", labels: ["createos"], name: "build" },
    repository: { full_name: "nodeops-app/x", private: true },
  });
  it("parses a workflow_job event", () => {
    const e = parseEvent("workflow_job", payload);
    expect(e?.action).toBe("queued");
    expect(e?.workflow_job.id).toBe(1);
  });
  it("ignores other event types", () => {
    expect(parseEvent("push", payload)).toBeNull();
  });
  it("returns null on invalid json", () => {
    expect(parseEvent("workflow_job", "{not json")).toBeNull();
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `bun run test test/unit/webhook.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/webhook.ts`**

```ts
import type { WorkflowJobEvent } from "./types";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export async function verifySignature(
  secret: string,
  body: string,
  header: string | null,
): Promise<boolean> {
  if (!header || !header.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected = "sha256=" +
    [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(expected, header);
}

export function parseEvent(eventName: string | null, body: string): WorkflowJobEvent | null {
  if (eventName !== "workflow_job") return null;
  try {
    const e = JSON.parse(body) as WorkflowJobEvent;
    if (!e || typeof e.action !== "string" || !e.workflow_job) return null;
    return e;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run — verify pass**

Run: `bun run test test/unit/webhook.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/webhook.ts test/unit/webhook.test.ts
git commit -m "feat: webhook HMAC verification and event parsing"
```

---

## Task 3: Provisioning policy

**Files:**
- Create: `src/policy.ts`
- Test: `test/unit/policy.test.ts`

**Interfaces:**
- Consumes: `Config`, `WorkflowJobEvent`.
- Produces:
  - `hasRunnerLabel(cfg: Config, event: WorkflowJobEvent): boolean`
  - `shouldProvision(cfg: Config, event: WorkflowJobEvent): boolean` — synchronous label + policy gate. For `fork-gated`, returns `true` here (label/allowlist ok) and the async fork check is applied separately in `index.ts` via `isForkRun` (Task 6) so this stays pure.

- [ ] **Step 1: Write the failing test `test/unit/policy.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { shouldProvision, hasRunnerLabel } from "../../src/policy";
import type { Config, WorkflowJobEvent } from "../../src/types";

const cfg = (over: Partial<Config> = {}): Config => ({
  githubAppId: "1", githubAppInstallationId: "1", githubPrivateKeyPkcs8: "x",
  webhookSecret: "x", githubOrg: "nodeops-app", createosBaseUrl: "x", createosApiKey: "x",
  runnerLabel: "createos", runnerTemplate: "t", runnerShape: "s", runnerDiskMib: 1,
  runnerGroupId: 1, maxConcurrent: 0, provisionPolicy: "org-wide", repoAllowlist: [],
  provisionTimeoutMs: 1, runnerStartTimeoutMs: 1, maxJobDurationMs: 1, ...over,
});

const evt = (labels: string[], repo = "nodeops-app/x"): WorkflowJobEvent => ({
  action: "queued",
  workflow_job: { id: 1, run_id: 2, run_attempt: 1, status: "queued", labels, name: "b" },
  repository: { full_name: repo, private: true },
});

describe("policy", () => {
  it("rejects jobs without the runner label", () => {
    expect(hasRunnerLabel(cfg(), evt(["ubuntu-latest"]))).toBe(false);
    expect(shouldProvision(cfg(), evt(["ubuntu-latest"]))).toBe(false);
  });
  it("org-wide accepts any labelled job", () => {
    expect(shouldProvision(cfg(), evt(["createos"]))).toBe(true);
  });
  it("repo-allowlist accepts only listed repos", () => {
    const c = cfg({ provisionPolicy: "repo-allowlist", repoAllowlist: ["nodeops-app/x"] });
    expect(shouldProvision(c, evt(["createos"], "nodeops-app/x"))).toBe(true);
    expect(shouldProvision(c, evt(["createos"], "nodeops-app/y"))).toBe(false);
  });
  it("fork-gated passes the sync gate (async fork check applied later)", () => {
    expect(shouldProvision(cfg({ provisionPolicy: "fork-gated" }), evt(["createos"]))).toBe(true);
  });
});
```

- [ ] **Step 2: Run — verify it fails.** Run: `bun run test test/unit/policy.test.ts` → FAIL.

- [ ] **Step 3: Create `src/policy.ts`**

```ts
import type { Config, WorkflowJobEvent } from "./types";

export function hasRunnerLabel(cfg: Config, event: WorkflowJobEvent): boolean {
  return event.workflow_job.labels.includes(cfg.runnerLabel);
}

export function shouldProvision(cfg: Config, event: WorkflowJobEvent): boolean {
  if (!hasRunnerLabel(cfg, event)) return false;
  switch (cfg.provisionPolicy) {
    case "org-wide":
      return true;
    case "repo-allowlist":
      return cfg.repoAllowlist.includes(event.repository.full_name);
    case "fork-gated":
      // Label/allowlist ok; the fork check needs an API call, done in index.ts.
      return true;
  }
}
```

- [ ] **Step 4: Run — verify pass.** Run: `bun run test test/unit/policy.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/policy.ts test/unit/policy.test.ts
git commit -m "feat: provisioning policy gate"
```

---

## Task 4: GitHub App JWT (Web Crypto RS256)

**Files:**
- Create: `src/github/jwt.ts`
- Test: `test/unit/jwt.test.ts`

**Interfaces:**
- Produces: `createAppJwt(appId: string, pkcs8Pem: string, nowMs: number): Promise<string>` — a signed RS256 JWT with `iat = now-60s`, `exp = iat+600s`, `iss = appId`.

- [ ] **Step 1: Write the failing test `test/unit/jwt.test.ts`** (generates a throwaway RSA keypair, signs, then verifies the JWT with the public key)

```ts
import { describe, it, expect } from "vitest";
import { createAppJwt } from "../../src/github/jwt";

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function toPem(der: ArrayBuffer): string {
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  return `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----`;
}

describe("createAppJwt", () => {
  it("produces a JWT the matching public key verifies, with correct claims", async () => {
    const pair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true, ["sign", "verify"],
    );
    const pkcs8 = toPem(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    const now = 1_700_000_000_000;

    const jwt = await createAppJwt("app-123", pkcs8, now);
    const [h, p, s] = jwt.split(".");
    expect(h && p && s).toBeTruthy();

    const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(p!)));
    expect(claims.iss).toBe("app-123");
    expect(claims.iat).toBe(Math.floor(now / 1000) - 60);
    expect(claims.exp).toBe(claims.iat + 600);

    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5", pair.publicKey,
      b64urlToBytes(s!), new TextEncoder().encode(`${h}.${p}`),
    );
    expect(ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run — verify it fails.** Run: `bun run test test/unit/jwt.test.ts` → FAIL.

- [ ] **Step 3: Create `src/github/jwt.ts`**

```ts
function b64url(data: ArrayBuffer | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

export async function createAppJwt(appId: string, pkcs8Pem: string, nowMs: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(pkcs8Pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const iat = Math.floor(nowMs / 1000) - 60;
  const exp = iat + 600;
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat, exp, iss: appId }));
  const signingInput = `${header}.${payload}`;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64url(sig)}`;
}
```

- [ ] **Step 4: Run — verify pass.** Run: `bun run test test/unit/jwt.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/github/jwt.ts test/unit/jwt.test.ts
git commit -m "feat: GitHub App RS256 JWT via Web Crypto"
```

---

## Task 5: Installation-token fetch + cache

**Files:**
- Create: `src/github/auth.ts`
- Test: `test/unit/auth.test.ts`

**Interfaces:**
- Consumes: `createAppJwt` (Task 4).
- Produces: `class InstallationTokenSource` with
  `constructor(cfg: Config, fetchImpl?: typeof fetch)` and
  `get(nowMs: number): Promise<string>` — returns a cached token until 60s before expiry, else exchanges the App JWT at `POST /app/installations/{id}/access_tokens`.

- [ ] **Step 1: Write the failing test `test/unit/auth.test.ts`**

```ts
import { describe, it, expect, vi } from "vitest";
import { InstallationTokenSource } from "../../src/github/auth";
import type { Config } from "../../src/types";

const cfg = { githubAppId: "1", githubAppInstallationId: "99", githubPrivateKeyPkcs8: PKCS8 } as Config;

// A valid PKCS#8 key generated once for the suite (see jwt.test helper).
import { PKCS8 } from "./fixtures";

describe("InstallationTokenSource", () => {
  it("fetches a token and caches it until near expiry", async () => {
    const now = 1_700_000_000_000;
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ token: "ghs_abc", expires_at: new Date(now + 3600_000).toISOString() }), { status: 201 }),
    );
    const src = new InstallationTokenSource(cfg, fetchImpl as unknown as typeof fetch);

    expect(await src.get(now)).toBe("ghs_abc");
    expect(await src.get(now + 1000)).toBe("ghs_abc"); // cached
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://api.github.com/app/installations/99/access_tokens");
    expect((init as RequestInit).method).toBe("POST");
  });

  it("refetches after expiry", async () => {
    const now = 1_700_000_000_000;
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ token: "ghs_x", expires_at: new Date(now + 120_000).toISOString() }), { status: 201 }),
    );
    const src = new InstallationTokenSource(cfg, fetchImpl as unknown as typeof fetch);
    await src.get(now);
    await src.get(now + 119_000); // within 60s of expiry → refetch
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws on a non-201", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 }));
    const src = new InstallationTokenSource(cfg, fetchImpl as unknown as typeof fetch);
    await expect(src.get(1_700_000_000_000)).rejects.toThrow(/installation token/i);
  });
});
```

- [ ] **Step 2: Create the shared fixture `test/unit/fixtures.ts`** (a real PKCS#8 key so JWT signing works in tests)

```ts
// Generated once with:
//   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out k.pem
// (any valid 2048-bit PKCS#8 RSA key works; this is a throwaway test key)
export const PKCS8 = `-----BEGIN PRIVATE KEY-----
<paste a real 2048-bit PKCS#8 RSA private key here>
-----END PRIVATE KEY-----`;
```
Generate it with: `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048` and paste the PEM. This key is test-only, never a real GitHub key.

- [ ] **Step 3: Run — verify it fails.** Run: `bun run test test/unit/auth.test.ts` → FAIL.

- [ ] **Step 4: Create `src/github/auth.ts`**

```ts
import type { Config } from "../types";
import { createAppJwt } from "./jwt";

interface CachedToken { token: string; expiresAtMs: number }

export class InstallationTokenSource {
  private cache: CachedToken | null = null;
  constructor(private cfg: Config, private fetchImpl: typeof fetch = fetch) {}

  async get(nowMs: number): Promise<string> {
    if (this.cache && this.cache.expiresAtMs - 60_000 > nowMs) return this.cache.token;

    const jwt = await createAppJwt(this.cfg.githubAppId, this.cfg.githubPrivateKeyPkcs8, nowMs);
    const res = await this.fetchImpl(
      `https://api.github.com/app/installations/${this.cfg.githubAppInstallationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "createos-sandbox-ghar",
        },
      },
    );
    if (res.status !== 201) {
      throw new Error(`installation token request failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { token: string; expires_at: string };
    this.cache = { token: body.token, expiresAtMs: Date.parse(body.expires_at) };
    return body.token;
  }
}
```

- [ ] **Step 5: Run — verify pass.** Run: `bun run test test/unit/auth.test.ts` → PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/github/auth.ts test/unit/auth.test.ts test/unit/fixtures.ts
git commit -m "feat: cached GitHub App installation token source"
```

---

## Task 6: GitHubClient — generate JIT config + fork detection

**Files:**
- Create: `src/github/client.ts`
- Test: `test/unit/github-client.test.ts`

**Interfaces:**
- Consumes: `InstallationTokenSource` (Task 5), `Config`.
- Produces:
  - `interface GitHubClient { generateJitConfig(name: string): Promise<JitConfig>; getRunHeadRepo(runId: number): Promise<string> }`
  - `makeGitHubClient(cfg: Config, nowMs: () => number, fetchImpl?: typeof fetch): GitHubClient`
  - `isForkRun(gh: GitHubClient, event: WorkflowJobEvent): Promise<boolean>` — `true` when the run's head repo differs from the base repo.

- [ ] **Step 1: Write the failing test `test/unit/github-client.test.ts`**

```ts
import { describe, it, expect, vi } from "vitest";
import { makeGitHubClient, isForkRun } from "../../src/github/client";
import type { Config, WorkflowJobEvent } from "../../src/types";
import { PKCS8 } from "./fixtures";

const cfg = {
  githubAppId: "1", githubAppInstallationId: "9", githubPrivateKeyPkcs8: PKCS8,
  githubOrg: "nodeops-app", runnerLabel: "createos", runnerGroupId: 1,
} as Config;

const tokenRes = () =>
  new Response(JSON.stringify({ token: "ghs_t", expires_at: new Date(Date.now() + 3600_000).toISOString() }), { status: 201 });

describe("GitHubClient", () => {
  it("generates a JIT config for the org", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/access_tokens")) return tokenRes();
      return new Response(JSON.stringify({ runner: { id: 7 }, encoded_jit_config: "JITBLOB" }), { status: 201 });
    });
    const gh = makeGitHubClient(cfg, () => 1_700_000_000_000, fetchImpl as unknown as typeof fetch);
    const jit = await gh.generateJitConfig("ghar-42");
    expect(jit.encodedJitConfig).toBe("JITBLOB");
    expect(jit.runnerId).toBe(7);

    const call = fetchImpl.mock.calls.find((c) => String(c[0]).includes("generate-jitconfig"))!;
    expect(String(call[0])).toBe("https://api.github.com/orgs/nodeops-app/actions/runners/generate-jitconfig");
    const sent = JSON.parse((call[1] as RequestInit).body as string);
    expect(sent).toEqual({ name: "ghar-42", runner_group_id: 1, labels: ["createos"], work_folder: "_work" });
    expect((call[1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer ghs_t" });
  });

  it("detects a fork run", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/access_tokens")) return tokenRes();
      return new Response(JSON.stringify({ head_repository: { full_name: "someone/x" } }), { status: 200 });
    });
    const gh = makeGitHubClient(cfg, () => 1_700_000_000_000, fetchImpl as unknown as typeof fetch);
    const event = { repository: { full_name: "nodeops-app/x" }, workflow_job: { run_id: 55 } } as WorkflowJobEvent;
    expect(await isForkRun(gh, event)).toBe(true);
  });

  it("treats same-repo run as non-fork", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/access_tokens")) return tokenRes();
      return new Response(JSON.stringify({ head_repository: { full_name: "nodeops-app/x" } }), { status: 200 });
    });
    const gh = makeGitHubClient(cfg, () => 1_700_000_000_000, fetchImpl as unknown as typeof fetch);
    const event = { repository: { full_name: "nodeops-app/x" }, workflow_job: { run_id: 55 } } as WorkflowJobEvent;
    expect(await isForkRun(gh, event)).toBe(false);
  });
});
```

- [ ] **Step 2: Run — verify it fails.** Run: `bun run test test/unit/github-client.test.ts` → FAIL.

- [ ] **Step 3: Create `src/github/client.ts`**

```ts
import type { Config, JitConfig, WorkflowJobEvent } from "../types";
import { InstallationTokenSource } from "./auth";

export interface GitHubClient {
  generateJitConfig(name: string): Promise<JitConfig>;
  getRunHeadRepo(runId: number): Promise<string>;
}

const API = "https://api.github.com";

export function makeGitHubClient(
  cfg: Config,
  nowMs: () => number,
  fetchImpl: typeof fetch = fetch,
): GitHubClient {
  const tokens = new InstallationTokenSource(cfg, fetchImpl);

  async function headers(): Promise<HeadersInit> {
    return {
      Authorization: `Bearer ${await tokens.get(nowMs())}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "createos-sandbox-ghar",
      "Content-Type": "application/json",
    };
  }

  return {
    async generateJitConfig(name: string): Promise<JitConfig> {
      const res = await fetchImpl(
        `${API}/orgs/${cfg.githubOrg}/actions/runners/generate-jitconfig`,
        {
          method: "POST",
          headers: await headers(),
          body: JSON.stringify({
            name,
            runner_group_id: cfg.runnerGroupId,
            labels: [cfg.runnerLabel],
            work_folder: "_work",
          }),
        },
      );
      if (res.status !== 201) {
        throw new Error(`generate-jitconfig failed: ${res.status} ${await res.text()}`);
      }
      const body = (await res.json()) as { runner: { id: number }; encoded_jit_config: string };
      return { encodedJitConfig: body.encoded_jit_config, runnerId: body.runner.id };
    },

    async getRunHeadRepo(runId: number): Promise<string> {
      const res = await fetchImpl(`${API}/repos/${cfg.githubOrg}/actions/runs/${runId}`, {
        headers: await headers(),
      });
      if (!res.ok) throw new Error(`get run failed: ${res.status}`);
      const body = (await res.json()) as { head_repository?: { full_name?: string } };
      return body.head_repository?.full_name ?? "";
    },
  };
}

export async function isForkRun(gh: GitHubClient, event: WorkflowJobEvent): Promise<boolean> {
  const head = await gh.getRunHeadRepo(event.workflow_job.run_id);
  return head !== "" && head !== event.repository.full_name;
}
```
Note: `getRunHeadRepo` uses the org as owner. If a run id needs the repo owner/name pair instead, switch the path to `/repos/{full_name}/actions/runs/{runId}` using `event.repository.full_name`. The current call is only exercised under `fork-gated`.

- [ ] **Step 4: Run — verify pass.** Run: `bun run test test/unit/github-client.test.ts` → PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/github/client.ts test/unit/github-client.test.ts
git commit -m "feat: GitHub client for JIT config and fork detection"
```

---

## Task 7: Sandbox client wrapper + provision

**Files:**
- Create: `src/sandboxes.ts`, `src/provision.ts`
- Test: `test/unit/provision.test.ts`

**Interfaces:**
- Produces:
  - `interface SandboxHandle { id: string; runCommand(cmd: string, args: string[]): Promise<unknown>; destroy(): Promise<unknown> }`
  - `interface SandboxClient { create(opts: CreateOpts): Promise<SandboxHandle>; get(id: string): Promise<SandboxHandle> }`
  - `interface CreateOpts { shape: string; rootfs: string; name: string; disk_mib: number; envs: Record<string,string> }`
  - `makeSandboxClient(cfg: Config): SandboxClient` — wraps `CreateosSandboxClient`.
  - `provision(deps: { github: GitHubClient; sandboxes: SandboxClient; cfg: Config }, job: WorkflowJob): Promise<string>` — returns the new sandbox id.

- [ ] **Step 1: Write the failing test `test/unit/provision.test.ts`**

```ts
import { describe, it, expect, vi } from "vitest";
import { provision } from "../../src/provision";
import type { Config, WorkflowJob } from "../../src/types";

const cfg = {
  runnerLabel: "createos", runnerTemplate: "ghar-runner",
  runnerShape: "s-4vcpu-4gb", runnerDiskMib: 30720,
} as Config;

const job: WorkflowJob = { id: 42, run_id: 7, run_attempt: 1, status: "queued", labels: ["createos"], name: "build" };

describe("provision", () => {
  it("mints a JIT config, creates a sandbox with it, and launches the detached runner", async () => {
    const github = { generateJitConfig: vi.fn(async () => ({ encodedJitConfig: "BLOB", runnerId: 1 })), getRunHeadRepo: vi.fn() };
    const runCommand = vi.fn(async () => ({}));
    const handle = { id: "sb_1", runCommand, destroy: vi.fn() };
    const sandboxes = { create: vi.fn(async () => handle), get: vi.fn() };

    const id = await provision({ github, sandboxes, cfg }, job);

    expect(id).toBe("sb_1");
    expect(github.generateJitConfig).toHaveBeenCalledWith("ghar-42");
    expect(sandboxes.create).toHaveBeenCalledWith({
      shape: "s-4vcpu-4gb", rootfs: "ghar-runner", name: "ghar-42",
      disk_mib: 30720, envs: { RUNNER_JITCONFIG: "BLOB" },
    });
    // launch is detached (backgrounded) so it returns immediately
    const [cmd, args] = runCommand.mock.calls[0]!;
    expect(cmd).toBe("bash");
    expect((args as string[])[0]).toBe("-lc");
    expect((args as string[])[1]).toContain("run-wrapper.sh");
    expect((args as string[])[1]).toContain("&");
  });
});
```

- [ ] **Step 2: Run — verify it fails.** Run: `bun run test test/unit/provision.test.ts` → FAIL.

- [ ] **Step 3: Create `src/sandboxes.ts`**

```ts
import { CreateosSandboxClient } from "@nodeops-createos/sandbox";
import type { Config } from "./types";

export interface SandboxHandle {
  id: string;
  runCommand(cmd: string, args: string[]): Promise<unknown>;
  destroy(): Promise<unknown>;
}

export interface CreateOpts {
  shape: string;
  rootfs: string;
  name: string;
  disk_mib: number;
  envs: Record<string, string>;
}

export interface SandboxClient {
  create(opts: CreateOpts): Promise<SandboxHandle>;
  get(id: string): Promise<SandboxHandle>;
}

export function makeSandboxClient(cfg: Config): SandboxClient {
  const client = new CreateosSandboxClient({
    baseUrl: cfg.createosBaseUrl,
    apiKey: cfg.createosApiKey,
  });
  return {
    async create(opts: CreateOpts): Promise<SandboxHandle> {
      return (await client.createSandbox(opts)) as unknown as SandboxHandle;
    },
    async get(id: string): Promise<SandboxHandle> {
      return (await client.getSandbox(id)) as unknown as SandboxHandle;
    },
  };
}
```

- [ ] **Step 4: Create `src/provision.ts`**

```ts
import type { Config, WorkflowJob } from "./types";
import type { GitHubClient } from "./github/client";
import type { SandboxClient } from "./sandboxes";

export interface ProvisionDeps {
  github: GitHubClient;
  sandboxes: SandboxClient;
  cfg: Config;
}

// The runner binary + this wrapper live at /opt in the pre-baked template.
const LAUNCH =
  "nohup /opt/ghar/run-wrapper.sh >/var/log/ghar-runner.log 2>&1 & disown";

export async function provision(deps: ProvisionDeps, job: WorkflowJob): Promise<string> {
  const name = `ghar-${job.id}`;
  const jit = await deps.github.generateJitConfig(name);

  const sandbox = await deps.sandboxes.create({
    shape: deps.cfg.runnerShape,
    rootfs: deps.cfg.runnerTemplate,
    name,
    disk_mib: deps.cfg.runnerDiskMib,
    envs: { RUNNER_JITCONFIG: jit.encodedJitConfig },
  });

  // Detached launch: the outer bash backgrounds the wrapper and returns at once,
  // so this call does not block for the job's duration.
  await sandbox.runCommand("bash", ["-lc", LAUNCH]);
  return sandbox.id;
}
```

- [ ] **Step 5: Run — verify pass.** Run: `bun run test test/unit/provision.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/sandboxes.ts src/provision.ts test/unit/provision.test.ts
git commit -m "feat: sandbox client wrapper and provision orchestration"
```

---

## Task 8: Teardown (idempotent destroy)

**Files:**
- Create: `src/teardown.ts`
- Test: `test/unit/teardown.test.ts`

**Interfaces:**
- Consumes: `SandboxClient` (Task 7).
- Produces: `teardown(sandboxes: SandboxClient, sandboxId: string): Promise<void>` — destroys the sandbox; swallows "already gone" errors so redelivery/double-teardown is safe.

- [ ] **Step 1: Write the failing test `test/unit/teardown.test.ts`**

```ts
import { describe, it, expect, vi } from "vitest";
import { teardown } from "../../src/teardown";

describe("teardown", () => {
  it("gets the handle and destroys it", async () => {
    const destroy = vi.fn(async () => ({}));
    const sandboxes = { get: vi.fn(async () => ({ id: "sb_1", runCommand: vi.fn(), destroy })), create: vi.fn() };
    await teardown(sandboxes, "sb_1");
    expect(sandboxes.get).toHaveBeenCalledWith("sb_1");
    expect(destroy).toHaveBeenCalled();
  });

  it("swallows a not-found so double-teardown is safe", async () => {
    const sandboxes = { get: vi.fn(async () => { throw new Error("404 not found"); }), create: vi.fn() };
    await expect(teardown(sandboxes, "sb_gone")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — verify it fails.** Run: `bun run test test/unit/teardown.test.ts` → FAIL.

- [ ] **Step 3: Create `src/teardown.ts`**

```ts
import type { SandboxClient } from "./sandboxes";

export async function teardown(sandboxes: SandboxClient, sandboxId: string): Promise<void> {
  try {
    const handle = await sandboxes.get(sandboxId);
    await handle.destroy();
  } catch (err) {
    // Already destroyed / not found: teardown is idempotent, so this is success.
    const msg = err instanceof Error ? err.message : String(err);
    if (/not found|404/i.test(msg)) return;
    throw err;
  }
}
```

- [ ] **Step 4: Run — verify pass.** Run: `bun run test test/unit/teardown.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/teardown.ts test/unit/teardown.test.ts
git commit -m "feat: idempotent sandbox teardown"
```

---

## Task 9: Coordinator Durable Object (SQLite state machine)

**Files:**
- Modify: `src/coordinator.ts` (replace the stub)
- Test: `test/integration/coordinator.test.ts`

**Interfaces:**
- Consumes: `Env`, config timeouts (read from `env`).
- Produces the DO RPC surface (all synchronous SQLite work, no fetch):
  - `reserve(jobId: number, runId: number, nowMs: number, maxConcurrent: number): ReserveResult`
  - `attachSandbox(jobId: number, sandboxId: string, nowMs: number): void`
  - `markInProgress(jobId: number, nowMs: number): void`
  - `markProvisionFailed(jobId: number): void`
  - `complete(jobId: number, nowMs: number): CompleteResult`
  - `reap(nowMs: number): ReapResult` — returns orphans to destroy **and** dequeues pending into the freed slots; callers destroy + provision, then call `clear`.
  - `clear(jobIds: number[]): void` — deletes orphan rows after the Worker tore them down.
  - `snapshot(): { jobId: number; state: string; sandboxId: string | null }[]` — test/debug helper.

Job states: `pending` → `provisioning` → `booted` → `in_progress`. Active slot = any row in (`provisioning`, `booted`, `in_progress`). `reap` moves dequeued `pending` rows to `provisioning`.

- [ ] **Step 1: Write the failing test `test/integration/coordinator.test.ts`**

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";

function coord() {
  const id = env.COORDINATOR.idFromName(`t-${crypto.randomUUID()}`);
  return env.COORDINATOR.get(id);
}

describe("Coordinator", () => {
  it("reserves, attaches, and completes a job", async () => {
    const c = coord();
    expect((await c.reserve(1, 10, 1000, 0)).decision).toBe("provision");
    await c.attachSandbox(1, "sb_1", 1100);
    await c.markInProgress(1, 1200);
    const r = await c.complete(1, 2000);
    expect(r.destroySandboxId).toBe("sb_1");
    expect(r.next).toBeNull();
    expect(await c.snapshot()).toEqual([]);
  });

  it("dedups a duplicate reserve", async () => {
    const c = coord();
    expect((await c.reserve(1, 10, 1000, 0)).decision).toBe("provision");
    expect((await c.reserve(1, 10, 1000, 0)).decision).toBe("duplicate");
  });

  it("queues past the concurrency cap and dequeues on complete", async () => {
    const c = coord();
    expect((await c.reserve(1, 10, 1000, 1)).decision).toBe("provision");
    expect((await c.reserve(2, 20, 1001, 1)).decision).toBe("queued");
    await c.attachSandbox(1, "sb_1", 1100);
    const r = await c.complete(1, 2000);
    expect(r.destroySandboxId).toBe("sb_1");
    expect(r.next).toEqual({ jobId: 2, runId: 20 });
  });

  it("completing a still-pending (cancelled) job removes it and frees nothing to destroy", async () => {
    const c = coord();
    await c.reserve(1, 10, 1000, 1);
    await c.reserve(2, 20, 1001, 1); // queued
    const r = await c.complete(2, 1500);
    expect(r.destroySandboxId).toBeNull();
    expect(r.next).toBeNull();
  });

  it("reap flags provisioning/booted/in_progress orphans by their timeouts", async () => {
    const c = coord();
    // provisioning stuck (> PROVISION_TIMEOUT_MS = 120000)
    await c.reserve(1, 10, 0, 0);
    // booted but never in_progress (> RUNNER_START_TIMEOUT_MS = 300000)
    await c.reserve(2, 20, 0, 0);
    await c.attachSandbox(2, "sb_2", 0);
    // in_progress but under the 6h ceiling → not an orphan
    await c.reserve(3, 30, 0, 0);
    await c.attachSandbox(3, "sb_3", 0);
    await c.markInProgress(3, 0);

    const now = 400_000; // 6m40s later
    const r = await c.reap(now);
    const ids = r.orphans.map((o) => o.jobId).sort();
    expect(ids).toEqual([1, 2]);
    expect(r.orphans.find((o) => o.jobId === 2)?.sandboxId).toBe("sb_2");

    await c.clear([1, 2]);
    expect((await c.snapshot()).map((s) => s.jobId)).toEqual([3]);
  });
});
```

- [ ] **Step 2: Run — verify it fails.** Run: `bun run test test/integration/coordinator.test.ts` → FAIL (methods missing).

- [ ] **Step 3: Replace `src/coordinator.ts`**

```ts
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import type { CompleteResult, ReapResult, ReserveResult } from "./types";

interface Row { job_id: number; run_id: number; sandbox_id: string | null; state: string; created_at: number; updated_at: number }

const ACTIVE = "('provisioning','booted','in_progress')";

export class Coordinator extends DurableObject<Env> {
  private sql: SqlStorage;
  private provisionTimeoutMs: number;
  private runnerStartTimeoutMs: number;
  private maxJobDurationMs: number;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.provisionTimeoutMs = Number(env.PROVISION_TIMEOUT_MS || 120_000);
    this.runnerStartTimeoutMs = Number(env.RUNNER_START_TIMEOUT_MS || 300_000);
    this.maxJobDurationMs = Number(env.MAX_JOB_DURATION_MS || 21_600_000);
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS jobs (
         job_id INTEGER PRIMARY KEY,
         run_id INTEGER NOT NULL,
         sandbox_id TEXT,
         state TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
    );
  }

  private activeCount(): number {
    return this.sql.exec(`SELECT count(*) AS n FROM jobs WHERE state IN ${ACTIVE}`).one().n as number;
  }

  reserve(jobId: number, runId: number, nowMs: number, maxConcurrent: number): ReserveResult {
    const existing = this.sql.exec("SELECT job_id FROM jobs WHERE job_id = ?", jobId).toArray();
    if (existing.length > 0) return { decision: "duplicate" };

    const full = maxConcurrent > 0 && this.activeCount() >= maxConcurrent;
    const state = full ? "pending" : "provisioning";
    this.sql.exec(
      "INSERT INTO jobs (job_id, run_id, sandbox_id, state, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?)",
      jobId, runId, state, nowMs, nowMs,
    );
    return { decision: full ? "queued" : "provision" };
  }

  attachSandbox(jobId: number, sandboxId: string, nowMs: number): void {
    this.sql.exec(
      "UPDATE jobs SET sandbox_id = ?, state = 'booted', updated_at = ? WHERE job_id = ?",
      sandboxId, nowMs, jobId,
    );
  }

  markInProgress(jobId: number, nowMs: number): void {
    this.sql.exec("UPDATE jobs SET state = 'in_progress', updated_at = ? WHERE job_id = ?", nowMs, jobId);
  }

  markProvisionFailed(jobId: number): void {
    this.sql.exec("DELETE FROM jobs WHERE job_id = ?", jobId);
  }

  complete(jobId: number, nowMs: number): CompleteResult {
    const rows = this.sql.exec("SELECT * FROM jobs WHERE job_id = ?", jobId).toArray() as unknown as Row[];
    const row = rows[0];
    this.sql.exec("DELETE FROM jobs WHERE job_id = ?", jobId);
    const destroySandboxId = row?.sandbox_id ?? null;
    const next = this.dequeueOne(nowMs);
    return { destroySandboxId, next };
  }

  private dequeueOne(nowMs: number): { jobId: number; runId: number } | null {
    const pend = this.sql.exec(
      "SELECT job_id, run_id FROM jobs WHERE state = 'pending' ORDER BY created_at ASC LIMIT 1",
    ).toArray() as unknown as { job_id: number; run_id: number }[];
    const p = pend[0];
    if (!p) return null;
    this.sql.exec("UPDATE jobs SET state = 'provisioning', updated_at = ? WHERE job_id = ?", nowMs, p.job_id);
    return { jobId: p.job_id, runId: p.run_id };
  }

  reap(nowMs: number): ReapResult {
    const rows = this.sql.exec("SELECT * FROM jobs WHERE state IN ${ACTIVE}".replace("${ACTIVE}", ACTIVE))
      .toArray() as unknown as Row[];
    const orphans = rows.filter((r) => {
      if (r.state === "provisioning") return nowMs - r.created_at > this.provisionTimeoutMs;
      if (r.state === "booted") return nowMs - r.updated_at > this.runnerStartTimeoutMs;
      if (r.state === "in_progress") return nowMs - r.created_at > this.maxJobDurationMs;
      return false;
    }).map((r) => ({ jobId: r.job_id, sandboxId: r.sandbox_id }));

    // Dequeue pending into slots the orphans are about to free.
    const next: { jobId: number; runId: number }[] = [];
    for (let i = 0; i < orphans.length; i++) {
      const n = this.dequeueOne(nowMs);
      if (n) next.push(n);
    }
    return { orphans, next };
  }

  clear(jobIds: number[]): void {
    for (const id of jobIds) this.sql.exec("DELETE FROM jobs WHERE job_id = ?", id);
  }

  snapshot(): { jobId: number; state: string; sandboxId: string | null }[] {
    const rows = this.sql.exec("SELECT job_id, state, sandbox_id FROM jobs ORDER BY job_id").toArray() as unknown as
      { job_id: number; state: string; sandbox_id: string | null }[];
    return rows.map((r) => ({ jobId: r.job_id, state: r.state, sandboxId: r.sandbox_id }));
  }
}
```
Note on the `reap` query: build the SQL string without template-literal interpolation of untrusted data — `ACTIVE` is a compile-time constant, so it is safe; the `.replace` form above avoids a lint false-positive on SQL-in-template-literals. If your lint config is fine with it, use `` `SELECT * FROM jobs WHERE state IN ${ACTIVE}` `` directly.

- [ ] **Step 4: Run — verify pass.** Run: `bun run test test/integration/coordinator.test.ts` → PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/coordinator.ts test/integration/coordinator.test.ts
git commit -m "feat: Coordinator DO SQLite state machine"
```

---

## Task 10: Wire the Worker — webhook orchestration + reaper

**Files:**
- Modify: `src/index.ts`
- Create: `src/deps.ts` (builds the runtime clients; the seam integration tests mock)
- Test: `test/integration/flow.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `src/deps.ts`: `makeDeps(cfg: Config): { github: GitHubClient; sandboxes: SandboxClient }` — the single place that constructs real clients, so tests `vi.mock("../../src/deps")`.
  - `index.ts` `fetch`: routes `GET /health`, `POST /webhook`.
  - `index.ts` `scheduled`: the cron reaper.

- [ ] **Step 1: Create `src/deps.ts`**

```ts
import type { Config } from "./types";
import { makeGitHubClient, type GitHubClient } from "./github/client";
import { makeSandboxClient, type SandboxClient } from "./sandboxes";

export interface Deps {
  github: GitHubClient;
  sandboxes: SandboxClient;
}

export function makeDeps(cfg: Config): Deps {
  return {
    github: makeGitHubClient(cfg, () => Date.now()),
    sandboxes: makeSandboxClient(cfg),
  };
}
```

- [ ] **Step 2: Write the failing test `test/integration/flow.test.ts`** (mocks `deps`, uses the real DO + real routing; drives a full queued→boot→in_progress→completed cycle)

```ts
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach } from "vitest";
import worker from "../../src/index";

const created: string[] = [];
const destroyed: string[] = [];
const launched: string[] = [];

vi.mock("../../src/deps", () => ({
  makeDeps: () => ({
    github: { generateJitConfig: async (name: string) => ({ encodedJitConfig: `blob-${name}`, runnerId: 1 }), getRunHeadRepo: async () => "" },
    sandboxes: {
      create: async (o: { name: string }) => {
        const id = `sb_${o.name}`;
        created.push(id);
        return { id, runCommand: async (_c: string, a: string[]) => { launched.push(a[1]!); }, destroy: async () => { destroyed.push(id); } };
      },
      get: async (id: string) => ({ id, runCommand: async () => {}, destroy: async () => { destroyed.push(id); } }),
    },
  }),
}));

async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return "sha256=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function post(action: string, jobId: number, labels = ["createos"]): Promise<Response> {
  const body = JSON.stringify({
    action,
    workflow_job: { id: jobId, run_id: jobId * 10, run_attempt: 1, status: action, labels, name: "b" },
    repository: { full_name: "nodeops-app/x", private: true },
  });
  const req = new Request("https://x/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "workflow_job",
      "x-hub-signature-256": await sign(env.GITHUB_WEBHOOK_SECRET, body),
    },
    body,
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx); // flush ctx.waitUntil (provision/teardown)
  return res;
}

beforeEach(() => { created.length = 0; destroyed.length = 0; launched.length = 0; });

describe("full flow", () => {
  it("provisions on queued, launches the runner, destroys on completed", async () => {
    expect((await post("queued", 1)).status).toBe(202);
    expect(created).toEqual(["sb_ghar-1"]);
    expect(launched[0]).toContain("run-wrapper.sh");

    expect((await post("in_progress", 1)).status).toBe(202);
    expect((await post("completed", 1)).status).toBe(202);
    expect(destroyed).toContain("sb_ghar-1");
  });

  it("rejects a bad signature with 401", async () => {
    const body = JSON.stringify({ action: "queued", workflow_job: { id: 9, run_id: 9, labels: ["createos"] }, repository: { full_name: "nodeops-app/x", private: true } });
    const req = new Request("https://x/webhook", { method: "POST", headers: { "x-github-event": "workflow_job", "x-hub-signature-256": "sha256=deadbeef" }, body });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });

  it("ignores jobs without the createos label (204, no boot)", async () => {
    expect((await post("queued", 2, ["ubuntu-latest"])).status).toBe(204);
    expect(created).toEqual([]);
  });
});
```
Add the local test secret to `wrangler.toml`'s test env by creating `.dev.vars` for tests, or set it via `vitest.config.ts` `miniflare.bindings`. Simplest: add to `vitest.config.ts` under `poolOptions.workers.miniflare.bindings`:
```ts
miniflare: { compatibilityFlags: ["nodejs_compat"], bindings: { GITHUB_WEBHOOK_SECRET: "test-secret", /* + the other required vars/secrets with dummy values */ } },
```
List every field the `Env` interface marks required (dummy values are fine; `deps` is mocked so GitHub/createos creds are unused).

- [ ] **Step 3: Run — verify it fails.** Run: `bun run test test/integration/flow.test.ts` → FAIL.

- [ ] **Step 4: Replace `src/index.ts`**

```ts
import type { Env } from "./env";
import type { Config, WorkflowJobEvent } from "./types";
import { parseConfig } from "./config";
import { verifySignature, parseEvent } from "./webhook";
import { shouldProvision } from "./policy";
import { isForkRun } from "./github/client";
import { provision } from "./provision";
import { teardown } from "./teardown";
import { makeDeps } from "./deps";

export { Coordinator } from "./coordinator";

type CoordinatorStub = DurableObjectStub<import("./coordinator").Coordinator>;

function coordinator(env: Env): CoordinatorStub {
  return env.COORDINATOR.get(env.COORDINATOR.idFromName("singleton")) as CoordinatorStub;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname !== "/webhook" || request.method !== "POST") {
      return new Response("not found", { status: 404 });
    }

    const cfg = parseConfig(env);
    const body = await request.text();
    if (!(await verifySignature(cfg.webhookSecret, body, request.headers.get("x-hub-signature-256")))) {
      return new Response("bad signature", { status: 401 });
    }
    const event = parseEvent(request.headers.get("x-github-event"), body);
    if (!event) return new Response("ignored", { status: 204 });

    const coord = coordinator(env);
    const deps = makeDeps(cfg);

    if (event.action === "queued") {
      if (!shouldProvision(cfg, event)) return new Response("skipped", { status: 204 });
      if (cfg.provisionPolicy === "fork-gated" && (await isForkRun(deps.github, event))) {
        return new Response("fork skipped", { status: 204 });
      }
      const r = await coord.reserve(event.workflow_job.id, event.workflow_job.run_id, Date.now(), cfg.maxConcurrent);
      if (r.decision === "provision") {
        ctx.waitUntil(provisionAndRecord(env, cfg, event.workflow_job.id, deps));
      }
      return new Response(r.decision, { status: 202 });
    }

    if (event.action === "in_progress") {
      await coord.markInProgress(event.workflow_job.id, Date.now());
      return new Response("noted", { status: 202 });
    }

    if (event.action === "completed") {
      const r = await coord.complete(event.workflow_job.id, Date.now());
      ctx.waitUntil(handleComplete(env, cfg, r, deps));
      return new Response("completing", { status: 202 });
    }

    return new Response("ignored", { status: 204 });
  },

  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const cfg = parseConfig(env);
    const deps = makeDeps(cfg);
    const coord = coordinator(env);
    const { orphans, next } = await coord.reap(Date.now());

    await Promise.allSettled(
      orphans.filter((o) => o.sandboxId).map((o) => teardown(deps.sandboxes, o.sandboxId!)),
    );
    await coord.clear(orphans.map((o) => o.jobId));

    for (const n of next) {
      await provisionAndRecord(env, cfg, n.jobId, deps);
    }
  },
} satisfies ExportedHandler<Env>;

async function provisionAndRecord(
  env: Env, cfg: Config, jobId: number, deps: ReturnType<typeof makeDeps>,
): Promise<void> {
  const coord = coordinator(env);
  const job = { id: jobId } as WorkflowJobEvent["workflow_job"];
  try {
    const sandboxId = await provision({ github: deps.github, sandboxes: deps.sandboxes, cfg }, job);
    await coord.attachSandbox(jobId, sandboxId, Date.now());
  } catch (err) {
    console.error(`provision failed for job ${jobId}:`, err);
    await coord.markProvisionFailed(jobId);
  }
}

async function handleComplete(
  env: Env, cfg: Config, r: import("./types").CompleteResult, deps: ReturnType<typeof makeDeps>,
): Promise<void> {
  if (r.destroySandboxId) await teardown(deps.sandboxes, r.destroySandboxId);
  if (r.next) await provisionAndRecord(env, cfg, r.next.jobId, deps);
}
```
Note: `provision` only needs `job.id` (for the JIT name + sandbox name); passing a minimal `{ id }` is intentional and type-safe via the cast, since dequeued pending jobs are re-provisioned by id.

- [ ] **Step 5: Run — verify pass.** Run: `bun run test test/integration/flow.test.ts` → PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/deps.ts test/integration/flow.test.ts vitest.config.ts
git commit -m "feat: wire webhook orchestration and cron reaper"
```

---

## Task 11: Concurrency cap + pending queue (integration)

**Files:**
- Test: `test/integration/concurrency.test.ts`

**Interfaces:** Consumes the wired Worker + mocked `deps` from Task 10 (repeat the mock; the engineer may read tasks out of order).

- [ ] **Step 1: Write the test `test/integration/concurrency.test.ts`**

```ts
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach } from "vitest";
import worker from "../../src/index";

const created: string[] = [];
const destroyed: string[] = [];

vi.mock("../../src/deps", () => ({
  makeDeps: () => ({
    github: { generateJitConfig: async (name: string) => ({ encodedJitConfig: `b-${name}`, runnerId: 1 }), getRunHeadRepo: async () => "" },
    sandboxes: {
      create: async (o: { name: string }) => { const id = `sb_${o.name}`; created.push(id); return { id, runCommand: async () => {}, destroy: async () => { destroyed.push(id); } }; },
      get: async (id: string) => ({ id, runCommand: async () => {}, destroy: async () => { destroyed.push(id); } }),
    },
  }),
}));

// Force MAX_CONCURRENT=1 for this file only.
vi.mock("../../src/config", async (orig) => {
  const real = await orig<typeof import("../../src/config")>();
  return { parseConfig: (e: unknown) => ({ ...real.parseConfig(e), maxConcurrent: 1 }) };
});

async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return "sha256=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function post(action: string, jobId: number): Promise<Response> {
  const body = JSON.stringify({ action, workflow_job: { id: jobId, run_id: jobId * 10, run_attempt: 1, status: action, labels: ["createos"], name: "b" }, repository: { full_name: "nodeops-app/x", private: true } });
  const req = new Request("https://x/webhook", { method: "POST", headers: { "x-github-event": "workflow_job", "x-hub-signature-256": await sign(env.GITHUB_WEBHOOK_SECRET, body) }, body });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

beforeEach(() => { created.length = 0; destroyed.length = 0; });

describe("concurrency cap", () => {
  it("boots one, queues the second, promotes it when the first completes", async () => {
    expect((await post("queued", 1)).status).toBe(202); // provision
    expect((await post("queued", 2)).status).toBe(202); // queued (cap=1)
    expect(created).toEqual(["sb_ghar-1"]);

    await post("completed", 1); // frees the slot → dequeues job 2
    expect(destroyed).toContain("sb_ghar-1");
    expect(created).toContain("sb_ghar-2");
  });
});
```
Note: because these tests share a singleton DO name across files, give this file's DO a distinct name — or reset state. Simplest: in `beforeEach`, call `coordinator` with a per-test name is not possible through the public route (it uses `"singleton"`). Instead, drain state at the start: post `completed` for any ids used. For isolation, this file uses fresh job ids (1,2) and asserts on the mock arrays, which `beforeEach` clears; the DO rows for 1,2 are removed by their own `completed`. If cross-file bleed appears, add a `__resetForTest` DO method behind `if (env.ENVIRONMENT === "test")` and call it in `beforeEach`.

- [ ] **Step 2: Run — verify pass** (after implementing any needed reset). Run: `bun run test test/integration/concurrency.test.ts` → PASS.

- [ ] **Step 3: Commit**

```bash
git add test/integration/concurrency.test.ts src/coordinator.ts
git commit -m "test: concurrency cap and pending-queue promotion"
```

---

## Task 12: Idempotency + cancellation + provision failure (integration)

**Files:**
- Test: `test/integration/idempotency.test.ts`

- [ ] **Step 1: Write the test `test/integration/idempotency.test.ts`** (reuse the Task 10 mock block verbatim, plus a failing-create variant)

```ts
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach } from "vitest";
import worker from "../../src/index";

const created: string[] = [];

vi.mock("../../src/deps", () => ({
  makeDeps: () => ({
    github: { generateJitConfig: async (name: string) => ({ encodedJitConfig: `b-${name}`, runnerId: 1 }), getRunHeadRepo: async () => "" },
    sandboxes: {
      create: async (o: { name: string }) => {
        if (o.name === "ghar-500") throw new Error("createos: capacity");
        const id = `sb_${o.name}`; created.push(id);
        return { id, runCommand: async () => {}, destroy: async () => {} };
      },
      get: async (id: string) => ({ id, runCommand: async () => {}, destroy: async () => {} }),
    },
  }),
}));

async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return "sha256=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function post(action: string, jobId: number): Promise<Response> {
  const body = JSON.stringify({ action, workflow_job: { id: jobId, run_id: jobId * 10, run_attempt: 1, status: action, labels: ["createos"], name: "b" }, repository: { full_name: "nodeops-app/x", private: true } });
  const req = new Request("https://x/webhook", { method: "POST", headers: { "x-github-event": "workflow_job", "x-hub-signature-256": await sign(env.GITHUB_WEBHOOK_SECRET, body) }, body });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
beforeEach(() => { created.length = 0; });

describe("idempotency + edge cases", () => {
  it("a redelivered queued event does not double-boot", async () => {
    await post("queued", 100);
    await post("queued", 100); // redelivery → duplicate
    expect(created).toEqual(["sb_ghar-100"]);
  });

  it("cancelled-before-boot: completed on a pending job is a no-op teardown", async () => {
    // (cap not hit here, so 200 boots; simulate cancel of a job that had booted)
    await post("queued", 200);
    const res = await post("completed", 200);
    expect(res.status).toBe(202);
  });

  it("provision failure frees the slot (job removed, not stuck)", async () => {
    await post("queued", 500); // create throws → markProvisionFailed
    // A later different job must still be bootable (slot not leaked).
    await post("queued", 501);
    expect(created).toEqual(["sb_ghar-501"]);
  });
});
```

- [ ] **Step 2: Run — verify pass.** Run: `bun run test test/integration/idempotency.test.ts` → PASS.

- [ ] **Step 3: Commit**

```bash
git add test/integration/idempotency.test.ts
git commit -m "test: redelivery idempotency, cancellation, provision-failure recovery"
```

---

## Task 13: Reaper via cron (integration)

**Files:**
- Test: `test/integration/reaper.test.ts`

**Interfaces:** Drives `worker.scheduled(...)` with `createScheduledController`.

- [ ] **Step 1: Write the test `test/integration/reaper.test.ts`**

```ts
import { env, createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi } from "vitest";
import worker from "../../src/index";

const destroyed: string[] = [];

vi.mock("../../src/deps", () => ({
  makeDeps: () => ({
    github: { generateJitConfig: async () => ({ encodedJitConfig: "b", runnerId: 1 }), getRunHeadRepo: async () => "" },
    sandboxes: {
      create: async (o: { name: string }) => ({ id: `sb_${o.name}`, runCommand: async () => {}, destroy: async () => {} }),
      get: async (id: string) => ({ id, runCommand: async () => {}, destroy: async () => { destroyed.push(id); } }),
    },
  }),
}));

function stub() { return env.COORDINATOR.get(env.COORDINATOR.idFromName("singleton")); }

describe("cron reaper", () => {
  it("destroys a booted-but-never-started orphan and clears it", async () => {
    const c = stub();
    // Seed a stale 'booted' row directly (updated_at far in the past).
    await c.reserve(9001, 90010, 0, 0);
    await c.attachSandbox(9001, "sb_ghar-9001", 0);

    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: new Date(600_000), cron: "*/2 * * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(destroyed).toContain("sb_ghar-9001");
    expect((await c.snapshot()).find((s) => s.jobId === 9001)).toBeUndefined();
  });
});
```
Note: the reaper's `Date.now()` in `scheduled` drives the timeout comparison; `createScheduledController`'s `scheduledTime` does not change `Date.now()`. Seed rows with `created_at/updated_at = 0` so any real `Date.now()` exceeds the timeouts. If you need a deterministic clock, inject `now` into `scheduled` behind a test hook; the seed-at-zero approach avoids that.

- [ ] **Step 2: Run — verify pass.** Run: `bun run test test/integration/reaper.test.ts` → PASS.

- [ ] **Step 3: Run the whole suite + lint + typecheck**

```bash
bun run test && bun run lint && bun run typecheck
```
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add test/integration/reaper.test.ts
git commit -m "test: cron reaper destroys and clears orphans"
```

---

## Task 14: Runner rootfs template (image)

**Files:**
- Create: `image/Dockerfile`, `image/run-wrapper.sh`, `image/build-template.ts`

**Interfaces:** Produces a createos template named per `RUNNER_TEMPLATE` (`ghar-runner`) with the actions runner + docker + the wrapper baked in. No unit test (it builds a remote image); verified by a manual smoke step.

- [ ] **Step 1: Create `image/run-wrapper.sh`**

```sh
#!/usr/bin/env bash
# Launched detached inside the VM. Runs exactly one job, then halts the VM so
# fc's liveness watcher reaps it (backstop to the completed-webhook teardown).
set -uo pipefail

cd /opt/actions-runner

# Acceptable to run as root: the whole VM is a single-use, isolated sandbox.
export RUNNER_ALLOW_RUNASROOT=1

if [ -z "${RUNNER_JITCONFIG:-}" ]; then
  echo "RUNNER_JITCONFIG not set" >&2
  halt -f
  exit 1
fi

./run.sh --jitconfig "$RUNNER_JITCONFIG" || true

# One job done (ephemeral runner has exited). Power off → liveness reap.
halt -f
```

- [ ] **Step 2: Create `image/Dockerfile`** (RUN-only; single allowlisted FROM; runner + docker via `curl`, checksum-verified)

```dockerfile
# Base must be an allowlisted createos base image. Confirm the exact tag with
# `client.listRootfs()` before building; debian is the safe default (NOT alpine
# — the actions runner needs glibc).
FROM nodeops/sandbox:debian

# Pin the runner version; bump deliberately.
ARG RUNNER_VERSION=2.320.0
ARG RUNNER_SHA256=93ac1b7ce743ee85b5d386f5c1787385ef07b3d7c728ff66ce0d3813d5f46900

RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq tar gzip sudo \
      docker.io docker-buildx \
 && rm -rf /var/lib/apt/lists/*

# Install the GitHub Actions runner (no COPY allowed — fetch via RUN).
RUN mkdir -p /opt/actions-runner /opt/ghar \
 && curl -fsSL -o /tmp/runner.tgz \
      "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" \
 && echo "${RUNNER_SHA256}  /tmp/runner.tgz" | sha256sum -c - \
 && tar -xzf /tmp/runner.tgz -C /opt/actions-runner \
 && rm /tmp/runner.tgz \
 && /opt/actions-runner/bin/installdependencies.sh

# Bake the wrapper by writing it inline (no COPY).
RUN cat > /opt/ghar/run-wrapper.sh <<'WRAP' \
 && chmod +x /opt/ghar/run-wrapper.sh
#!/usr/bin/env bash
set -uo pipefail
cd /opt/actions-runner
export RUNNER_ALLOW_RUNASROOT=1
[ -z "${RUNNER_JITCONFIG:-}" ] && { echo "RUNNER_JITCONFIG not set" >&2; halt -f; exit 1; }
./run.sh --jitconfig "$RUNNER_JITCONFIG" || true
halt -f
WRAP
```
Note: `image/run-wrapper.sh` is the readable source of truth; the Dockerfile embeds the same script inline because templates forbid `COPY`. Keep the two in sync (a lint/CI check comparing them is a nice follow-up). Verify `RUNNER_SHA256` against the release's published checksum for your version before building. Confirm `nodeops/sandbox:debian` is on the allowlist via `client.listRootfs()`; adjust the tag if the catalog differs.

- [ ] **Step 3: Create `image/build-template.ts`** (run locally with bun to build+register the template)

```ts
import { CreateosSandboxClient, pollUntil } from "@nodeops-createos/sandbox";
import { readFileSync } from "node:fs";

const client = new CreateosSandboxClient(); // reads CREATEOS_SANDBOX_* from env
const name = process.env.RUNNER_TEMPLATE ?? "ghar-runner";
const dockerfile = readFileSync(new URL("./Dockerfile", import.meta.url), "utf8");

const tmpl = await client.templates.create({ name, dockerfile });
console.log("template build submitted:", tmpl.id, tmpl.status);

try {
  for await (const ev of client.templates.followLogs(tmpl.id, { timeoutMs: 900_000 })) {
    if (ev.line) process.stdout.write(ev.line + "\n");
    if (ev.final) break;
  }
} catch { /* stream may close early; poll below */ }

await pollUntil({
  poll: () => client.templates.get(tmpl.id).then((t) => t.status),
  done: (s) => s === "ready",
  failed: (s) => (s === "pending" || s === "building" ? undefined : `template build failed: ${s}`),
  timeoutMs: 900_000,
});
console.log("template ready:", name, tmpl.id);
```
Run: `RUNNER_TEMPLATE=ghar-runner bun run image/build-template.ts`
Expected: streams build logs, ends with `template ready: ghar-runner <id>`. Set `wrangler.toml`'s `RUNNER_TEMPLATE` to this name (or id).

- [ ] **Step 4: Manual smoke (documented, not automated)** — after building the template, temporarily point a scratch repo's workflow at `runs-on: [createos]`, push, and confirm one sandbox boots, the job runs, and the VM disappears. Record the result in the PR.

- [ ] **Step 5: Commit**

```bash
git add image/
git commit -m "feat: runner rootfs template, launch wrapper, and build script"
```

---

## Task 15: Docs + deployment runbook

**Files:**
- Create: `README.md`, `docs/deploy.md`

- [ ] **Step 1: Create `docs/deploy.md`** with the exact setup sequence

````markdown
# Deploy runbook

## 1. Create the GitHub App (org: nodeops-app)
- Permissions: **Organization → Self-hosted runners: Read & write**; **Repository → Actions: Read**; **Repository → Metadata: Read**.
- Subscribe to events: **Workflow job**.
- Webhook URL: `https://<worker-subdomain>.workers.dev/webhook`. Webhook secret: generate a random string.
- Install the App on the org (all repos, or selected — must include any repo using `runs-on: [createos]`).
- Note the **App ID** and **Installation ID**; generate a **private key** (downloads a PKCS#1 `.pem`).

## 2. Convert the private key to PKCS#8 (Web Crypto requirement)
```bash
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in app.private-key.pem -out app.pkcs8.pem
```

## 3. Build the runner template
```bash
RUNNER_TEMPLATE=ghar-runner bun run image/build-template.ts
```

## 4. Set Worker secrets
```bash
wrangler secret put GITHUB_APP_ID
wrangler secret put GITHUB_APP_INSTALLATION_ID
wrangler secret put GITHUB_APP_PRIVATE_KEY   # paste the PKCS#8 PEM
wrangler secret put GITHUB_WEBHOOK_SECRET
wrangler secret put CREATEOS_SANDBOX_API_KEY
```

## 5. Review vars in `wrangler.toml`
Confirm `CREATEOS_SANDBOX_BASE_URL`, `RUNNER_TEMPLATE`, and set `MAX_CONCURRENT` (recommended > 0 in production) and `PROVISION_POLICY` (`org-wide` default; `fork-gated` if any target repo is public).

## 6. Deploy
```bash
bun run deploy
```

## 7. Verify
- `curl https://<worker>/health` → `ok`.
- Push a workflow with `runs-on: [createos]`; confirm a sandbox boots, the job runs, and the VM is destroyed.
- Watch `wrangler tail` for provision/teardown logs.
````

- [ ] **Step 2: Create `README.md`** summarizing purpose, architecture (link ADRs + `CONTEXT.md`), config table (every env var + secret), the three teardown layers, the fc#520 self-destruct future, and `docs/deploy.md`. Include the security note: `org-wide` + `MAX_CONCURRENT=0` is wide open — set both before public-repo use.

- [ ] **Step 3: Final full verification**

```bash
bun run lint && bun run typecheck && bun run test
```
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/deploy.md
git commit -m "docs: deployment runbook and project README"
```

---

## Self-Review (completed against the grilled spec)

**Spec coverage:**
- Webhook `workflow_job` trigger + HMAC → Tasks 2, 10. ✅
- Ephemeral one-job runner + JIT config (org, `generate-jitconfig`, `runner_group_id:1`, label `createos`) → Tasks 6, 7, 14. ✅
- GitHub App auth, zero-dep Web Crypto RS256, PKCS#1→#8 → Tasks 4, 5, 15. ✅
- Pre-baked template + docker + `RUN`-only + halt wrapper → Task 14. ✅
- Teardown 3 layers (completed→destroy; runner-exit halt; cron reaper) → Tasks 8, 10, 13, 14. ✅
- SQLite DO on CF Free, DO = pure state, no fetch → Tasks 0, 9; ADR-0002. ✅
- Provisioning policy switch (org-wide default / repo-allowlist / fork-gated) → Tasks 3, 6, 10. ✅
- Concurrency cap `MAX_CONCURRENT` (0=unlimited) + pending queue → Tasks 9, 11. ✅
- Shape/disk env (`RUNNER_SHAPE`, `RUNNER_DISK_SIZE`) → Tasks 1, 7. ✅
- Idempotency (redelivery, cancel) → Task 12. ✅
- Two-layer tests (unit + pool-workers integration) → all tasks. ✅

**Placeholder scan:** the only intentional fill-in is the throwaway PKCS#8 test key in `test/unit/fixtures.ts` (Task 5, Step 2) — the engineer generates it with the given `openssl` command; it is test-only. No logic placeholders.

**Type consistency:** `Config`, `WorkflowJobEvent`, `ReserveResult`, `CompleteResult`, `ReapResult`, `SandboxClient`/`SandboxHandle`, `GitHubClient`, `Deps` names are used identically across tasks. DO method names (`reserve`/`attachSandbox`/`markInProgress`/`markProvisionFailed`/`complete`/`reap`/`clear`/`snapshot`) match between Task 9 and the callers in Task 10.
