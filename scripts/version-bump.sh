#!/usr/bin/env bash
# Determine the semver bump level from a JSON array of parsed commits.
#
# Usage: version-bump.sh <commits.json-path | -->
#   Pass "-" to read JSON from stdin.
#
# Output: one of "major", "minor", "patch", "none"
#
# Rules (from spec §Version computation rules):
#   any breaking (!, BREAKING CHANGE footer, or feat!)  -> major
#   any feat                                            -> minor
#   any fix or perf                                     -> patch
#   chore/style/test/refactor/docs only                 -> none

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

require_cmd jq

main() {
  local src=${1:?commits JSON path or '-' required}
  local json
  if [[ $src == "-" ]]; then
    json=$(cat)
  else
    json=$(cat "$src")
  fi

  local has_breaking has_feat has_fix_or_perf
  has_breaking=$(jq 'any(.[]; .breaking == true)' <<<"$json")
  has_feat=$(jq 'any(.[]; .type == "feat")' <<<"$json")
  has_fix_or_perf=$(jq 'any(.[]; .type == "fix" or .type == "perf")' <<<"$json")

  if [[ $has_breaking == "true" ]]; then
    echo "major"
  elif [[ $has_feat == "true" ]]; then
    echo "minor"
  elif [[ $has_fix_or_perf == "true" ]]; then
    echo "patch"
  else
    echo "none"
  fi
}

main "$@"
