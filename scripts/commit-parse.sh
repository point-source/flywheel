#!/usr/bin/env bash
# Parse conventional commits from a git log range (or stdin) into a JSON array.
#
# Usage:
#   commit-parse.sh <git-log-range>      # e.g. v1.2.3..HEAD
#   commit-parse.sh --stdin              # reads commits via the NUL-delimited
#                                        # format below on stdin
#
# Stdin format (one commit):
#   <sha>\x1f<subject>\x1e<body>\x00
#   (\x1f = US, \x1e = RS, \x00 = record terminator)
#
# Output: JSON array of objects:
#   { "sha", "type", "scope", "description", "breaking", "body", "valid" }
#
# "valid" is false when the subject does not match the conventional commit
# pattern. The caller decides whether to reject invalid commits.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

require_cmd jq
require_cmd git

feed_commits() {
  # Writes the NUL-delimited stream to fd 3.
  if [[ "${1:-}" == "--stdin" ]]; then
    cat
    return
  fi
  local range=${1:?range required}
  git log --format=$'%H\x1f%s\x1e%b\x00' "$range"
}

parse_subject() {
  # Echoes: type|scope|bang|description on success; empty on failure.
  local subject=$1
  local re='^([a-zA-Z]+)(\(([^)]+)\))?(!)?:[[:space:]]+(.+)$'
  if [[ $subject =~ $re ]]; then
    printf '%s|%s|%s|%s\n' \
      "${BASH_REMATCH[1]}" \
      "${BASH_REMATCH[3]}" \
      "${BASH_REMATCH[4]}" \
      "${BASH_REMATCH[5]}"
  fi
}

has_breaking_footer() {
  local body=$1
  grep -qE '^BREAKING[ -]CHANGE:' <<<"$body"
}

process_stream() {
  local out='[]'
  while IFS= read -r -d '' record; do
    [[ -z $record ]] && continue
    local sha subject body
    sha=${record%%$'\x1f'*}
    local rest=${record#*$'\x1f'}
    subject=${rest%%$'\x1e'*}
    if [[ $rest == *$'\x1e'* ]]; then
      body=${rest#*$'\x1e'}
    else
      body=""
    fi

    local parsed type scope bang description valid=false breaking=false
    parsed=$(parse_subject "$subject" || true)
    if [[ -n $parsed ]]; then
      IFS='|' read -r type scope bang description <<<"$parsed"
      valid=true
      if [[ $bang == "!" ]] || has_breaking_footer "$body"; then
        breaking=true
      fi
    else
      type=""
      scope=""
      description=$subject
    fi

    out=$(jq --arg sha "$sha" \
             --arg type "$type" \
             --arg scope "$scope" \
             --arg description "$description" \
             --argjson breaking "$breaking" \
             --argjson valid "$valid" \
             --arg body "$body" \
             '. + [{sha: $sha, type: $type, scope: $scope, description: $description, breaking: $breaking, body: $body, valid: $valid}]' \
             <<<"$out")
  done

  printf '%s\n' "$out"
}

main() {
  # Stream NUL-delimited records straight into the processor; command
  # substitution would strip the NULs that delimit records.
  if [[ "${1:-}" == "--stdin" ]]; then
    process_stream
  else
    local range=${1:?range required}
    git log --format=$'%H\x1f%s\x1e%b\x00' "$range" | process_stream
  fi
}

main "$@"
