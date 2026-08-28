/**
 * The operator dashboard page. One self-contained HTML string — no bundler
 * step, no CDN, no framework: the Worker serves it and the page polls
 * `/admin/dashboard.json` on a 5s timer with the admin session cookie.
 *
 * Polling, not a WebSocket, on purpose: the Coordinator must stay passive and
 * hibernating (see AGENTS.md), and a push channel would keep it awake for as
 * long as a dashboard tab is open.
 *
 * What it can and cannot show is fixed by what the DO stores. A job row is
 * DELETED at teardown, so "live" is exact and history is only the `usage`
 * table — weighted minutes and egress per tenant, per repo, per UTC calendar
 * month. The page therefore says "this month / last month", never "30 days".
 */
export const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>ghar runners</title>
<style>
:root {
  --bg: #f7f7f8; --panel: #fff; --line: #e3e3e6; --fg: #16161a; --dim: #6b6b76;
  --pending: #b8860b; --provisioning: #2563eb; --running: #15803d;
  --destroying: #6b6b76; --warn: #b91c1c; --bar: #2563eb; --bar-bg: #e8e8ec;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f0f11; --panel: #17171a; --line: #2a2a30; --fg: #ececed; --dim: #9a9aa4;
    --pending: #e0a82e; --provisioning: #60a5fa; --running: #4ade80;
    --destroying: #9a9aa4; --warn: #f87171; --bar: #60a5fa; --bar-bg: #26262c;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 20px; background: var(--bg); color: var(--fg);
  font: 14px/1.5 ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
}
h1 { font-size: 17px; margin: 0; font-weight: 600; }
h2 { font-size: 13px; margin: 0 0 10px; font-weight: 600; text-transform: uppercase;
     letter-spacing: .06em; color: var(--dim); }
header { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; margin-bottom: 18px; }
#status { color: var(--dim); font-size: 12px; font-variant-numeric: tabular-nums; }
#status.stale { color: var(--warn); }
section { background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
          padding: 16px; margin-bottom: 16px; }
.tiles { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); }
.tile { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
.tile .n { font-size: 24px; font-weight: 600; font-variant-numeric: tabular-nums; }
.tile .k { font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: .05em; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .05em;
     color: var(--dim); font-weight: 600; padding: 0 10px 6px 0; white-space: nowrap; }
td { padding: 6px 10px 6px 0; border-top: 1px solid var(--line); white-space: nowrap; }
a { color: inherit; }
.dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 6px; }
.pending .dot { background: var(--pending); } .pending td:nth-child(3) { color: var(--pending); }
.provisioning .dot { background: var(--provisioning); }
.provisioning td:nth-child(3) { color: var(--provisioning); }
.running .dot { background: var(--running); } .running td:nth-child(3) { color: var(--running); }
.destroying .dot { background: var(--destroying); }
.destroying td:nth-child(3) { color: var(--destroying); }
.old { color: var(--warn); font-weight: 600; }
.bar { background: var(--bar-bg); border-radius: 3px; height: 7px; width: 160px; overflow: hidden; }
.bar > i { display: block; height: 100%; background: var(--bar); }
.bar > i.over { background: var(--warn); }
.empty { color: var(--dim); padding: 6px 0; }
.note { color: var(--dim); font-size: 12px; margin: 10px 0 0; }
.sub td:first-child { padding-left: 18px; color: var(--dim); }
</style>
</head>
<body>
<header>
  <h1>ghar runners</h1>
  <span id="status">loading…</span>
</header>

<section>
  <h2>Live</h2>
  <div class="tiles" id="tiles"></div>
</section>

<section>
  <h2>Jobs in flight</h2>
  <div class="scroll"><table>
    <thead><tr>
      <th>Repository</th><th>Job</th><th>State</th><th>Label</th>
      <th>Region</th><th>Age</th><th>Booting</th><th>Try</th>
    </tr></thead>
    <tbody id="jobs"></tbody>
  </table></div>
  <div class="empty" id="jobs-empty" hidden>No jobs in flight.</div>
</section>

<section>
  <h2>Usage</h2>
  <div class="scroll"><table>
    <thead><tr>
      <th>Tenant / repository</th><th>Status</th><th>This month</th>
      <th>Of grant</th><th>Last month</th><th>Egress</th>
    </tr></thead>
    <tbody id="usage"></tbody>
  </table></div>
  <div class="empty" id="usage-empty" hidden>No usage recorded.</div>
  <p class="note" id="usage-note"></p>
</section>

<script>
const $ = (id) => document.getElementById(id);

