#!/usr/bin/env bash
# Poll for the most recent workflow run of WORKFLOW on BRANCH in REPO and
# wait for it to reach a terminal state. Writes `conclusion=...` to
# $GITHUB_OUTPUT (when running under Actions) and prints the conclusion
# on stdout. Exits non-zero if the run failed or didn't complete in time.
#
# Used by .github/workflows/e2e.yml. Internal to the e2e harness — adopters
# don't reference this. Replaces the .github/actions/wait-run composite.
#
# When SINCE_RUN_ID is set, runs with databaseId <= SINCE_RUN_ID are
# ignored. Use this to skip stale runs from earlier e2e steps (e.g. the
# pin step's on-push runs that fire before fixtures begin).
#
# Usage: REPO=owner/name WORKFLOW=on-pr.yml BRANCH=feature/x \
#        TIMEOUT=600 GH_TOKEN=... [SINCE_RUN_ID=...] wait-run.sh

set -euo pipefail

: "${REPO:?REPO is required}"
: "${WORKFLOW:?WORKFLOW is required}"
: "${BRANCH:?BRANCH is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${TIMEOUT:=600}"
: "${SINCE_RUN_ID:=0}"

# gh's --branch flag (and the underlying actions/runs ?branch= API param)
# returns empty for short-lived branches and recently force-rewritten refs
# even when matching runs exist. Post-filter on headBranch instead
# (learning #7). Also drop runs with databaseId <= SINCE_RUN_ID so we don't
# pick up stale runs from earlier e2e steps.
get_row() {
  gh run list --repo "$REPO" --workflow "$WORKFLOW" --limit 50 \
    --json databaseId,headBranch,status,conclusion \
    --jq "[.[] | select(.headBranch == \"$BRANCH\") | select(.databaseId > ${SINCE_RUN_ID})] | .[0] // empty"
}

# Give the trigger a moment to register as a run before polling.
sleep 5

deadline=$((SECONDS + TIMEOUT))
row=""

while (( SECONDS < deadline )); do
  row=$(get_row)
  [[ -n "$row" ]] && break
  sleep 3
done

if [[ -z "$row" ]]; then
  echo "::error::no run found for $WORKFLOW on $BRANCH in $REPO after ${TIMEOUT}s"
  exit 1
fi

while (( SECONDS < deadline )); do
  row=$(get_row)
  status=$(jq -r '.status' <<<"$row")
  concl=$(jq -r '.conclusion' <<<"$row")
  if [[ "$status" == "completed" ]]; then
    echo "$concl"
    if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
      echo "conclusion=$concl" >> "$GITHUB_OUTPUT"
    fi
    [[ "$concl" == "success" ]] && exit 0 || exit 1
  fi
  sleep 5
done

echo "::error::$WORKFLOW on $BRANCH did not complete within ${TIMEOUT}s"
exit 1
