#!/usr/bin/env bash
# scripts/publish-draft-release.sh
#
# Publishes the GitHub Release attached to a given tag, flipping it from
# draft to public. Run as the final step of release-gate.yml after a green
# e2e suite confirms the tagged SHA. Idempotent: if the release for the tag
# is already published the script reports that and exits 0.
#
# Extracted into a script (rather than inline `gh` calls in YAML) so the
# tag/SHA mismatch checks and the "already published" idempotency branch
# are unit-tested (tests/publish-draft-release.test.ts) — process-halting
# code that gates whether a release reaches adopters is not too small to
# test (#211 lessons, per project memory feedback_no_critical_code_too_small_to_test).
#
# Required env:
#   GITHUB_TOKEN  Installation token scoped to point-source/flywheel with
#                 contents:write. The main FLYWHEEL_GH_APP_ID's token is
#                 used in production (same scope as flywheel-push.yml).
#   GITHUB_REPOSITORY  owner/name of the repo (provided by GitHub Actions).
#   TAG_NAME      Production version tag the release-gate workflow gated.
#                 The release attached to this tag is the one published.
#   EXPECTED_SHA  (optional) The SHA the gate ran e2e against. When set,
#                 the script verifies the release's target_commitish (or
#                 the tag's commit) matches before publishing. Defends
#                 against the (vanishingly rare) case where the release
#                 object got recreated against a different SHA between
#                 the gate run and the publish.
#
# Exits 0 on a successful publish, on an already-published no-op, or on
# a tag that has no associated release (the latter logs a notice). Exits
# non-zero on API failures or SHA-mismatch.

set -euo pipefail

: "${GITHUB_TOKEN:?GITHUB_TOKEN must be set}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must be set}"
: "${TAG_NAME:?TAG_NAME must be set}"

# gh respects GH_TOKEN over GITHUB_TOKEN; export the same value under both
# names so callers can set either. The workflow exports GITHUB_TOKEN to
# match the rest of the repo's workflows.
export GH_TOKEN="${GH_TOKEN:-$GITHUB_TOKEN}"

api_path="/repos/${GITHUB_REPOSITORY}/releases/tags/${TAG_NAME}"

# Look up the release by tag. `gh api` exits non-zero on HTTP 404, which
# we want to handle as a benign "nothing to publish" rather than a hard
# failure — a tag can exist with no release attached if semantic-release
# was skipped or a manual tag was pushed.
release_json="$(gh api "$api_path" 2>/dev/null || true)"

if [[ -z "$release_json" ]]; then
  echo "::notice::No release found for tag '$TAG_NAME' — nothing to publish."
  exit 0
fi

release_id="$(printf '%s' "$release_json" | jq -r '.id')"
is_draft="$(printf '%s' "$release_json" | jq -r '.draft')"
release_sha="$(printf '%s' "$release_json" | jq -r '.target_commitish')"

if [[ -z "$release_id" || "$release_id" == "null" ]]; then
  echo "::error::Release lookup for tag '$TAG_NAME' returned no id."
  exit 1
fi

if [[ "$is_draft" != "true" ]]; then
  # Already published — re-running the gate on the same tag is a no-op,
  # as documented in §spec:release-gate's Red-candidate behavior.
  echo "Release for tag '$TAG_NAME' is already published (id=${release_id}). No-op."
  exit 0
fi

# Optional SHA-pin: when the caller passes the SHA the gate's e2e ran
# against, refuse to publish if the release was retargeted in the
# meantime. The release-gate workflow checks out the tag, so the value
# of github.sha there is the tag's commit; passing it here closes the
# (rare) race where the release object's target_commitish changes
# between the gate's checkout and this step.
if [[ -n "${EXPECTED_SHA:-}" ]]; then
  if [[ "$release_sha" != "$EXPECTED_SHA" ]]; then
    echo "::error::Release target_commitish ($release_sha) does not match expected SHA ($EXPECTED_SHA) — refusing to publish."
    exit 1
  fi
fi

echo "Publishing release id=${release_id} for tag '$TAG_NAME' (target ${release_sha})…"
gh api --method PATCH "/repos/${GITHUB_REPOSITORY}/releases/${release_id}" \
  -F draft=false \
  >/dev/null
echo "Published."
