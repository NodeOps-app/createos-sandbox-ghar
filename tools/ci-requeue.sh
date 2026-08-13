#!/usr/bin/env bash
# Org-wide GitHub Actions triage after an infra change on the runner side
# (e.g. rotated CREATEOS_API_KEY, GitHub App key, or any change that only
# affects *new* runner provisioning). Finds runs stuck `queued` — a job
# whose runner never got claimed — and optionally cancels + reruns them so
# they retry against the fixed config.
#
# Runs that already reached `failure` are also listable for triage, but do
# NOT assume they're related: check the job log first (`gh run view <id>
# --log-failed`). A provisioning problem shows an empty/absent runner_name
# on the job; anything else (lockfile drift, a real test failure, ...) will
# just fail again identically on rerun.
#
# Usage:
#   tools/ci-requeue.sh [--org ORG] [--minutes N] [--status queued|failed|all] [--apply]
#
# Defaults: --org NodeOps-app --minutes 30 --status queued --apply is OFF (list-only)
#
# Examples:
#   tools/ci-requeue.sh                          # list runs stuck queued right now
#   tools/ci-requeue.sh --apply                   # cancel + rerun runs stuck queued
#   tools/ci-requeue.sh --status failed           # list failures from the last 30 min (triage only)
#   tools/ci-requeue.sh --status all --minutes 60 --apply

set -uo pipefail
# no `set -e`: gh api 404s (Actions disabled on a repo, etc.) must not abort
# the whole org scan mid-loop — checked in caller-of-this-comment's own
# incident where set -e + an unhandled `repos=$(...)` assignment silently
# stopped the scan after the first uncooperative repo.

ORG="NodeOps-app"
MINUTES=30
STATUS="queued"
APPLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --org) ORG="$2"; shift 2 ;;
    --minutes) MINUTES="$2"; shift 2 ;;
    --status) STATUS="$2"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

case "$STATUS" in queued|failed|all) ;; *) echo "--status must be queued|failed|all" >&2; exit 1 ;; esac

THRESH=$(date -u -v-"${MINUTES}"M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "${MINUTES} minutes ago" +%Y-%m-%dT%H:%M:%SZ)
echo "org=$ORG minutes=$MINUTES status=$STATUS apply=$APPLY threshold=$THRESH" >&2

fetch_queued() {
  gh api "repos/$ORG/$1/actions/runs?status=queued&per_page=30" \
    --jq '.workflow_runs[] | "\(.id)\t\(.name)\t\(.created_at)\t\(.html_url)"' 2>/dev/null
}

fetch_failed() {
  gh api "repos/$ORG/$1/actions/runs?per_page=30" \
    --jq '.workflow_runs[] | select(.created_at > "'"$THRESH"'" and .conclusion == "failure") | "\(.id)\t\(.name)\t\(.created_at)\t\(.html_url)"' 2>/dev/null
}

# NOTE: `for r in $repos` silently iterates once under zsh (no unquoted-var
# word-splitting there, unlike bash) — this script is bash-only (shebang
# above) so that's not live here, but the read-loop form below is kept
# because it's also just more robust to repo names / gh output shape.
gh repo list "$ORG" --limit 200 --json name -q '.[].name' | while IFS= read -r repo; do
  for filter in queued failed; do
    [ "$STATUS" = "all" ] || [ "$STATUS" = "$filter" ] || continue
    runs=$("fetch_${filter}" "$repo") || runs=""
    [ -n "$runs" ] || continue
    echo "=== $repo ($filter) ==="
    echo "$runs"
    [ "$APPLY" = "1" ] || continue
    # `</dev/null` on every gh call: gh reads stdin, and inside a
    # `while read` loop it consumes the rest of $runs — so the loop silently
    # processed only the FIRST run per repo and reported success.
    echo "$runs" | while IFS=$'\t' read -r id name created url; do
      if [ "$filter" = "queued" ]; then
        echo "  cancel+rerun $id ($name)"
        gh run cancel "$id" --repo "$ORG/$repo" </dev/null || true
        # Poll instead of `sleep 2`: rerun is refused with "already running"
        # until the cancel lands, and that refusal is what leaves a stuck run
        # cancelled but never retried.
        for _ in $(seq 1 20); do
          [ "$(gh run view "$id" --repo "$ORG/$repo" --json status --jq .status </dev/null 2>/dev/null)" = "completed" ] && break
          sleep 3
        done
      else
        echo "  rerun $id ($name) [check the failure log first — see header comment]"
      fi
      gh run rerun "$id" --repo "$ORG/$repo" </dev/null || true
    done
  done
done
