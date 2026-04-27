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

# Give the trigger a moment to register as a run before we start polling.
sleep 5

deadline=$((SECONDS + timeout))
run_id=""

while (( SECONDS < deadline )); do
  run_id=$(gh run list --repo "$repo" --workflow "$workflow" --branch "$branch" \
             --limit 1 --json databaseId,status,conclusion \
             --jq '.[0] // empty')
  [[ -n "$run_id" ]] && break
  sleep 3
done

if [[ -z "$run_id" ]]; then
  echo "::error::no run found for $workflow on $branch in $repo after ${timeout}s"
  exit 1
fi

while (( SECONDS < deadline )); do
  row=$(gh run list --repo "$repo" --workflow "$workflow" --branch "$branch" \
          --limit 1 --json status,conclusion,databaseId --jq '.[0]')
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
