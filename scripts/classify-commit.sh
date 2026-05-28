#!/usr/bin/env bash
# scripts/classify-commit.sh
#
# Classifies the triggering event as a flywheel-produced release/back-merge
# commit and/or the long-lived develop→main promotion PR, writing two boolean
# step outputs to $GITHUB_OUTPUT for a quality workflow to gate on:
#
#   derived_release_commit  'true' when the head commit is a flywheel
#                           release-pipeline commit that carries no new
#                           source and therefore cannot change a quality
#                           suite's verdict — either the
#                           `chore(release): X.Y.Z` version commit (authored
#                           by semantic-release-bot) or the
#                           `chore: back-merge ...` merge commit (authored by
#                           github-actions[bot]). Gating quality jobs on
#                           `!= 'true'` skips the redundant re-run.
#   promotion_pr            'true' when the run is for the long-lived
#                           promotion PR (PR title contains `: promote `).
#
# Backs the point-source/flywheel/classify composite action; exercised by
# tests/classify-commit.test.ts. See §spec:release-ci-budget.
#
# Each prefix is trusted only from the bot that emits it: the
# `chore(release):` ↔ semantic-release-bot and `chore: back-merge` ↔
# github-actions[bot] pairings are flywheel's own pipeline identities. A
# human commit that happens to use one of these prefixes is classified
# non-derived and its CI runs — flywheel never skips a commit it cannot
# positively attribute to its own pipeline.
#
# Required env (all standard GitHub Actions runtime vars):
#   GITHUB_EVENT_NAME   'push' | 'merge_group' | 'pull_request' | ...
#   GITHUB_EVENT_PATH   Path to the event payload JSON.
#   GITHUB_OUTPUT       Path to the step-output file.

set -euo pipefail

: "${GITHUB_EVENT_NAME:?GITHUB_EVENT_NAME must be set}"
: "${GITHUB_EVENT_PATH:?GITHUB_EVENT_PATH must be set}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT must be set}"

# Read the head commit's author name and message for the current trigger.
# push carries it at .head_commit; merge_group at .merge_group.head_commit.
# pull_request payloads carry no commit, so both stay empty and the commit
# never classifies as derived — the promotion-PR signal below uses the title.
# A fast-forward back-merge lands the chore(release) commit directly on the
# upstream branch, so the upstream's push event is handled by the push arm.
author=""
message=""
case "$GITHUB_EVENT_NAME" in
  push)
    author="$(jq -r '.head_commit.author.name // ""' "$GITHUB_EVENT_PATH")"
    message="$(jq -r '.head_commit.message // ""' "$GITHUB_EVENT_PATH")"
    ;;
  merge_group)
    author="$(jq -r '.merge_group.head_commit.author.name // ""' "$GITHUB_EVENT_PATH")"
    message="$(jq -r '.merge_group.head_commit.message // ""' "$GITHUB_EVENT_PATH")"
    ;;
esac

derived_release_commit=false
if [[ "$author" == "semantic-release-bot" && "$message" == "chore(release):"* ]] \
  || [[ "$author" == "github-actions[bot]" && "$message" == "chore: back-merge"* ]]; then
  derived_release_commit=true
fi

promotion_pr=false
if [[ "$GITHUB_EVENT_NAME" == "pull_request" ]]; then
  title="$(jq -r '.pull_request.title // ""' "$GITHUB_EVENT_PATH")"
  if [[ "$title" == *": promote "* ]]; then
    promotion_pr=true
  fi
fi

{
  echo "derived_release_commit=$derived_release_commit"
  echo "promotion_pr=$promotion_pr"
} >> "$GITHUB_OUTPUT"

echo "::notice::classify-commit: derived_release_commit=$derived_release_commit promotion_pr=$promotion_pr"
