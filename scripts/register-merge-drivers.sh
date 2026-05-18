#!/usr/bin/env bash
# scripts/register-merge-drivers.sh
#
# Registers the two custom git merge drivers Flywheel relies on to keep
# release back-merges conflict-free, and writes the path→driver mappings
# to .git/info/attributes (the runtime attributes file, not the
# committed .gitattributes).
#
# Run as the "Register Flywheel merge drivers" step of the Flywheel push
# workflow (`flywheel-push.yml` / the reusable `push.yml`), after
# semantic-release and the @-mention sanitizer, before the back-merge.
# Extracted from inline YAML in #133 so it can be shellchecked and
# exercised by `tests/register-merge-drivers.test.ts`: the driver string
# was already silently broken once (#119), and a typo here means no
# driver fires and every back-merge hits the #112 conflict.
#
# CHANGELOG.md and release_files paths are derived artifacts:
# semantic-release rewrites them on each release, humans don't edit
# them. When develop accumulates prereleases between promotions, both
# sides of a back-merge have rewritten the same lines and a plain
# three-way `git merge` cannot auto-resolve — that's issue #112.
#
# Two custom drivers eliminate the conflict surface:
#   - flywheel-changelog: regenerates CHANGELOG.md from git tag history
#     (conventional-changelog-cli with the angular preset semantic-release
#     uses). Merge result is the union of both sides' tags; nothing lost.
#   - flywheel-release-file: `driver = true` is git's built-in "always
#     accept ours" — safe for release_files because semantic-release
#     rewrites them wholesale on the next run.
#
# Attributes go in .git/info/attributes (runtime, not committed) so the
# rules apply even if the adopter's checked-in .gitattributes is out of
# sync with their .flywheel.yml.
#
# Runs against the current working directory's git repo. Takes no
# arguments and no env. Exits non-zero only if `git config` itself fails.

set -euo pipefail

git config merge.flywheel-changelog.name "Flywheel CHANGELOG regenerator"
# Direct redirect to "%A": git invokes the driver via `sh -c`, which
# expands variables in the value before exec. The earlier
# `bash -c "... > \"$1\"" -- %A` form looked safer (positional-arg
# quoting) but was actually broken: the outer sh expanded `$1` (which
# was empty in its context) before reaching the inner bash, so the
# inner script reduced to `... > ""` and silently failed. Drop the
# indirection — `> "%A"` is correctly quoted at the only layer that
# matters (the shell git runs the driver with). See #119.
git config merge.flywheel-changelog.driver \
  'npx --yes conventional-changelog-cli@5 -p angular -r 0 > "%A"'
git config merge.flywheel-release-file.name "Flywheel release-file (keep ours)"
git config merge.flywheel-release-file.driver true

mkdir -p .git/info
{
  echo "CHANGELOG.md merge=flywheel-changelog"
  if [[ -f .flywheel.yml ]]; then
    # One-liner because a heredoc'd multi-line Python script's
    # significant indentation is awkward to keep correct here; the
    # extraction from YAML (#133) lifted the indent constraint but the
    # one-liner is still the least error-prone form. PyYAML is
    # preinstalled on ubuntu-latest; if it (or python3) is missing the
    # release_files derivation is skipped and CHANGELOG.md above still
    # gets its mapping.
    python3 -c "import yaml; cfg=yaml.safe_load(open('.flywheel.yml')) or {}; files=(cfg.get('flywheel') or {}).get('release_files') or []; [print(e['path']+' merge=flywheel-release-file') for e in files if isinstance(e, dict) and e.get('path')]" 2>/dev/null || true
  fi
} > .git/info/attributes
