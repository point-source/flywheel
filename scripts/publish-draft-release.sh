#!/usr/bin/env bash
# scripts/publish-draft-release.sh
#
# Publishes the GitHub Release attached to a given tag, flipping it from
# draft to public. Run as the final step of release-gate.yml after a green
# e2e suite confirms the tagged SHA. Idempotent: if the release for the tag
# is already published the script reports that and exits 0.
#
# Lookup: lists releases via GET /repos/{owner}/{repo}/releases and filters
# by tag_name. The list endpoint returns DRAFT releases to a push-access
# token (the production FLYWHEEL_GH_APP_ID token has push access), whereas
# the "get release by tag" endpoint 404s on drafts — the first green run's
# release is always still a draft, so the tag endpoint can never find it.
# Lookup errors fail LOUDLY: a gh error or a malformed/unparseable response
# is a non-zero exit with a ::error:: line, never a silent "nothing to
# publish". The ONLY benign no-op is a successful list that genuinely
# contains no release for the tag.
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
#                 the script resolves the tag REFERENCE to its commit via
#                 the git refs API and verifies that resolved commit matches
#                 before publishing. Defends against the (vanishingly rare)
#                 case where the tag got retargeted at a different commit
#                 between the gate run and the publish.
#                 NOTE: the release object's target_commitish is NOT used
#                 for this check — @semantic-release/github records it as
#                 the branch the release was cut from (e.g. "main"), never
#                 a commit identifier, so it can never equal a 40-char SHA
#                 and a target_commitish comparison would refuse every
#                 green release. The identity check therefore resolves the
#                 tag ref to its underlying commit instead (see #224).
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

api_path="/repos/${GITHUB_REPOSITORY}/releases"

# List releases (this endpoint returns drafts to a push-access token,
# unlike the "get release by tag" endpoint which 404s on drafts). Capture
# the exit code explicitly — NO `|| true`: a gh error must surface loudly,
# because that is exactly the failure shape that silently stranded every
# gated production release as an unpublished draft. On a gh error the error
# JSON arrives on stdout and is captured into $releases_json; surfacing it
# in the ::error:: line is intentional.
if ! releases_json="$(gh api "$api_path")"; then
  echo "::error::Failed to list releases for tag '$TAG_NAME' from $api_path — gh exited non-zero. Response: $releases_json"
  exit 1
fi

# Select the release whose tag_name EXACTLY matches $TAG_NAME (by tag_name,
# not by list position). Distinguish a jq PARSE failure (malformed /
# non-array response → loud failure) from a successful-but-no-match result
# (genuine absence → benign no-op below).
if ! release_json="$(printf '%s' "$releases_json" | jq -c --arg tag "$TAG_NAME" 'map(select(.tag_name == $tag)) | first // empty')"; then
  echo "::error::Could not parse releases response for tag '$TAG_NAME' (malformed API response) — refusing to treat as 'no release'."
  exit 1
fi

# The ONLY benign no-op: a successful lookup that genuinely contains no
# release for the tag (a tag can exist with no release attached if
# semantic-release was skipped or a manual tag was pushed).
if [[ -z "$release_json" ]]; then
  echo "::notice::No release found for tag '$TAG_NAME' — nothing to publish."
  exit 0
fi

