#!/usr/bin/env bash
# onboard-tenant.sh — idempotent onboarding of a GitHub org's repos as a tenant.
#
# Usage:
#   ADMIN_TOKEN=xxx ./scripts/onboard-tenant.sh <org> <repo> [more repos...] [options]
#
# Examples:
#   ADMIN_TOKEN=$TOK ./scripts/onboard-tenant.sh acme-inc web-app api
#   ADMIN_TOKEN=$TOK ./scripts/onboard-tenant.sh acme-inc web-app --minute-grant 50000 --concurrency-cap 10
#   # top up / change a limit on an existing tenant (idempotent — other settings kept):
#   ADMIN_TOKEN=$TOK ./scripts/onboard-tenant.sh acme-inc web-app --minute-grant 1000
#
# Idempotency:
#   - tenant does not exist            -> create (pending) -> add repos -> approve
#   - tenant exists, repo missing      -> add that repo (runner group re-converged)
#   - tenant exists, ALL repos present -> no-op, prints "already onboarded"
# Re-running is always safe; the registry + runner group converge to the repo set you pass.
# Limits default to the flags below; on an existing tenant the CURRENT registry
# limits are kept unless you pass a flag to change them.
#
# All credentials come from ENV (never flags, never logged):
#   ADMIN_TOKEN   (required) — worker admin bearer token, from the vault.
#   GH_TOKEN / GITHUB_TOKEN  — used by `gh api` for installation + repo-id lookups.
#   WORKER        (optional) — admin base URL.
#   APP_ID        (optional) — defaults to the createos-runners public App.
# Requires: curl, jq, gh.

set -euo pipefail

WORKER="${WORKER:-https://createos-sandbox-ghar.hello-927.workers.dev}"
APP_ID="${APP_ID:-4222926}"          # createos-runners public App

# ---- defaults (override via flags) ----
MINUTE_GRANT=20000
CONCURRENCY_CAP=5
MAX_SHAPE="s-4vcpu-8gb"
JOB_TTL_MS=1800000
ALLOW_ALL_REPOS=false
AUTO_APPROVE=true
NOTES=""
APPROVED_BY="${APPROVED_BY:-$(gh api user --jq .login 2>/dev/null || echo operator)}"
# track which limit flags were explicitly passed (so we don't clobber an existing tenant's settings)
SET_GRANT=""; SET_CAP=""; SET_SHAPE=""; SET_TTL=""

die() { echo "error: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing dependency: $1"; }
need curl; need jq; need gh
[ -n "${ADMIN_TOKEN:-}" ] || die "ADMIN_TOKEN env not set (from the vault)"

# ---- parse args ----
ORG=""; REPOS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --minute-grant) MINUTE_GRANT="$2"; SET_GRANT=1; shift 2;;
    --concurrency-cap) CONCURRENCY_CAP="$2"; SET_CAP=1; shift 2;;
    --max-shape) MAX_SHAPE="$2"; SET_SHAPE=1; shift 2;;
    --job-ttl-ms) JOB_TTL_MS="$2"; SET_TTL=1; shift 2;;
    --allow-all-repos) ALLOW_ALL_REPOS=true; shift;;
    --no-approve) AUTO_APPROVE=false; shift;;
    --notes) NOTES="$2"; shift 2;;
    --approved-by) APPROVED_BY="$2"; shift 2;;
    -h|--help) sed -n '1,22p' "$0"; exit 0;;
    -*) die "unknown flag: $1";;
    *) if [ -z "$ORG" ]; then ORG="$1"; else REPOS+=("$1"); fi; shift;;
  esac
