#!/usr/bin/env bash
# Poll a PR until it is merged (or the timeout expires). Used by the e2e
# harness to validate that auto-merge actually fires after pr-lifecycle
# enables it — the PR being open + checks-green isn't a sufficient signal.
#
# On success, exits 0 and prints the merge SHA. On failure, dumps the PR's
# mergeable state + most recent check_runs (handy for diagnosing why a
# PR with all-green checks stayed `blocked`) and exits 1.
#
# Usage: REPO=owner/name PR=42 TIMEOUT=600 GH_TOKEN=... wait-merged.sh

set -euo pipefail

: "${REPO:?REPO is required}"
: "${PR:?PR is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${TIMEOUT:=600}"

deadline=$((SECONDS + TIMEOUT))

while (( SECONDS < deadline )); do
  # `gh pr view` exposes mergedAt/mergeCommit/state — there is no `.merged`
  # boolean. PR is "merged" iff mergedAt is non-null; "closed without
  # merging" iff state==CLOSED and mergedAt is null.
  row=$(gh pr view --repo "$REPO" "$PR" \
          --json state,mergedAt,mergeStateStatus,mergeable,mergeCommit)
  merged_at=$(jq -r '.mergedAt' <<<"$row")
  state=$(jq -r '.state' <<<"$row")
  if [[ "$merged_at" != "null" && -n "$merged_at" ]]; then
    sha=$(jq -r '.mergeCommit.oid' <<<"$row")
    echo "merged at $sha"
    if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
      echo "merge_sha=$sha" >> "$GITHUB_OUTPUT"
    fi
    exit 0
  fi
  if [[ "$state" == "CLOSED" ]]; then
    echo "::error::PR #$PR closed without merging"
    echo "$row"
    exit 1
  fi
  sleep 5
done

echo "::error::PR #$PR did not merge within ${TIMEOUT}s"
gh pr view --repo "$REPO" "$PR" \
  --json number,state,merged,mergeable,mergeStateStatus,reviewDecision,headRefOid
head_sha=$(gh pr view --repo "$REPO" "$PR" --json headRefOid --jq .headRefOid)
echo "--- check_runs on $head_sha ---"
gh api "repos/$REPO/commits/$head_sha/check-runs" \
  --jq '.check_runs[] | {name, status, conclusion}'
exit 1