function dur(ms) {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m " + (s % 60) + "s";
  return Math.floor(m / 60) + "h " + (m % 60) + "m";
}

function bytes(n) {
  const u = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(1)) + " " + u[i];
}

function cell(text, cls) {
  const td = document.createElement("td");
  td.textContent = text;
  if (cls) td.className = cls;
  return td;
}

function renderJobs(snap) {
  const tb = $("jobs");
  tb.replaceChildren();
  for (const j of snap.jobs) {
    const tr = document.createElement("tr");
    tr.className = j.state;

    const repo = document.createElement("td");
    const dot = document.createElement("span");
    dot.className = "dot";
    repo.append(dot, document.createTextNode(j.repoFullName));
    tr.append(repo);

    const link = document.createElement("td");
    const a = document.createElement("a");
    // Deep-link to the run, not the job: the run page is the one an operator
    // can open for any job id, and it is where the logs live.
    a.href = "https://github.com/" + j.repoFullName + "/actions/runs/" + j.runId;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = String(j.jobId);
    link.append(a);
    tr.append(link);

    tr.append(cell(j.state));
    tr.append(cell(j.label ?? "—"));
    tr.append(cell(j.region ?? "primary"));

    // Age is measured from queue entry, so a job parked behind the concurrency
    // cap ages while it waits — that is the number an operator wants to see.
    const age = snap.nowMs - j.createdAt;
    tr.append(cell(dur(age), age > 15 * 60_000 ? "old" : ""));

    // Time spent getting a VM. It stops at the moment the runner picks the job
    // up, so a running job shows how long it took, not a climbing clock.
    const start = j.provisionStartedAt;
    const end = j.jobStartedAt ?? j.bootedAt ?? snap.nowMs;
    tr.append(cell(start === null ? "—" : dur(end - start)));

    tr.append(cell(j.attempts > 1 ? "#" + j.attempts : "1", j.attempts > 1 ? "old" : ""));
    tb.append(tr);
  }
  $("jobs-empty").hidden = snap.jobs.length > 0;
}

function renderTiles(snap) {
  const by = { pending: 0, provisioning: 0, running: 0, destroying: 0 };
  for (const j of snap.jobs) if (j.state in by) by[j.state]++;
  const tiles = [
    ["running", by.running],
    ["provisioning", by.provisioning],
    ["pending", by.pending],
    ["destroying", by.destroying],
    ["tenants", snap.tenants.filter((t) => t.status === "approved").length],
  ];
  const box = $("tiles");
  box.replaceChildren();
  for (const [k, n] of tiles) {
    const d = document.createElement("div");
    d.className = "tile";
    const nv = document.createElement("div");
    nv.className = "n";
    nv.textContent = String(n);
    const kv = document.createElement("div");
    kv.className = "k";
    kv.textContent = k;
    d.append(nv, kv);
    box.append(d);
  }
}

function renderUsage(snap) {
  // Group by tenant. A usage row can name an installation with no tenant row
  // (single-tenant mode writes installation_id 0), so the tenant list is a
  // lookup, never the set of groups — otherwise those minutes vanish.
  const byTenant = new Map();
  for (const u of snap.usage) {
    let g = byTenant.get(u.installationId);
    if (!g) {
      const t = snap.tenants.find((x) => x.installationId === u.installationId);
      g = {
        label: t ? t.orgLogin : "installation " + u.installationId,
        status: t ? t.status : "—",
        grant: t ? t.minuteGrant : 0,
        current: 0, previous: 0, egress: 0, repos: new Map(),
      };
      byTenant.set(u.installationId, g);
    }
    const key = u.month === snap.months.current ? "current" : "previous";
    g[key] += u.weightedMinutes;
    let r = g.repos.get(u.repoFullName);
    if (!r) { r = { current: 0, previous: 0, egress: 0 }; g.repos.set(u.repoFullName, r); }
    r[key] += u.weightedMinutes;
    if (u.month === snap.months.current) {
      g.egress += u.egressBytes;
      r.egress += u.egressBytes;
    }
  }

  const tb = $("usage");
  tb.replaceChildren();
  const groups = [...byTenant.values()].sort((a, b) => b.current - a.current);
  for (const g of groups) {
    const tr = document.createElement("tr");
    tr.append(cell(g.label));
    tr.append(cell(g.status));
    tr.append(cell(Math.round(g.current).toLocaleString() + " min"));

    const barCell = document.createElement("td");
    if (g.grant > 0) {
      const pct = (g.current / g.grant) * 100;
      const bar = document.createElement("div");
      bar.className = "bar";
      bar.title = Math.round(pct) + "% of " + g.grant.toLocaleString() + " min";
      const fill = document.createElement("i");
      fill.style.width = Math.min(100, pct) + "%";
      if (pct >= 100) fill.className = "over";
      bar.append(fill);
      barCell.append(bar);
    } else {
      barCell.textContent = "—";
    }
    tr.append(barCell);

    tr.append(cell(Math.round(g.previous).toLocaleString() + " min"));
    tr.append(cell(bytes(g.egress)));
    tb.append(tr);

    for (const [repo, r] of [...g.repos].sort((a, b) => b[1].current - a[1].current)) {
      const sub = document.createElement("tr");
      sub.className = "sub";
      sub.append(cell(repo));
      sub.append(cell(""));
      sub.append(cell(Math.round(r.current).toLocaleString() + " min"));
      sub.append(cell(""));
      sub.append(cell(Math.round(r.previous).toLocaleString() + " min"));
      sub.append(cell(bytes(r.egress)));
      tb.append(sub);
    }
  }
  $("usage-empty").hidden = groups.length > 0;
  $("usage-note").textContent =
    "Weighted minutes per UTC calendar month: " + snap.months.current +
    " and " + snap.months.previous + ". A finished job leaves no other record, " +
    "so no day-by-day series exists.";
}

