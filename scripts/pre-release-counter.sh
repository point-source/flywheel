#!/usr/bin/env bash
# Compute the next pre-release counter for a (base-version, identifier) pair.
#
# Usage: pre-release-counter.sh <base-version> <identifier>
#   base-version: e.g. 1.2.0
#   identifier:   dev | rc | alpha | beta (anything semver-compatible)
#
# Output: a single integer N such that v{base}-{id}.N does not yet exist.
# Reads local git tags; counter resets when the base version changes.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

require_cmd git

main() {
  local base=${1:?base version required}
  local id=${2:?pre-release identifier required}

  local prefix="v${base}-${id}."
  # List all tags for this base+id, extract trailing number, take max + 1.
  local max=0
  while IFS= read -r tag; do
    [[ -z $tag ]] && continue
    local n=${tag#"$prefix"}
    if [[ $n =~ ^[0-9]+$ ]] && (( n > max )); then
      max=$n
    fi
  done < <(git tag --list "${prefix}*" 2>/dev/null || true)

  printf '%d\n' $((max + 1))
}

main "$@"
