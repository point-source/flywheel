#!/usr/bin/env bash
# scripts/sanitize-release-mentions.sh
#
# Wraps any leftover @-prefixed identifiers in the just-published GitHub
# Release body with backticks so GitHub's release-page renderer doesn't
# parse them as user mentions and surface phantom names ("@v1",
# "@semantic-release", …) in the release's Contributors sidebar (#70).
#
# Run as the "Sanitize @-mentions in release body" step of the Flywheel
# push workflow (`flywheel-push.yml` / the reusable `push.yml`), after
# semantic-release has cut the tag + GitHub Release. Extracted from
# inline YAML in #130 so it can be shellchecked and exercised end-to-end
# by `tests/sanitize-release-mentions.test.ts` — the inline form already
# halted the 1.1.1 release flow when `gh release view` 404'd in the
# race window between semantic-release pushing the tag and the
# release-by-tag lookup resolving.
#
# Required env:
#   GITHUB_TOKEN          App installation token with write scope on
#                         `$GITHUB_REPOSITORY`. Used by `gh release
#                         view`/`edit`.
#   GITHUB_REPOSITORY     `<owner>/<repo>`. Required by `gh`.
#
# Optional env (knobs primarily for tests):
#   SANITIZE_MAX_ATTEMPTS Number of `gh release view` attempts before
#                         giving up. Default 5.
#   SANITIZE_INITIAL_DELAY Seconds to sleep before the second attempt;
#                         doubles each retry. Default 2 (5 attempts →
#                         2+4+8+16 = 30s upper bound).
#
# Exits 0 on success or when there's no tag at HEAD (semantic-release
# didn't publish a release). Exits non-zero only if `gh release view`
# fails on every retry — that's a real failure (auth, rate-limit, or a
# release that legitimately doesn't exist) that must surface in the
# workflow run.

set -euo pipefail

: "${GITHUB_TOKEN:?GITHUB_TOKEN must be set}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must be set}"

new_tag="$(git tag --points-at HEAD | head -n1)"
if [[ -z "$new_tag" ]]; then
  echo "::notice::No tag at HEAD — semantic-release did not publish a release. Skipping body sanitize."
  exit 0
fi

# semantic-release pushes the tag and creates the GitHub Release in two
# separate API calls. This step can fire after the tag is visible to
# `git fetch` but before the release-by-tag lookup resolves, in which
# window `gh release view "$new_tag"` returns 404. That's exactly what
# halted the 1.1.1 release flow: sanitize errored, which skipped
# Register-drivers, which skipped Back-merge — one transient 404 took
# out the rest of the post-release pipeline. Retry with exponential
# backoff before declaring a real failure.
attempts="${SANITIZE_MAX_ATTEMPTS:-5}"
delay="${SANITIZE_INITIAL_DELAY:-2}"
body=""
for ((i = 1; i <= attempts; i++)); do
  if body="$(gh release view "$new_tag" --json body --jq .body)"; then
    break
  fi
  if (( i == attempts )); then
    echo "::error::gh release view $new_tag failed after $attempts attempts (see errors above)." >&2
    exit 1
  fi
  echo "::notice::gh release view $new_tag attempt $i/$attempts failed; sleeping ${delay}s before retry."
  sleep "$delay"
  delay=$((delay * 2))
done

# Wrap @<identifier> in backticks where the @ is at line-start or after
# whitespace / `(` / `[` — the boundaries GitHub treats as a mention
# start. Anything preceded by a word char (email-like `user@host`) or
# by a backtick (already inline-coded) is left alone. The class
# delimiter is `#` so `@` and `|` can appear literally.
sanitized="$(printf '%s' "$body" | sed -E 's#(^|[[:space:]([])@([A-Za-z0-9][A-Za-z0-9._/-]+)#\1`@\2`#g')"
if [[ "$body" != "$sanitized" ]]; then
  gh release edit "$new_tag" --notes "$sanitized" --repo "$GITHUB_REPOSITORY" >/dev/null
  echo "Sanitized @-mentions in $new_tag release body."
else
  echo "No @-mentions to sanitize in $new_tag release body."
fi
