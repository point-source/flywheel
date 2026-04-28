#!/usr/bin/env bash
# Apply the swarmflow ruleset bundle to an adopter (or sandbox) repo.
#
# Usage:
#   REPO=owner/name APP_ACTOR_ID=<app_id> ./scripts/setup-rulesets.sh
#   REPO=owner/name APP_ACTOR_ID=<app_id> SKIP=naming ./scripts/setup-rulesets.sh
#
# Required env:
#   REPO            owner/name of the target repo
#   APP_ACTOR_ID    GitHub App ID to grant bypass to. Find this:
#                     - Your App's settings page (top of page: "App ID: 12345")
#                     - In repo secrets if you stored it as APP_ID:
#                         gh secret list --repo $REPO  (lists names, not values)
#                     - This is the *App* id, NOT the installation id.
#
# Optional env:
#   SKIP            Comma-separated list of rulesets to skip:
#                     managed  - "swarmflow / managed branches" (Ruleset 1)
#                     tags     - "swarmflow / version tags" (Ruleset 3)
#                     naming   - "swarmflow / feature branch naming" (Ruleset 4)
#                   The merge_queue rule inside Ruleset 1 may fail on plans
#                   without merge queue available; if so, edit
#                   templates/rulesets/managed-branches.json to remove the
#                   `{ "type": "merge_queue" }` line and re-run.
#
# Idempotency: GitHub rejects duplicate ruleset names. If a ruleset with the
# same name already exists, this script aborts with HTTP 422. Delete the
# existing rulesets via the UI (Settings → Rules → Rulesets) or
# `gh api repos/$REPO/rulesets/$ID -X DELETE`, then re-run.
#
# Requires: gh CLI authenticated as a repo admin (or anyone who can manage
# rulesets on $REPO).
#
# Compatible with bash 3.2+ (the macOS default).

set -euo pipefail

: "${REPO:?REPO=owner/name is required}"
: "${APP_ACTOR_ID:?APP_ACTOR_ID=<app_id> is required (find it on your GitHub App settings page, e.g. App ID: 12345)}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATES_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/templates/rulesets"

if [[ ! -d "$TEMPLATES_DIR" ]]; then
  echo "::error::ruleset templates dir not found: $TEMPLATES_DIR" >&2
  exit 1
fi

# Validate APP_ACTOR_ID is numeric (catches the common "passed app slug
# instead of id" mistake).
if ! [[ "$APP_ACTOR_ID" =~ ^[0-9]+$ ]]; then
  echo "::error::APP_ACTOR_ID must be a number (the App id, not the slug). Got: '$APP_ACTOR_ID'" >&2
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
    echo "Skipping '$key' (per SKIP)"
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
