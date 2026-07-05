import { readFileSync } from "node:fs";
import { CreateosSandboxClient, pollUntil } from "@nodeops-createos/sandbox";

const client = new CreateosSandboxClient({
  baseUrl: process.env.CREATEOS_BASE_URL!,
  apiKey: process.env.CREATEOS_API_KEY!,
});

const dockerfile = readFileSync(new URL("./Dockerfile", import.meta.url), "utf8");
const NAME = "ghar-runner";

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
console.log("ready:", tmpl.id, "→ set RUNNER_TEMPLATE to", NAME);
