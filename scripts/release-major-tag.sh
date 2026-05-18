#!/usr/bin/env bash
# scripts/release-major-tag.sh
#
# Floats the major version tag (e.g. `v1`) onto the release tag a
# `release: published` event just created, so consumers pinning
# `point-source/flywheel@v1` (and `…/.github/workflows/*.yml@v1`) pick
# up every 1.x release without re-pinning.
#
# Run as the "Move floating major tag" step of release-major-tag.yml.
# Extracted from inline YAML in #133 so the tag-name parsing is linted
# and unit-tested (tests/release-major-tag.test.ts) — a slip in the
# regex silently strands every `@v1` consumer on the prior release, or
# floats the major onto a pre-release.
#
# Required env:
#   TAG_NAME   The published release's tag (github.event.release.tag_name).
#
# Tag-name forms:
#   vX.Y.Z              primary stream  → floats `vX`
#   <stream>/vX.Y.Z     scoped stream   → floats `<stream>/vX`
#   anything else — pre-releases (`vX.Y.Z-dev.N`), non-`v` tags, … — is
#   not a stable release line and is skipped with exit 0.
#
# Runs against the current working directory's git repo, which must
# have an `origin` remote and `$TAG_NAME` resolvable to a commit. Exits
# 0 on a successful float or a skipped non-matching tag; non-zero only
# if a git command fails.

set -euo pipefail

: "${TAG_NAME:?TAG_NAME must be set}"

# Accept both "v1.2.3" (primary stream) and "stream-name/v1.2.3" (scoped
# stream). Pre-releases ("v1.2.3-dev.1") deliberately fall through: the
# trailing `$` anchor rejects anything after the patch number, so a
# -dev / -rc suffix never floats the major.
if [[ "$TAG_NAME" =~ ^(.*)v([0-9]+)\.[0-9]+\.[0-9]+$ ]]; then
  prefix="${BASH_REMATCH[1]}"
  major="${prefix}v${BASH_REMATCH[2]}"
else
  echo "::notice::Release tag '$TAG_NAME' is not in vX.Y.Z (or stream/vX.Y.Z) form — skipping major-tag float."
  exit 0
fi

echo "Floating ${major} → ${TAG_NAME}"
git config user.name "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"
git tag -fa "$major" "$TAG_NAME" -m "Float ${major} to ${TAG_NAME}"
git push origin "$major" --force