release_id="$(printf '%s' "$release_json" | jq -r '.id')"
is_draft="$(printf '%s' "$release_json" | jq -r '.draft')"
# Captured purely for the human-facing log line below — this is the branch
# the release was cut from (e.g. "main"), NOT a commit identifier, and is
# never used for the SHA-pin identity check (see #224).
release_target="$(printf '%s' "$release_json" | jq -r '.target_commitish')"

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
# against, refuse to publish if the tag was retargeted in the meantime.
# The release-gate workflow checks out the tag, so the value of github.sha
# there is the tag's commit; passing it here closes the (rare) race where
# the tag is moved to a different commit between the gate's checkout and
# this step.
#
# We resolve the tag REFERENCE to its underlying commit rather than reading
# the release's target_commitish: @semantic-release/github records
# target_commitish as the branch the release was cut from (e.g. "main"),
# never a commit SHA, so a target_commitish comparison can never match a
# 40-char SHA and would refuse every green release (#224). Resolution
# follows the git refs API: the tag ref points at either a commit
# (lightweight tag) or an annotated tag object that must be dereferenced.
# Every resolution failure is loud (::error:: + non-zero), never a silent
# skip — an unverifiable tag must not publish.
if [[ -n "${EXPECTED_SHA:-}" ]]; then
  ref_path="/repos/${GITHUB_REPOSITORY}/git/ref/tags/${TAG_NAME}"
  if ! ref_json="$(gh api "$ref_path")"; then
    echo "::error::Could not resolve tag ref '$TAG_NAME' ($ref_path) — gh exited non-zero. Refusing to publish. Response: $ref_json"
    exit 1
  fi

  # jq -er fails (non-zero) on a null/missing field, so an unparseable or
  # malformed ref response is treated as a loud failure, not a match.
  if ! ref_type="$(printf '%s' "$ref_json" | jq -er '.object.type')"; then
    echo "::error::Tag ref '$TAG_NAME' returned an unparseable response (no .object.type) — refusing to publish."
    exit 1
  fi
  if ! ref_sha="$(printf '%s' "$ref_json" | jq -er '.object.sha')"; then
    echo "::error::Tag ref '$TAG_NAME' returned an unparseable response (no .object.sha) — refusing to publish."
    exit 1
  fi

  if [[ "$ref_type" == "commit" ]]; then
    # Lightweight tag: the ref's object IS the commit.
    resolved_sha="$ref_sha"
  elif [[ "$ref_type" == "tag" ]]; then
    # Annotated tag: dereference the tag object to the commit it points at.
    tag_path="/repos/${GITHUB_REPOSITORY}/git/tags/${ref_sha}"
    if ! tag_json="$(gh api "$tag_path")"; then
      echo "::error::Could not dereference annotated tag object for '$TAG_NAME' ($tag_path) — gh exited non-zero. Refusing to publish. Response: $tag_json"
      exit 1
    fi
    if ! deref_type="$(printf '%s' "$tag_json" | jq -er '.object.type')"; then
      echo "::error::Annotated tag object for '$TAG_NAME' returned an unparseable response (no .object.type) — refusing to publish."
      exit 1
    fi
    if ! deref_sha="$(printf '%s' "$tag_json" | jq -er '.object.sha')"; then
      echo "::error::Annotated tag object for '$TAG_NAME' returned an unparseable response (no .object.sha) — refusing to publish."
      exit 1
    fi
    if [[ "$deref_type" != "commit" ]]; then
      echo "::error::Annotated tag '$TAG_NAME' does not dereference to a commit (got '$deref_type') — refusing to publish."
      exit 1
    fi
    resolved_sha="$deref_sha"
  else
    echo "::error::Tag ref '$TAG_NAME' points at an unexpected object type '$ref_type' (not commit or tag) — refusing to publish."
    exit 1
  fi

  if [[ "$resolved_sha" != "$EXPECTED_SHA" ]]; then
    echo "::error::Tag '$TAG_NAME' resolves to commit $resolved_sha, which does not match expected SHA ($EXPECTED_SHA) — refusing to publish."
    exit 1
  fi
fi

echo "Publishing release id=${release_id} for tag '$TAG_NAME' (target ${release_target})…"
# A publish failure is loud, like the lookup failures above: surface an
# ::error:: line so a maintainer reading CI can tell the green release did
# not reach adopters, rather than relying on set -e's bare non-zero exit.
if ! gh api --method PATCH "/repos/${GITHUB_REPOSITORY}/releases/${release_id}" \
  -F draft=false \
  >/dev/null; then
  echo "::error::Failed to publish release id=${release_id} for tag '$TAG_NAME' — the PATCH (draft=false) call returned non-zero."
  exit 1
fi
echo "Published."
