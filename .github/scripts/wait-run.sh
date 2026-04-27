#!/usr/bin/env bash
# Poll for the most recent workflow run of $workflow on $branch in $repo
# to reach a terminal state. Exit 0 on success, non-zero otherwise.
#
# Usage: wait-run.sh <owner/repo> <workflow-file> <branch> [timeout-seconds]
#
# Intended to be invoked from .github/workflows/e2e.yml.

set -euo pipefail

repo="${1:?repo required}"
workflow="${2:?workflow file required}"
branch="${3:?branch required}"
timeout="${4:-600}"

# gh's --branch filter (and the underlying actions/runs ?branch= API param)
# returns empty for short-lived branches and recently force-rewritten refs,
# even when matching runs exist. Post-filter on headBranch instead.
get_row() {
  gh run list --repo "$repo" --workflow "$workflow" --limit 50 \
    --json databaseId,headBranch,status,conclusion \
    --jq "[.[] | select(.headBranch == \"$branch\")] | .[0] // empty"
}

# Give the trigger a moment to register as a run before we start polling.
sleep 5

deadline=$((SECONDS + timeout))
row=""

while (( SECONDS < deadline )); do
  row=$(get_row)
  [[ -n "$row" ]] && break
  sleep 3
done

if [[ -z "$row" ]]; then
  echo "::error::no run found for $workflow on $branch in $repo after ${timeout}s"
  exit 1
fi

while (( SECONDS < deadline )); do
  row=$(get_row)
  status=$(jq -r '.status'     <<<"$row")
  concl=$( jq -r '.conclusion' <<<"$row")
  if [[ "$status" == "completed" ]]; then
    echo "run concluded: $concl"
    [[ "$concl" == "success" ]] && exit 0 || exit 1
  fi
  sleep 5
done

echo "::error::$workflow on $branch did not complete within ${timeout}s"
exit 1
