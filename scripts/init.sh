#!/usr/bin/env bash
# init.sh — wire Flywheel into the current git repo.
#
# Writes .flywheel.yml (from a chosen preset), the two adopter workflows
# (flywheel-pr.yml + flywheel-push.yml) using GitHub App tokens, and prompts
# for APP_ID + APP_PRIVATE_KEY repo secrets via gh.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/point-source/flywheel/v1/scripts/init.sh | bash
#   # or, from a checked-out flywheel repo:
#   ./scripts/init.sh
#
# Flags (all optional):
#   --preset minimal|three-stage|multi-stream
#   --skip-secrets        do not prompt for APP_ID / APP_PRIVATE_KEY
#   --skip-rulesets       do not offer to run apply-rulesets.sh
#   --required-checks "Quality,Build"   passed through to apply-rulesets.sh
#
# Dependencies: git, gh. (apply-rulesets.sh additionally needs jq + yq.)

set -euo pipefail

PRESET=""
SKIP_SECRETS=0
SKIP_RULESETS=0
REQUIRED_CHECKS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --preset) PRESET="$2"; shift 2 ;;
    --skip-secrets) SKIP_SECRETS=1; shift ;;
    --skip-rulesets) SKIP_RULESETS=1; shift ;;
    --required-checks) REQUIRED_CHECKS="$2"; shift 2 ;;
    -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

for tool in git gh; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "error: '$tool' is required but not installed." >&2
    exit 1
  }
done

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "error: not inside a git repo. Run from your repo root." >&2
  exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

if ! REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)"; then
  echo "error: could not resolve owner/repo via 'gh repo view'. Are you authenticated ('gh auth login') and does this repo have a GitHub remote?" >&2
  exit 1
fi
echo "Wiring Flywheel into $REPO..."

TEMPLATES_BASE="${FLYWHEEL_TEMPLATES_BASE:-https://raw.githubusercontent.com/point-source/flywheel/v1/scripts/templates}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
LOCAL_TEMPLATES=""
if [[ -n "$SCRIPT_DIR" && -d "$SCRIPT_DIR/templates" ]]; then
  LOCAL_TEMPLATES="$SCRIPT_DIR/templates"
fi

fetch_template() {
  local name="$1" dest="$2"
  if [[ -n "$LOCAL_TEMPLATES" && -f "$LOCAL_TEMPLATES/$name" ]]; then
    cp "$LOCAL_TEMPLATES/$name" "$dest"
  else
    curl -fsSL "$TEMPLATES_BASE/$name" -o "$dest"
  fi
}

# 1. Pick a preset and write .flywheel.yml (skip if it already exists).
if [[ -f .flywheel.yml ]]; then
  echo "  .flywheel.yml already exists — leaving it alone."
else
  if [[ -z "$PRESET" ]]; then
    if [[ ! -t 0 ]]; then
      PRESET="minimal"
      echo "  non-interactive shell, defaulting to --preset minimal"
    else
      echo "Choose a .flywheel.yml preset:"
      echo "  1) minimal       — single stream, single branch (releases on every push to main)"
      echo "  2) three-stage   — develop → staging → main with promotion PRs"
      echo "  3) multi-stream  — main-line + a customer-acme variant"
      read -r -p "Selection [1/2/3] (default 1): " choice
      case "${choice:-1}" in
        1|"") PRESET="minimal" ;;
        2) PRESET="three-stage" ;;
        3) PRESET="multi-stream" ;;
        *) echo "error: invalid selection '$choice'" >&2; exit 2 ;;
      esac
    fi
  fi
  case "$PRESET" in
    minimal|three-stage|multi-stream) ;;
    *) echo "error: --preset must be minimal | three-stage | multi-stream (got '$PRESET')" >&2; exit 2 ;;
  esac
  fetch_template "flywheel.${PRESET}.yml" .flywheel.yml
  echo "  wrote .flywheel.yml ($PRESET preset)"
fi

