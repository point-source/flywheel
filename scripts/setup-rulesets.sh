#!/usr/bin/env bash
# Apply the swarmflow ruleset bundle to an adopter (or sandbox) repo.
#
# Usage:
#   ./scripts/setup-rulesets.sh --repo owner/name --app-id <app_id> [--skip name,...]
#   ./scripts/setup-rulesets.sh --help
#
# Required:
#   --repo <owner/name>      Target repo to apply rulesets to.
#   --app-id <number>        GitHub App id to grant bypass to. Find this on
#                            the App settings page (top: "App ID: 12345").
#                            NOT the slug, NOT the installation id.
#
# Optional:
#   --skip <name,...>        Comma-separated rulesets to skip:
#                              managed  - "swarmflow / managed branches"
#                              tags     - "swarmflow / version tags"
#                              naming   - "swarmflow / feature branch naming"
#                            The merge_queue rule inside `managed` may fail on
#                            plans without merge queue available; if so, edit
#                            templates/rulesets/managed-branches.json to
#                            remove the `{ "type": "merge_queue" }` line.
#
#   -h, --help               Show this help.
#
# Idempotency: GitHub rejects duplicate ruleset names. If a ruleset with the
# same name already exists, this script aborts with HTTP 422. Delete the
# existing rulesets via the UI (Settings → Rules → Rulesets) or
# `gh api repos/<repo>/rulesets/<id> -X DELETE`, then re-run.
#
# Requires: gh CLI authenticated as a repo admin (or anyone who can manage
# rulesets on the target repo).
#
# Compatible with bash 3.2+ (the macOS default).

set -euo pipefail

usage() {
  sed -n '/^# Apply/,/^# Compatible/p' "$0" | sed 's/^# \{0,1\}//'
}

REPO=""
APP_ACTOR_ID=""
SKIP=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)    REPO="${2:-}"; shift 2 ;;
    --app-id)  APP_ACTOR_ID="${2:-}"; shift 2 ;;
    --skip)    SKIP="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *)         echo "::error::unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$REPO" ]]; then
  echo "::error::--repo <owner/name> is required" >&2
  echo "Run with --help for usage." >&2
  exit 2
fi

if [[ -z "$APP_ACTOR_ID" ]]; then
  echo "::error::--app-id <number> is required" >&2
  echo "Find it on your GitHub App settings page (top: App ID: 12345)." >&2
  exit 2
fi

if ! [[ "$APP_ACTOR_ID" =~ ^[0-9]+$ ]]; then
  echo "::error::--app-id must be a number (the App id, not the slug). Got: '$APP_ACTOR_ID'" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATES_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/templates/rulesets"

if [[ ! -d "$TEMPLATES_DIR" ]]; then
  echo "::error::ruleset templates dir not found: $TEMPLATES_DIR" >&2
  exit 1
fi

# Build skip list (space-separated; bash 3.2 compatible — no associative arrays).
SKIP_LIST=" ${SKIP//,/ } "

is_skipped() {
  case "$SKIP_LIST" in
    *" $1 "*) return 0 ;;
    *)        return 1 ;;
  esac
}

apply_ruleset() {
  local key="$1"
  local file="$2"
  if is_skipped "$key"; then
    echo "Skipping '$key' (per --skip)"
    return 0
  fi
  if [[ ! -f "$file" ]]; then
    echo "::error::template not found: $file" >&2
    return 1
  fi
  local body
  body=$(sed "s/<APP_INSTALLATION_ACTOR_ID>/${APP_ACTOR_ID}/g" "$file")
  echo "Applying '$key' from $(basename "$file")..."
  local tmp
  tmp=$(mktemp)
  if echo "$body" | gh api "repos/${REPO}/rulesets" -X POST --input - >"$tmp" 2>&1; then
    local id
    id=$(sed -n 's/.*"id":\([0-9]*\).*/\1/p' "$tmp" | head -1)
    echo "  ✓ created (id=$id)"
    rm -f "$tmp"
  else
    echo "  ✗ failed:" >&2
    sed 's/^/    /' "$tmp" >&2
    rm -f "$tmp"
    return 1
  fi
}

apply_ruleset managed "$TEMPLATES_DIR/managed-branches.json"
apply_ruleset tags    "$TEMPLATES_DIR/version-tags.json"
apply_ruleset naming  "$TEMPLATES_DIR/feature-branch-naming.json"

echo
echo "Done. Verify in $REPO → Settings → Rules → Rulesets"
