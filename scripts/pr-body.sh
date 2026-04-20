#!/usr/bin/env bash
# Render the bot-owned PR body from parsed commits + metadata.
#
# Usage: pr-body.sh <commits.json | -> --bump <level> --target <branch> \
#                   [--version <semver>] [--checks <status>] [--mode feature|promotion]
#
# Modes:
#   feature   — per-PR body (spec §Feature/fix PR body): grouped by type,
#               shows bump signal, no version.
#   promotion — promotion PR body (spec §Promotion PR body): accumulated
#               changelog fragment, includes version.
#
# Output: markdown body on stdout.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

require_cmd jq

commits_src=""
bump=""
target=""
version=""
checks=""
mode="feature"

while (( $# )); do
  case $1 in
    --bump)    bump=$2; shift 2 ;;
    --target)  target=$2; shift 2 ;;
    --version) version=$2; shift 2 ;;
    --checks)  checks=$2; shift 2 ;;
    --mode)    mode=$2; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *)
      if [[ -z $commits_src ]]; then
        commits_src=$1
      else
        die "unexpected argument: $1"
      fi
      shift
      ;;
  esac
done

[[ -n $commits_src ]] || die "commits JSON path (or -) required"
[[ -n $bump ]]        || die "--bump required"
[[ -n $target ]]      || die "--target required"

if [[ $commits_src == "-" ]]; then
  commits=$(cat)
else
  commits=$(cat "$commits_src")
fi

# Group commits by type, preserving insertion order.
types=$(jq -r '[.[] | select(.valid == true) | .type] | unique[]' <<<"$commits")

{
  echo "## Changes"
  echo
  echo "<!-- Generated from conventional commits -->"

  if [[ -z $types ]]; then
    echo
    echo "_No conventional commits detected._"
  else
    while IFS= read -r t; do
      [[ -z $t ]] && continue
      echo
      echo "### $t"
      jq -r --arg t "$t" \
        '.[] | select(.valid == true and .type == $t) |
          "- " +
          (if .scope != "" then "**" + .scope + ":** " else "" end) +
          .description +
          " (" + (.sha[0:7]) + ")" +
          (if .breaking then " **BREAKING**" else "" end)' <<<"$commits"
    done <<<"$types"
  fi

  echo
  echo "---"
  if [[ $mode == "promotion" && -n $version ]]; then
    echo "**Version:** \`$version\`"
  else
    echo "**Version bump:** $bump"
  fi
  echo "**Target:** $target"
  if [[ -n $checks ]]; then
    echo "**Quality checks:** $checks"
  fi
}
