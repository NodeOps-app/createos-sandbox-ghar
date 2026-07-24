# Onboarding a new tenant — step by step

Multi-tenant is **live** (`TENANCY_MODE=multi`). One public App
(`createos-runners`), install-gated: any GitHub org can **install** it, but only
registry-**approved** tenants get runners. Unapproved installs get one neutral
check run pointing at `APPLY_FORM_URL`. See ADR
[0006](../adr/0006-one-app-public-install-gated.md) and
[0005](../adr/0005-single-do-multi-tenancy.md).

Two actors: the **applicant** (the org that wants runners) and the **operator**
(you — holds `ADMIN_TOKEN`, runs the admin endpoints). Worker URL below is
`https://createos-sandbox-ghar.hello-927.workers.dev`.

---

## Part A — what the applicant does (GitHub only)

1. **Apply** via the form (`APPLY_FORM_URL`). Fields per
   [`onboarding-form.md`](./onboarding-form.md).
2. **Install the public App** on their org: GitHub → the App's public page →
   **Install** → choose their org → **Only select repositories** → pick the
   repos they want to run CI on. (Selecting repos here is the GitHub-side
   boundary; the runner group we create is scoped to the same set.)
3. **Send the operator:** their org login + the list of repo names they
   selected. (They do NOT need to find the installation id — the operator reads
   it.)

That's it for the applicant until approval. After approval they change one line
per workflow:

```yaml
runs-on: ubuntu-latest   # before
runs-on: createos        # after  (or a shaped label within their ceiling)
```

---

## Part B — what the operator does (admin endpoints)

Export once (token from the vault — never commit it):

```bash
export ADMIN_TOKEN='<from vault>'
export WORKER='https://createos-sandbox-ghar.hello-927.workers.dev'
export ORG='<applicant-org-login>'          # e.g. acme-inc
```

### Step 1 — get their installation id

They just installed the App on their org. Read the install id for the
`createos-runners` App (`app_id` 4222926):

```bash
gh api orgs/$ORG/installations \
  --jq '.installations[] | select(.app_id==4222926) | .id'
# → e.g. 555000111   (call this $INSTALL_ID)
export INSTALL_ID=<number above>
```

### Step 2 — collect the repo ids they selected

Repo ids (not names) go into the runner group. For each repo:

```bash
gh api repos/$ORG/<repo> --jq '.id'        # one number per repo
```

### Step 3 — create the tenant as `pending`

Full-record upsert — **every field required**, nullable fields explicit `null`.
`runner_group_id: null` for a scoped tenant (it is auto-created at approval).
Size `minute_grant` / `concurrency_cap` / `max_shape` / `job_ttl_ms` from the
application.

```bash
curl -sf -X POST $WORKER/admin/tenants \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{
    "installation_id": '$INSTALL_ID',
    "org_login": "'$ORG'",
    "status": "pending",
    "allow_all_repos": false,
    "minute_grant": 20000,
    "concurrency_cap": 5,
    "max_shape": "s-4vcpu-8gb",
    "job_ttl_ms": 1800000,
    "runner_group_id": null,
    "contact": null,
    "notes": "community tenant — <name / form ref>",
    "approved_by": null
  }'
```

### Step 4 — approve their repos (projects)

`repo_id` from Step 2, one object per repo:

```bash
curl -sf -X POST $WORKER/admin/projects \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{
    "installation_id": '$INSTALL_ID',
    "projects": [
      { "repo_full_name": "'$ORG'/repo-one", "repo_id": 111111111 },
      { "repo_full_name": "'$ORG'/repo-two", "repo_id": 222222222 }
    ]
  }'
```

### Step 5 — approve the tenant (creates the scoped runner group)

Re-POST the same record with `status: "approved"` + `approved_by`. The worker
auto-creates a GitHub runner group named `createos` scoped to exactly the repos
from Step 4 and stores its id. **Fail-closed:** a `502` here means a GitHub-side
problem — fix it and retry; the tenant stays unapproved, never falls back to the
org-wide Default group.

```bash
curl -sf -X POST $WORKER/admin/tenants \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{
    "installation_id": '$INSTALL_ID',
    "org_login": "'$ORG'",
    "status": "approved",
    "allow_all_repos": false,
    "minute_grant": 20000,
    "concurrency_cap": 5,
    "max_shape": "s-4vcpu-8gb",
    "job_ttl_ms": 1800000,
    "runner_group_id": null,
    "contact": null,
    "notes": "community tenant — <name / form ref>",
    "approved_by": "pratik"
  }'
# response now carries runnerGroupId: <auto-created id>
```

### Step 6 — verify

```bash
curl -sf "$WORKER/admin/tenants?id=$INSTALL_ID" -H "Authorization: Bearer $ADMIN_TOKEN"
# expect: status "approved", approvedAt stamped, runnerGroupId set
```

Then tell the applicant to switch `runs-on:` (Part A, last step).

---

## Part C — verify the gates fire (first tenant, do once)

- **Non-approved repo job** in their org → 202 + ONE neutral check run
  ("not approved, apply here"), no VM.
- **Approved-repo job** → VM boots under their `createos` runner group (org →
  Settings → Actions → Runner groups), runs green, self-deletes.
- **Egress cap (D15):** a community (non-`allow_all_repos`) VM is created with
  `bandwidth_quota_bytes` set (100 GB default). Confirm on the CreateOS
  dashboard / `getBandwidth` — this is the live check that proves the control
  plane honors the field.

---

## Operator quick reference

| Action | Endpoint | Notes |
|---|---|---|
| List tenants | `GET /admin/tenants` | |
| Get one tenant | `GET /admin/tenants?id=<install_id>` | |
| Create/replace tenant | `POST /admin/tenants` | full-record upsert; auto-creates runner group on approve |
| Change status only | `POST /admin/tenants/status` | `pending`/`suspended`/`revoked` (NOT `approved`) |
| Add repos | `POST /admin/projects` | syncs runner group wider |
| Remove repo | `DELETE /admin/projects` | syncs runner group narrower |
| Claim pre-tenant rows | `POST /admin/backfill` | one-time at cutover |

Suspend a tenant (stop new admissions, keep history):

```bash
curl -sf -X POST $WORKER/admin/tenants/status \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"installation_id": '$INSTALL_ID', "status": "suspended"}'
```
