#!/usr/bin/env bash
# apply-rulesets.sh — apply Flywheel branch + tag protection rulesets to a repo.
#
# Reads .flywheel.yml in the current directory, extracts every managed branch,
# and applies two rulesets via the GitHub Rulesets API:
#   1. Flywheel managed branches — require PRs, block deletion / force-push,
#      require linear history. Optionally requires named status checks.
#   2. Flywheel tag namespace (v*) — block deletion / force-push of v* tags.
#      Optionally adds a GitHub App as a bypass actor so the bot can mint tags.
#
# Usage:
#   ./scripts/apply-rulesets.sh <owner/repo> [--required-checks "Quality,Build"] [--app-id 12345]
#
# Dependencies: gh, jq, yq.

set -euo pipefail

REPO=""
REQUIRED_CHECKS=""
APP_ID="${APP_ID:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --required-checks) REQUIRED_CHECKS="$2"; shift 2 ;;
    --app-id) APP_ID="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,18p' "$0"
      exit 0
      ;;
    *)
      if [[ -z "$REPO" ]]; then REPO="$1"; shift
      else echo "Unknown argument: $1" >&2; exit 2
      fi
      ;;
  esac
done

if [[ -z "$REPO" ]]; then
  echo "error: REPO argument required (owner/repo)" >&2
  exit 2
fi

for tool in gh jq yq; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "error: '$tool' is required but not installed." >&2
    case "$tool" in
      gh) echo "  install: https://cli.github.com/" >&2 ;;
      jq) echo "  install: brew install jq  /  apt-get install jq" >&2 ;;
      yq) echo "  install: brew install yq  /  https://github.com/mikefarah/yq" >&2 ;;
    esac
    exit 1
  }
done

if [[ ! -f .flywheel.yml ]]; then
  echo "error: .flywheel.yml not found in current directory" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

branch_refs_json="$(yq -o=json '[.flywheel.streams[].branches[].name | "refs/heads/" + .]' .flywheel.yml)"
branch_count="$(echo "$branch_refs_json" | jq 'length')"

if [[ "$branch_count" -eq 0 ]]; then
  echo "error: no branches found in .flywheel.yml" >&2
  exit 1
fi

echo "Applying managed-branches ruleset to $branch_count branch(es) in $REPO..."

managed_payload="$(jq \
  --argjson branches "$branch_refs_json" \
  '.conditions.ref_name.include = $branches' \
  "$SCRIPT_DIR/rulesets/managed-branches.json")"

if [[ -n "$REQUIRED_CHECKS" ]]; then
  checks_json="$(echo "$REQUIRED_CHECKS" | jq -R 'split(",") | map({context: .})')"
  managed_payload="$(echo "$managed_payload" | jq \
    --argjson checks "$checks_json" \
    '.rules += [{"type":"required_status_checks","parameters":{"required_status_checks":$checks,"strict_required_status_checks_policy":false}}]')"
fi

echo "$managed_payload" | gh api -X POST "/repos/$REPO/rulesets" --input -

echo "Applying tag-namespace ruleset to $REPO..."

tag_payload="$(cat "$SCRIPT_DIR/rulesets/tag-namespace.json")"
if [[ -n "$APP_ID" ]]; then
  tag_payload="$(echo "$tag_payload" | jq \
    --arg app_id "$APP_ID" \
    '.bypass_actors = [{"actor_id": ($app_id | tonumber), "actor_type": "Integration", "bypass_mode": "always"}]')"
fi

echo "$tag_payload" | gh api -X POST "/repos/$REPO/rulesets" --input -

echo "Done. Verify with: gh api repos/$REPO/rulesets"