# 2. Write workflow files (skip each if it already exists).
mkdir -p .github/workflows
for wf in flywheel-pr.yml flywheel-push.yml; do
  if [[ -f ".github/workflows/$wf" ]]; then
    echo "  .github/workflows/$wf already exists — leaving it alone."
  else
    fetch_template "$wf" ".github/workflows/$wf"
    echo "  wrote .github/workflows/$wf"
  fi
done

# 3. App-token secrets.
if [[ "$SKIP_SECRETS" -eq 1 ]]; then
  echo "  --skip-secrets set; not touching repo secrets."
else
  existing_secrets="$(gh secret list --json name -q '.[].name' 2>/dev/null || true)"
  has_app_id=0; has_app_key=0
  echo "$existing_secrets" | grep -qx "APP_ID" && has_app_id=1
  echo "$existing_secrets" | grep -qx "APP_PRIVATE_KEY" && has_app_key=1

  if [[ "$has_app_id" -eq 1 && "$has_app_key" -eq 1 ]]; then
    echo "  APP_ID + APP_PRIVATE_KEY secrets already set."
  else
    if [[ ! -t 0 ]]; then
      echo "  non-interactive shell — skipping secret prompts. Set APP_ID + APP_PRIVATE_KEY manually:"
      echo "    gh secret set APP_ID --body '<your-app-id>' --repo $REPO"
      echo "    gh secret set APP_PRIVATE_KEY < /path/to/private-key.pem --repo $REPO"
    else
      cat <<EOF
  Flywheel uses a GitHub App installation token (PATs are not supported).
  If you haven't created the App yet, follow:
    https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/creating-a-github-app
  Required scopes: Contents r/w, Pull requests r/w, Metadata r. Install on $REPO.
EOF
      if [[ "$has_app_id" -eq 0 ]]; then
        read -r -p "  GitHub App ID (numeric): " app_id
        if [[ -z "$app_id" ]]; then
          echo "  empty App ID — skipping APP_ID secret."
        else
          gh secret set APP_ID --body "$app_id" --repo "$REPO"
          echo "  set APP_ID secret."
        fi
      fi
      if [[ "$has_app_key" -eq 0 ]]; then
        read -r -p "  Path to private-key PEM file: " pem_path
        if [[ -z "$pem_path" ]]; then
          echo "  empty path — skipping APP_PRIVATE_KEY secret."
        elif [[ ! -f "$pem_path" ]]; then
          echo "  error: PEM file not found at '$pem_path' — skipping APP_PRIVATE_KEY secret." >&2
        else
          gh secret set APP_PRIVATE_KEY --repo "$REPO" < "$pem_path"
          echo "  set APP_PRIVATE_KEY secret."
        fi
      fi
    fi
  fi
fi

# 4. Optionally apply rulesets.
if [[ "$SKIP_RULESETS" -eq 0 && -x "${SCRIPT_DIR:-}/apply-rulesets.sh" ]]; then
  if [[ -t 0 ]]; then
    read -r -p "  Apply branch + tag protection rulesets now? [y/N] " yn
  else
    yn="N"
  fi
  if [[ "${yn:-N}" =~ ^[Yy]$ ]]; then
    args=("$REPO")
    [[ -n "$REQUIRED_CHECKS" ]] && args+=(--required-checks "$REQUIRED_CHECKS")
    "$SCRIPT_DIR/apply-rulesets.sh" "${args[@]}"
  else
    echo "  skipped ruleset apply. Run later with: scripts/apply-rulesets.sh $REPO"
  fi
elif [[ "$SKIP_RULESETS" -eq 0 ]]; then
  echo "  apply-rulesets.sh not adjacent to init.sh — fetch the repo or run:"
  echo "    curl -fsSL https://raw.githubusercontent.com/point-source/flywheel/v1/scripts/apply-rulesets.sh | bash -s -- $REPO"
fi

cat <<EOF

Flywheel scaffold written to $REPO_ROOT.
Next steps:
  1. Review .flywheel.yml and adjust auto_merge lists for your team.
  2. Commit + push the new files.
  3. Open a 'chore: smoke test' PR to verify the wiring.
  4. Run scripts/doctor.sh (or curl|bash equivalent) to validate the setup.
EOF
