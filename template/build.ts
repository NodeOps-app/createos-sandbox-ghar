import { readFileSync } from "node:fs";
import { CreateosSandboxClient, pollUntil } from "@nodeops-createos/sandbox";

const client = new CreateosSandboxClient({
  baseUrl: process.env.CREATEOS_BASE_URL!,
  apiKey: process.env.CREATEOS_API_KEY!,
});

const NAME = "ghar-runner";

/**
 * Latest actions/runner release, e.g. "2.335.1" (GitHub deprecates old runners),
 * and the linux-x64 tarball's sha256. The digest comes from two independent
 * places — the asset's `digest` field and the SHA block in the release notes —
 * and must match in both: one replaced asset or one edited note can't pass.
 */
async function latestRunner(): Promise<{ version: string; sha256: string }> {
  const headers: Record<string, string> = { "User-Agent": NAME };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch("https://api.github.com/repos/actions/runner/releases/latest", {
    headers,
  });
  if (!res.ok) throw new Error(`fetch latest runner release failed: ${res.status}`);
  const rel = (await res.json()) as {
    tag_name: string;
    body: string;
    assets: { name: string; digest?: string }[];
  };
  const version = rel.tag_name.replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`unexpected runner version: ${version}`);
  const asset = rel.assets.find((a) => a.name === `actions-runner-linux-x64-${version}.tar.gz`);
  const fromAsset = asset?.digest?.replace(/^sha256:/, "");
  const fromNotes = /<!-- BEGIN SHA linux-x64 -->([0-9a-f]{64})<!-- END SHA linux-x64 -->/.exec(
    rel.body,
  )?.[1];
  if (!fromAsset || !/^[0-9a-f]{64}$/.test(fromAsset) || fromAsset !== fromNotes) {
    throw new Error(`runner ${version} digest unconfirmed: asset=${fromAsset} notes=${fromNotes}`);
  }
  return { version, sha256: fromAsset };
}

const { version, sha256 } = await latestRunner();
const dockerfile = readFileSync(new URL("./Dockerfile", import.meta.url), "utf8")
  .replace(/ARG RUNNER_VERSION=\S+/, `ARG RUNNER_VERSION=${version}`)
  .replace(/ARG RUNNER_SHA256=\S+/, `ARG RUNNER_SHA256=${sha256}`);
console.log("building ghar-runner with actions/runner", version, sha256);

// createos rejects a duplicate template name, so drop any existing build first.
const existing = (await client.templates.list()).find((t) => t.name === NAME);
if (existing) {
  await client.templates.delete(existing.id);
  console.log("deleted previous template:", existing.id);
}

const tmpl = await client.templates.create({ name: NAME, dockerfile });
console.log("template:", tmpl.id, tmpl.status);

try {
  for await (const ev of client.templates.followLogs(tmpl.id, { timeoutMs: 900_000 })) {
    if (ev.line) process.stdout.write(ev.line + "\n");
    if (ev.final) break;
  }
} catch {
  // stream may close early; poll below
}

await pollUntil({
  poll: () => client.templates.get(tmpl.id).then((t) => t.status),
  done: (s) => s === "ready",
  failed: (s) => (s === "pending" || s === "building" ? undefined : `build failed: ${s}`),
  timeoutMs: 900_000,
});
console.log("ready:", tmpl.id, `(runner ${version}) → RUNNER_TEMPLATE=${NAME}`);