done
[ -n "$ORG" ] || die "org required (first positional arg)"
[ ${#REPOS[@]} -gt 0 ] || [ "$ALLOW_ALL_REPOS" = true ] || die "at least one repo required (or --allow-all-repos)"

# ---- api helper ----
api() { # method path [json]
  local method="$1" path="$2" body="${3:-}"
  local args=(-sf -m 20 -X "$method" "$WORKER$path" -H "Authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json")
  [ -n "$body" ] && args+=(-d "$body")
  curl "${args[@]}"
}

echo "== org: $ORG =="

# ---- Step 1: installation id for the App on this org ----
INSTALL_ID=$(gh api "orgs/$ORG/installations" --jq ".installations[] | select(.app_id==$APP_ID) | .id" 2>/dev/null || true)
[ -n "$INSTALL_ID" ] || die "no createos-runners App (app_id $APP_ID) installation found on org '$ORG'. Applicant must install the public App first (Part A of docs/community/onboard-tenant.md)."
echo "installation_id: $INSTALL_ID"

# ---- Step 2: current state (idempotency read) ----
# GET /admin/tenants?id=X -> {tenant:{...}, projects:[...]} or 404. 404 = not onboarded.
HTTP=$(curl -s -m 20 -o /tmp/.ot_resp -w "%{http_code}" "$WORKER/admin/tenants?id=$INSTALL_ID" -H "Authorization: Bearer $ADMIN_TOKEN")
RESP=$(cat /tmp/.ot_resp); rm -f /tmp/.ot_resp

if [ "$HTTP" = "200" ]; then
  T=$(echo "$RESP" | jq '.tenant')
  CUR_PROJECTS=$(echo "$RESP" | jq -r '.projects[].repoFullName' 2>/dev/null | sort)
  CUR_STATUS=$(echo "$T" | jq -r '.status')
  echo "tenant exists: status=$CUR_STATUS grant=$(echo "$T"|jq .minuteGrant) cap=$(echo "$T"|jq .concurrencyCap) shape=$(echo "$T"|jq -r .maxShape) allowAllRepos=$(echo "$T"|jq .allowAllRepos)"
  # adopt current settings unless the flag was explicitly passed
  [ -z "$SET_GRANT" ] && MINUTE_GRANT=$(echo "$T" | jq .minuteGrant)
  [ -z "$SET_CAP" ]   && CONCURRENCY_CAP=$(echo "$T" | jq .concurrencyCap)
  [ -z "$SET_SHAPE" ] && MAX_SHAPE=$(echo "$T" | jq -r .maxShape)
  [ -z "$SET_TTL" ]   && JOB_TTL_MS=$(echo "$T" | jq .jobTtlMs)
  ALLOW_ALL_REPOS=$(echo "$T" | jq .allowAllRepos)
  [ -z "$NOTES" ] && NOTES=$(echo "$T" | jq -r '.notes // ""')
  CUR_GROUP=$(echo "$T" | jq -r '.runnerGroupId // empty')
elif [ "$HTTP" = "404" ]; then
  echo "tenant does not exist — will create"
  CUR_STATUS=""; CUR_GROUP=""; CUR_PROJECTS=""
else
  die "admin read failed (HTTP $HTTP): $RESP"
fi

# ---- Step 3: build the full desired project set with repo ids ----
# No per-tenant projects READ endpoint, so we always send the FULL desired set;
# addProjects upserts (ON CONFLICT) and the runner group re-converges to it.
PROJECTS="[]"
for r in "${REPOS[@]}"; do
  full="$ORG/$r"
  rid=$(gh api "repos/$full" --jq .id 2>/dev/null) || die "repo not found or no access: $full"
  [ -n "$rid" ] || die "could not resolve repo id for $full"
  PROJECTS=$(echo "$PROJECTS" | jq --arg f "$full" --argjson i "$rid" '. + [{repo_full_name:$f, repo_id:$i}]')
done
REPO_COUNT=$(echo "$PROJECTS" | jq 'length')
echo "desired repos ($REPO_COUNT): $(echo "$PROJECTS" | jq -r '.[].repo_full_name' | paste -sd, -)"

# true idempotency: which desired repos are already onboarded vs new
if [ -n "${CUR_PROJECTS:-}" ]; then
  ALREADY=$(comm -12 <(echo "$PROJECTS" | jq -r '.[].repo_full_name' | sort) <(echo "$CUR_PROJECTS") | paste -sd, -)
  NEW_REPOS=$(comm -23 <(echo "$PROJECTS" | jq -r '.[].repo_full_name' | sort) <(echo "$CUR_PROJECTS") | paste -sd, -)
  [ -n "$ALREADY" ] && echo "already onboarded: $ALREADY"
  [ -n "$NEW_REPOS" ] && echo "new repos to add: $NEW_REPOS"
  [ -z "$NEW_REPOS" ] && echo "(all requested repos already present)"
fi

# ---- Step 4: decide status + write tenant ----
# --no-approve must never flip an already-approved/suspended tenant; it only
# holds a NEW tenant at pending. Default (auto-approve) approves everything.
if [ "$AUTO_APPROVE" = true ]; then
  DESIRED_STATUS="approved"
else
  DESIRED_STATUS="${CUR_STATUS:-pending}"
fi

GROUP_FIELD="null"
[ "$ALLOW_ALL_REPOS" = true ] && GROUP_FIELD="${CUR_GROUP:-1}"

mk_body() { # status -> tenant upsert json
  jq -n \
    --argjson iid "$INSTALL_ID" --arg org "$ORG" --arg st "$1" \
    --argjson aar "$ALLOW_ALL_REPOS" --argjson mg "$MINUTE_GRANT" --argjson cc "$CONCURRENCY_CAP" \
    --arg ms "$MAX_SHAPE" --argjson ttl "$JOB_TTL_MS" --argjson rg "$GROUP_FIELD" \
    --arg notes "$NOTES" --arg by "$APPROVED_BY" \
    '{installation_id:$iid, org_login:$org, status:$st, allow_all_repos:$aar,
      minute_grant:$mg, concurrency_cap:$cc, max_shape:$ms, job_ttl_ms:$ttl,
      runner_group_id:$rg, contact:null, notes:$notes,
      approved_by:(if $st=="approved" then $by else null end)}'
}

# ---- Step 5: scoped approval needs projects FIRST (fail-closed runner group) ----
if [ "$ALLOW_ALL_REPOS" != true ]; then
  # Write pending-first ONLY when the tenant is NOT already approved: the
  # approval gate needs projects in place before the pending->approved write
  # that creates the runner group. For an already-approved tenant the group
  # exists, and a pending->approved re-write would re-stamp approver + timestamp
  # (clobbering the audit trail) on what is really just a limit/repo update.
  if [ "$DESIRED_STATUS" = "approved" ] && [ "$CUR_STATUS" != "approved" ]; then
    echo "writing tenant as pending first (approval gate)…"
    api POST /admin/tenants "$(mk_body pending)" >/dev/null
  fi
  ADD_BODY=$(jq -n --argjson iid "$INSTALL_ID" --argjson p "$PROJECTS" '{installation_id:$iid, projects:$p}')
  api POST /admin/projects "$ADD_BODY" >/dev/null
  echo "projects converged ($REPO_COUNT)"
fi

# ---- Step 6: final write (approve auto-creates/converges the scoped runner group) ----
RESP=$(api POST /admin/tenants "$(mk_body "$DESIRED_STATUS")")
NEW_GROUP=$(echo "$RESP" | jq -r '.runnerGroupId // empty')
[ "$DESIRED_STATUS" = "approved" ] && echo "approved. runner_group_id=${NEW_GROUP:-$GROUP_FIELD}" || echo "tenant written with status=$DESIRED_STATUS (--no-approve)"

# ---- Step 7: report ----
echo "== final =="
api GET "/admin/tenants?id=$INSTALL_ID" | jq '.tenant | {orgLogin, status, minuteGrant, concurrencyCap, maxShape, jobTtlMs, allowAllRepos, runnerGroupId, approvedBy}'
api GET "/admin/tenants?id=$INSTALL_ID" | jq '{projects: [.projects[].repoFullName]}'
echo "done: $ORG ($REPO_COUNT repos)"