async function tick() {
  try {
    const res = await fetch("/admin/dashboard.json", { credentials: "same-origin" });
    if (res.status === 404) {
      // The session expired (8h) or was cleared. The page route answers an
      // unauthenticated GET with the login form, so a reload IS the sign-in
      // prompt. Never leave a stale board on screen — that is the one failure
      // mode an ops dashboard must not have.
      $("status").className = "stale";
      $("status").textContent = "session expired — signing in again…";
      location.reload();
      return;
    }
    if (!res.ok) throw new Error("HTTP " + res.status);
    const snap = await res.json();
    renderTiles(snap);
    renderJobs(snap);
    renderUsage(snap);
    $("status").className = "";
    $("status").textContent = "updated " + new Date(snap.nowMs).toLocaleTimeString();
  } catch (err) {
    $("status").className = "stale";
    $("status").textContent = "update failed: " + err.message;
  }
}

tick();
setInterval(tick, 5000);
</script>
</body>
</html>`;

/**
 * The login form. Served on `GET /admin/dashboard` whenever the request carries
 * no valid session — the one admin path that answers without a credential,
 * because a browser cannot present one on a navigation.
 *
 * It is byte-identical whether or not `ADMIN_TOKEN` is set, so it still tells a
 * prober nothing about the deployment, and it holds no data of its own. The
 * token goes out in a POST body, never a query string: a URL reaches browser
 * history, `Referer`, and every access log in front of the Worker.
 */
export function loginHtml(failed: boolean): string {
  return String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>ghar runners</title>
<style>
:root { --bg: #f7f7f8; --panel: #fff; --line: #e3e3e6; --fg: #16161a; --dim: #6b6b76; --warn: #b91c1c; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #0f0f11; --panel: #17171a; --line: #2a2a30; --fg: #ececed; --dim: #9a9aa4; --warn: #f87171; }
}
* { box-sizing: border-box; }
body {
  margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 20px;
  background: var(--bg); color: var(--fg);
  font: 14px/1.5 ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
}
form { background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
       padding: 24px; width: 100%; max-width: 340px; }
h1 { font-size: 17px; margin: 0 0 4px; font-weight: 600; }
p { color: var(--dim); margin: 0 0 16px; font-size: 13px; }
p.err { color: var(--warn); }
label { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: .05em;
        color: var(--dim); font-weight: 600; margin-bottom: 6px; }
input, button { width: 100%; font: inherit; border-radius: 7px; padding: 9px 11px;
                border: 1px solid var(--line); background: var(--bg); color: var(--fg); }
button { margin-top: 12px; background: var(--fg); color: var(--bg); border-color: var(--fg);
         font-weight: 600; cursor: pointer; }
</style>
</head>
<body>
<form method="post" action="/admin/dashboard/login">
  <h1>ghar runners</h1>
  <p${failed ? ` class="err"` : ""}>${
    failed ? "That token was not accepted." : "Sign in with the admin token."
  }</p>
  <label for="token">Admin token</label>
  <input id="token" name="token" type="password" autocomplete="current-password" autofocus>
  <button type="submit">Sign in</button>
</form>
</body>
</html>`;
}
