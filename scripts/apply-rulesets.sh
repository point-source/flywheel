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
#   ./scripts/apply-rulesets.sh <owner/repo> [--config <path>] [--required-checks "Quality,Build"] [--app-id 12345]
#
# --config defaults to ./.flywheel.yml. Use it to apply rulesets that match
# a config that hasn't been merged to the current working tree yet (e.g.
# point at a sibling worktree or a checked-out copy of develop's config).
#
# Dependencies: gh, jq, python3 with PyYAML (preinstalled on macOS; yamllint
# pulls it in too).

set -euo pipefail

REPO=""
CONFIG_PATH=".flywheel.yml"
REQUIRED_CHECKS=""
APP_ID="${APP_ID:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config) CONFIG_PATH="$2"; shift 2 ;;
    --required-checks) REQUIRED_CHECKS="$2"; shift 2 ;;
    --app-id) APP_ID="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,22p' "$0"
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

for tool in gh jq python3; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "error: '$tool' is required but not installed." >&2
    case "$tool" in
      gh) echo "  install: https://cli.github.com/" >&2 ;;
      jq) echo "  install: brew install jq  /  apt-get install jq" >&2 ;;
      python3) echo "  python3 ships with macOS 12.3+ and most Linux distros." >&2 ;;
    esac
    exit 1
  }
done
python3 -c "import yaml" 2>/dev/null || {
  echo "error: PyYAML is required. Install with: pip3 install --user pyyaml" >&2
  exit 1
}

if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "error: config file not found: $CONFIG_PATH" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

branch_refs_json="$(CONFIG_PATH="$CONFIG_PATH" python3 - <<'PYEOF'
import json, os, yaml
with open(os.environ['CONFIG_PATH']) as f:
    data = yaml.safe_load(f)
print(json.dumps([f'refs/heads/{b["name"]}' for s in data['flywheel']['streams'] for b in s['branches']]))
PYEOF
)"
branch_count="$(echo "$branch_refs_json" | jq 'length')"

if [[ "$branch_count" -eq 0 ]]; then
  echo "error: no branches found in .flywheel.yml" >&2
  exit 1
fi

# apply_ruleset: idempotent create-or-replace by ruleset name. Re-running
# this script after .flywheel.yml changes (e.g. adding a branch) must update
# the existing ruleset rather than stack a duplicate. PUT updates the
# ruleset in place — atomic, preserves the ruleset ID (and the
# https://github.com/.../rules/<id> URLs that reference it), and never
# leaves the repo briefly unprotected the way DELETE-then-POST would if
# the POST failed.
apply_ruleset() {
  local payload="$1"
  local name
  name="$(echo "$payload" | jq -r .name)"
  local existing_id
  existing_id="$(gh api "repos/$REPO/rulesets" --jq ".[] | select(.name == \"$name\") | .id" | head -n1)"
  if [[ -n "$existing_id" ]]; then
    echo "Updating existing '$name' ruleset (id $existing_id) in place..."
    echo "$payload" | gh api -X PUT "/repos/$REPO/rulesets/$existing_id" --input -
  else
    echo "$payload" | gh api -X POST "/repos/$REPO/rulesets" --input -
  fi
}

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

# Without a bypass entry the App cannot push semantic-release's version
# commit/tag back to a managed branch (PR-only rule), and the back-merge
# step's merge commit into upstream branches is rejected by linear-history.
if [[ -n "$APP_ID" ]]; then
  managed_payload="$(echo "$managed_payload" | jq \
    --arg app_id "$APP_ID" \
    '.bypass_actors = [{"actor_id": ($app_id | tonumber), "actor_type": "Integration", "bypass_mode": "always"}]')"
fi

apply_ruleset "$managed_payload"

echo "Applying tag-namespace ruleset to $REPO..."

tag_payload="$(cat "$SCRIPT_DIR/rulesets/tag-namespace.json")"
if [[ -n "$APP_ID" ]]; then
  tag_payload="$(echo "$tag_payload" | jq \
    --arg app_id "$APP_ID" \
    '.bypass_actors = [{"actor_id": ($app_id | tonumber), "actor_type": "Integration", "bypass_mode": "always"}]')"
fi

apply_ruleset "$tag_payload"

echo "Done. Verify with: gh api repos/$REPO/rulesets"
