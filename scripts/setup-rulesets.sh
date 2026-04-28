#!/usr/bin/env bash
# Apply the swarmflow ruleset bundle to an adopter (or sandbox) repo.
#
# Usage:
#   REPO=owner/name ./scripts/setup-rulesets.sh
#   REPO=owner/name APP_ACTOR_ID=12345 ./scripts/setup-rulesets.sh
#   REPO=owner/name SKIP=naming ./scripts/setup-rulesets.sh
#
# Required env:
#   REPO            owner/name of the target repo
#
# Optional env:
#   APP_ACTOR_ID    GitHub App ID to grant bypass to. Auto-resolved from the
#                   App installed on REPO if omitted (the App must be installed
#                   first — see docs/install-app/).
#   SKIP            Comma-separated list of rulesets to skip. Names:
#                     managed  - "swarmflow / managed branches" (Ruleset 1)
#                     tags     - "swarmflow / version tags" (Ruleset 3)
#                     naming   - "swarmflow / feature branch naming" (Ruleset 4)
#                   The merge_queue rule inside Ruleset 1 may fail on plans
#                   without merge queue available; if so, edit
#                   templates/rulesets/managed-branches.json to remove the
#                   `{ "type": "merge_queue" }` line and re-run.
#
# Idempotency: GitHub rejects duplicate ruleset names. If a ruleset with the
# same name already exists, this script aborts with a 422. Delete the
# existing rulesets via the UI (Settings → Rules → Rulesets) or
# `gh api repos/$REPO/rulesets/$ID -X DELETE`, then re-run.
#
# Requires: gh CLI authenticated with `admin:repo_hook` or repo admin scope.

set -euo pipefail

: "${REPO:?REPO=owner/name is required}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATES_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/templates/rulesets"

if [[ ! -d "$TEMPLATES_DIR" ]]; then
  echo "::error::ruleset templates dir not found: $TEMPLATES_DIR" >&2
  exit 1
fi

# Resolve App actor id from the installation if not provided. The
# `repos/{repo}/installation` endpoint returns the App that's currently
# installed; gh CLI auth must be the same identity (or a maintainer of
# the App) for this lookup to succeed.
if [[ -z "${APP_ACTOR_ID:-}" ]]; then
  echo "Looking up GitHub App installation on $REPO..."
  APP_ACTOR_ID=$(gh api "repos/${REPO}/installation" --jq '.app_id' 2>/dev/null || true)
  if [[ -z "$APP_ACTOR_ID" || "$APP_ACTOR_ID" == "null" ]]; then
    echo "::error::Cannot find App installation on $REPO." >&2
    echo "Install the swarmflow App first (docs/install-app/), or set APP_ACTOR_ID=<id> explicitly." >&2
    exit 1
  fi
  echo "  resolved APP_ACTOR_ID=$APP_ACTOR_ID"
fi

# Build skip set
declare -A SKIP_SET=()
if [[ -n "${SKIP:-}" ]]; then
  IFS=',' read -ra parts <<<"$SKIP"
  for p in "${parts[@]}"; do SKIP_SET[$p]=1; done
fi

apply_ruleset() {
  local key="$1"
  local file="$2"
  if [[ -n "${SKIP_SET[$key]:-}" ]]; then
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
  local resp http_code
  resp=$(echo "$body" | gh api "repos/${REPO}/rulesets" -X POST --input - 2>&1) || http_code=$?
  if [[ -z "${http_code:-}" ]]; then
    local id
    id=$(echo "$resp" | sed -n 's/.*"id":\([0-9]*\).*/\1/p' | head -1)
    echo "  ✓ created (id=$id)"
  else
    echo "  ✗ failed:" >&2
    echo "$resp" | sed 's/^/    /' >&2
    return 1
  fi
}

apply_ruleset managed "$TEMPLATES_DIR/managed-branches.json"
apply_ruleset tags    "$TEMPLATES_DIR/version-tags.json"
apply_ruleset naming  "$TEMPLATES_DIR/feature-branch-naming.json"

echo
echo "Done. Verify in $REPO → Settings → Rules → Rulesets"
