import { readFileSync } from "node:fs";
import { CreateosSandboxClient, pollUntil } from "@nodeops-createos/sandbox";

const client = new CreateosSandboxClient({
  baseUrl: process.env.CREATEOS_BASE_URL!,
  apiKey: process.env.CREATEOS_API_KEY!,
});

const NAME = "ghar-runner";

/** Latest actions/runner release, e.g. "2.335.1" (GitHub deprecates old runners). */
async function latestRunnerVersion(): Promise<string> {
  const headers: Record<string, string> = { "User-Agent": NAME };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch("https://api.github.com/repos/actions/runner/releases/latest", {
    headers,
  });
  if (!res.ok) throw new Error(`fetch latest runner version failed: ${res.status}`);
  const { tag_name } = (await res.json()) as { tag_name: string };
  return tag_name.replace(/^v/, "");
}

const version = await latestRunnerVersion();
const dockerfile = readFileSync(new URL("./Dockerfile", import.meta.url), "utf8").replace(
  /ARG RUNNER_VERSION=\S+/,
  `ARG RUNNER_VERSION=${version}`,
);
console.log("building ghar-runner with actions/runner", version);

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
