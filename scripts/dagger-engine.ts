// Creates one tenant's Dagger engine: a private network plus a long-lived
// sandbox running the engine on it, then prints the admin call that points the
// tenant's runners at it.
//
//   CREATEOS_API_KEY=… CREATEOS_REGIONS=… bun scripts/dagger-engine.ts <installation_id> <org> <region> [shape] [disk_mib]
//
// The engine sandbox is not a job row, and its name (`<org>-dagger`) never
// parses as a runner name, so the reconciler and orphan sweep leave it alone.
// shortcut: no init in the guest — if the engine sandbox is recreated, rerun this
// script. Pause/resume changes its overlay IP, so re-assign after a resume.
import { CreateosSandboxClient } from "@nodeops-createos/sandbox";
import { regions } from "../src/config";
import { daggerEngineName } from "../src/sandbox";

const DAGGER_VERSION = "1.0.0-beta.23";
const [installationId, org, regionName, shape = "s-4vcpu-8gb", diskMib = "51200"] =
  process.argv.slice(2);
if (!installationId || !org || !regionName) {
  console.error(
    "usage: bun scripts/dagger-engine.ts <installation_id> <org> <region> [shape] [disk_mib]",
  );
  process.exit(2);
}
const region = regions(process.env).find((r) => r.name === regionName);
if (!region) throw new Error(`region ${regionName} not configured`);

const client = new CreateosSandboxClient({
  baseUrl: region.baseUrl,
  apiKey: process.env.CREATEOS_API_KEY!,
});
const name = daggerEngineName(org);

const network = await client.networks.create({ name });
const engine = await client.createSandbox({
  shape,
  rootfs: "ghar-runner", // already ships dockerd; the engine runs as Dagger documents it
  name,
  disk_mib: Number(diskMib),
  egress: ["*"], // the engine pulls images and modules from anywhere
  networks: [{ id: network.id }],
});

const sh = async (cmd: string) => {
  const { result } = await engine.runCommand("bash", ["-c", cmd]);
  if (result.exit_code !== 0) throw new Error(`${cmd}: ${result.stderr}`);
};
// Publish on the private-network IP only — the engine has no auth.
const ip = (await client.networks.get(network.id)).members?.find(
  (m) => m.sandbox_id === engine.id,
)?.ip;
if (!ip) throw new Error(`engine ${engine.id} has no IP on ${network.id}`);

await sh("( setsid dockerd >/var/log/dockerd.log 2>&1 </dev/null & ) ; echo ok");
await sh("for i in $(seq 1 60); do docker info >/dev/null 2>&1 && exit 0; sleep 0.5; done; exit 1");
await sh(
  `( setsid docker run -d --name dagger-engine --privileged --restart always ` +
    `-v dagger-engine-cache:/var/lib/dagger -p ${ip}:1234:1234 ` +
    `registry.dagger.io/engine:v${DAGGER_VERSION} --addr tcp://0.0.0.0:1234 ` +
    `>/var/log/engine-run.log 2>&1 </dev/null & ) ; echo ok`,
);
await sh(
  "for i in $(seq 1 110); do docker ps -q --filter name=dagger-engine --filter status=running | grep -q . && exit 0; sleep 0.5; done; exit 1",
);

console.log(`engine sandbox ${engine.id} on network ${network.id} (${regionName})`);
console.log(`tenant workflows must use dagger CLI v${DAGGER_VERSION}\n`);
console.log(
  `curl -fsS -X POST "$GHAR_URL/admin/tenants/dagger" -H "Authorization: Bearer $ADMIN_TOKEN" ` +
    `-H 'content-type: application/json' -d '${JSON.stringify({
      installation_id: Number(installationId),
      dagger: { region: regionName, network_id: network.id, engine: `tcp://${ip}:1234` },
    })}'`,
);
