#!/usr/bin/env bash
# init.sh — wire Flywheel into the current git repo.
#
# Writes .flywheel.yml (from a chosen preset), the two adopter workflows
# (flywheel-pr.yml + flywheel-push.yml) using GitHub App tokens, and prompts
# for FLYWHEEL_GH_APP_ID + FLYWHEEL_GH_APP_PRIVATE_KEY repo secrets via gh.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/point-source/flywheel/main/scripts/init.sh | bash
#   # or, from a checked-out flywheel repo:
#   ./scripts/init.sh
#
# Flags (all optional):
#   --preset minimal|three-stage|multi-stream
#   --skip-secrets        do not prompt for FLYWHEEL_GH_APP_ID / FLYWHEEL_GH_APP_PRIVATE_KEY
#   --skip-rulesets       do not offer to run apply-rulesets.sh
#   --required-checks "Quality,Build"   passed through to apply-rulesets.sh
#   --force               overwrite flywheel-pr.yml / flywheel-push.yml even
#                         if they already exist (for upgrading workflows
#                         when a new Flywheel version changes the templates).
#   --version <ref>       Flywheel ref baked into the workflow templates'
#                         `uses: point-source/flywheel@<ref>`. Defaults to
#                         the latest released major (e.g. `v2`); pass any
#                         tag, branch, or sha to override (sandbox/E2E
#                         testing typically uses `--version develop`).
#
# Dependencies: git, gh. (apply-rulesets.sh additionally needs jq + python3
# with PyYAML.)

set -euo pipefail

PRESET=""
SKIP_SECRETS=0
SKIP_RULESETS=0
REQUIRED_CHECKS=""
FORCE=0
FLYWHEEL_VERSION=""
# Hoisted out of create_app_via_manifest / prompt_existing_app_credentials
# so apply-rulesets.sh receives --app-id (App must be a bypass actor on the
# rulesets this script applies, otherwise semantic-release tag pushes are
# rejected).
CREATED_APP_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --preset) PRESET="$2"; shift 2 ;;
    --skip-secrets) SKIP_SECRETS=1; shift ;;
    --skip-rulesets) SKIP_RULESETS=1; shift ;;
    --required-checks) REQUIRED_CHECKS="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --version) FLYWHEEL_VERSION="$2"; shift 2 ;;
    -h|--help) sed -n '2,29p' "$0"; exit 0 ;;
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

# When run via `curl ... | bash`, stdin is the curl pipe, so `[[ -t 0 ]]`
# is false even though the user is sitting at a real terminal. Open
# /dev/tty as fd 3 (probing inside a brace group so a failure doesn't
# trip `set -e`; `[[ -r /dev/tty ]]` alone is too permissive in some
# sandboxed environments where the device is listed but unopenable),
# and use INTERACTIVE as the single source of truth from here on.
INTERACTIVE=0
if [[ -t 0 ]]; then
  INTERACTIVE=1
  exec 3<&0
elif { exec 3</dev/tty; } 2>/dev/null; then
  INTERACTIVE=1
fi

TEMPLATES_BASE="${FLYWHEEL_TEMPLATES_BASE:-https://raw.githubusercontent.com/point-source/flywheel/main/scripts/templates}"
# When piped via `curl ... | bash`, BASH_SOURCE is unset and `set -u` would
# trip; default to empty and skip local-templates detection in that case.
SCRIPT_SRC="${BASH_SOURCE[0]:-}"
SCRIPT_DIR=""
if [[ -n "$SCRIPT_SRC" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SRC")" 2>/dev/null && pwd || true)"
fi
LOCAL_TEMPLATES=""
if [[ -n "$SCRIPT_DIR" && -d "$SCRIPT_DIR/templates" ]]; then
  LOCAL_TEMPLATES="$SCRIPT_DIR/templates"
fi

# Templates contain `point-source/flywheel@__FLYWHEEL_VERSION__`; resolve
# the placeholder to the latest released major (e.g. v3 from v3.2.1) so
# adopters' workflows pin to a stable major. `--version` overrides for
# sandbox/E2E pinning (e.g. --version develop). Fail closed if the API
# is unreachable — silently falling back to a branch like `main` would
# move adopters onto unreleased code without their consent.
if [[ -z "$FLYWHEEL_VERSION" ]]; then
  if ! FLYWHEEL_VERSION="$(gh api repos/point-source/flywheel/releases/latest --jq '.tag_name | split(".")[0]' 2>/dev/null)" || [[ -z "$FLYWHEEL_VERSION" ]]; then
    echo "error: could not resolve latest Flywheel release via the GitHub API." >&2
    echo "  Pass --version <ref> explicitly (e.g. --version v2 to pin to the v2 major)." >&2
    exit 1
  fi
fi
echo "  templates will pin to: point-source/flywheel@${FLYWHEEL_VERSION}"

fetch_template() {
  local name="$1" dest="$2"
  if [[ -n "$LOCAL_TEMPLATES" && -f "$LOCAL_TEMPLATES/$name" ]]; then
    cp "$LOCAL_TEMPLATES/$name" "$dest"
  else
    curl -fsSL "$TEMPLATES_BASE/$name" -o "$dest"
  fi
  # Substitute the version placeholder. `sed -i.bak ... && rm` is the
  # portable form (BSD sed on macOS requires a suffix arg; GNU accepts it).
  sed -i.bak "s|@__FLYWHEEL_VERSION__|@${FLYWHEEL_VERSION}|g" "$dest" && rm -f "$dest.bak"
}

# 1. Pick a preset and write .flywheel.yml (skip if it already exists).
if [[ -f .flywheel.yml ]]; then
  echo "  .flywheel.yml already exists — leaving it alone."
else
  if [[ -z "$PRESET" ]]; then
    if [[ "$INTERACTIVE" -eq 0 ]]; then
      PRESET="minimal"
      echo "  non-interactive shell, defaulting to --preset minimal"
    else
      echo "Choose a .flywheel.yml preset:"
      echo "  1) minimal       — single stream, single branch (releases on every push to main)"
      echo "  2) three-stage   — develop → staging → main with promotion PRs"
      echo "  3) multi-stream  — main-line + a customer-acme variant"
      read -r -u 3 -p "Selection [1/2/3] (default 1): " choice
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

# 2. Write workflow files (skip each if it already exists; --force overwrites).
mkdir -p .github/workflows
for wf in flywheel-pr.yml flywheel-push.yml; do
  dest=".github/workflows/$wf"
  if [[ -f "$dest" && "$FORCE" -eq 0 ]]; then
    # Surface version drift so adopters know whether their existing template
    # is current. The placeholder `point-source/flywheel@<ref>` is always
    # present in flywheel-managed templates.
    existing_ref="$(grep -m1 -oE 'point-source/flywheel@[^ ]+' "$dest" 2>/dev/null | head -n1 | cut -d@ -f2 || true)"
    if [[ -n "$existing_ref" && "$existing_ref" != "$FLYWHEEL_VERSION" ]]; then
      echo "  $dest already exists (pinned @${existing_ref}; templates here pin @${FLYWHEEL_VERSION}) — pass --force to overwrite."
    else
      echo "  $dest already exists — leaving it alone (use --force to overwrite)."
    fi
  else
    fetch_template "$wf" "$dest"
    echo "  wrote $dest"
  fi
done

# 3. App-token secrets.
locate_create_script() {
  if [[ -n "$LOCAL_TEMPLATES" ]]; then
    local sibling="$SCRIPT_DIR/create-flywheel-app.py"
    if [[ -f "$sibling" ]]; then
      echo "$sibling"
      return 0
    fi
  fi
  local tmp
  tmp="$(mktemp)"
  if curl -fsSL "https://raw.githubusercontent.com/point-source/flywheel/main/scripts/create-flywheel-app.py" -o "$tmp" 2>/dev/null; then
    echo "$tmp"
    return 0
  fi
  return 1
}

create_app_via_manifest() {
  local create_script
  if ! create_script="$(locate_create_script)"; then
    echo "  error: could not locate or fetch create-flywheel-app.py — falling back to manual setup." >&2
    return 1
  fi
  local owner="${REPO%%/*}"
  local repo_name="${REPO##*/}"
  local org_flag=""
  if [[ "$(gh api "users/$owner" --jq .type 2>/dev/null)" == "Organization" ]]; then
    org_flag="--org"
  fi
  echo
  echo "  Creating a GitHub App named 'Flywheel for $repo_name'..."
  local result
  if ! result="$(python3 "$create_script" "$owner" $org_flag --app-name "Flywheel for $repo_name")"; then
    echo "  error: App creation failed." >&2
    return 1
  fi
  local app_id pem html_url
  app_id="$(echo "$result" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')"
  pem="$(echo "$result" | python3 -c 'import json,sys;print(json.load(sys.stdin)["pem"])')"
  html_url="$(echo "$result" | python3 -c 'import json,sys;print(json.load(sys.stdin)["html_url"])')"
  CREATED_APP_ID="$app_id"
  gh secret set FLYWHEEL_GH_APP_ID --body "$app_id" --repo "$REPO"
  printf '%s' "$pem" | gh secret set FLYWHEEL_GH_APP_PRIVATE_KEY --repo "$REPO"
  # Mirror App ID into a repo variable so re-runs of init.sh can recover
  # it (secret bodies aren't readable via the API). Workflows continue to
  # reference secrets.FLYWHEEL_GH_APP_ID — the variable is only for init.sh.
  gh variable set FLYWHEEL_GH_APP_ID --body "$app_id" --repo "$REPO" >/dev/null 2>&1 || \
    echo "  warning: could not set FLYWHEEL_GH_APP_ID repo variable; future re-runs may need to re-prompt for the App ID." >&2
  echo "  set FLYWHEEL_GH_APP_ID + FLYWHEEL_GH_APP_PRIVATE_KEY secrets."
  echo
  echo "  Final manual step: install the App on $REPO."
  echo "    Open: $html_url/installations/new"
  echo "    Choose 'Only select repositories' → $repo_name and click Install."
  echo "    Without installation, the App's tokens have no repo access."
  if [[ "$INTERACTIVE" -eq 1 ]]; then
    read -r -u 3 -p "  Press ENTER once installation is complete..."
  fi
  return 0
}

prompt_existing_app_credentials() {
  cat <<EOF
  If you haven't created the App yet, follow:
    https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/creating-a-github-app
  Required permissions: Contents r/w, Pull requests r/w, Issues r/w,
  Checks r/w, Metadata r. Install on $REPO.
EOF
  if [[ "$has_app_id" -eq 0 ]]; then
    read -r -u 3 -p "  GitHub App ID (numeric): " app_id
    if [[ -z "$app_id" ]]; then
      echo "  empty App ID — skipping FLYWHEEL_GH_APP_ID secret."
    else
      CREATED_APP_ID="$app_id"
      gh secret set FLYWHEEL_GH_APP_ID --body "$app_id" --repo "$REPO"
      gh variable set FLYWHEEL_GH_APP_ID --body "$app_id" --repo "$REPO" >/dev/null 2>&1 || \
        echo "  warning: could not set FLYWHEEL_GH_APP_ID repo variable; future re-runs may need to re-prompt for the App ID." >&2
      echo "  set FLYWHEEL_GH_APP_ID secret."
    fi
  fi
  if [[ "$has_app_key" -eq 0 ]]; then
    read -r -u 3 -p "  Path to private-key PEM file: " pem_path
    if [[ -z "$pem_path" ]]; then
      echo "  empty path — skipping FLYWHEEL_GH_APP_PRIVATE_KEY secret."
    elif [[ ! -f "$pem_path" ]]; then
      echo "  error: PEM file not found at '$pem_path' — skipping FLYWHEEL_GH_APP_PRIVATE_KEY secret." >&2
    else
      gh secret set FLYWHEEL_GH_APP_PRIVATE_KEY --repo "$REPO" < "$pem_path"
      echo "  set FLYWHEEL_GH_APP_PRIVATE_KEY secret."
    fi
  fi
}

if [[ "$SKIP_SECRETS" -eq 1 ]]; then
  echo "  --skip-secrets set; not touching repo secrets."
else
  existing_secrets="$(gh secret list --json name -q '.[].name' 2>/dev/null || true)"
  has_app_id=0; has_app_key=0
  echo "$existing_secrets" | grep -qx "FLYWHEEL_GH_APP_ID" && has_app_id=1
  echo "$existing_secrets" | grep -qx "FLYWHEEL_GH_APP_PRIVATE_KEY" && has_app_key=1

  if [[ "$has_app_id" -eq 1 && "$has_app_key" -eq 1 ]]; then
    echo "  FLYWHEEL_GH_APP_ID + FLYWHEEL_GH_APP_PRIVATE_KEY secrets already set."
  elif [[ "$INTERACTIVE" -eq 0 ]]; then
    echo "  non-interactive shell — skipping secret prompts. Set FLYWHEEL_GH_APP_ID + FLYWHEEL_GH_APP_PRIVATE_KEY manually:"
    echo "    gh secret set FLYWHEEL_GH_APP_ID --body '<your-app-id>' --repo $REPO"
    echo "    gh secret set FLYWHEEL_GH_APP_PRIVATE_KEY < /path/to/private-key.pem --repo $REPO"
  else
    echo
    echo "  Flywheel needs a GitHub App for installation tokens. Pick a setup path:"
    echo "    1) Create the App for me  — opens browser, ~30s round-trip"
    echo "    2) I have an App already — paste credentials manually"
    echo "    3) Skip — I'll set the secrets later"
    read -r -u 3 -p "  Selection [1/2/3] (default 1): " app_choice
    case "${app_choice:-1}" in
      1)
        if ! create_app_via_manifest; then
          echo "  Falling back to manual prompts."
          prompt_existing_app_credentials
        fi
        ;;
      2) prompt_existing_app_credentials ;;
      3) echo "  Skipped — set FLYWHEEL_GH_APP_ID and FLYWHEEL_GH_APP_PRIVATE_KEY before any Flywheel workflow runs." ;;
      *) echo "  invalid selection — skipping." ;;
    esac
  fi
fi

# 4. Repo setting: auto-delete head branches on merge. Enforces the
# one-PR-per-branch workflow Flywheel assumes — without it, contributors
# can accidentally reuse a merged branch and hit phantom rebase conflicts
# against the squashed upstream commit.
if gh api -X PATCH "repos/$REPO" -f delete_branch_on_merge=true >/dev/null 2>&1; then
  echo "  enabled delete_branch_on_merge (head branches auto-delete on PR merge)."
else
  echo "  warning: could not set delete_branch_on_merge — set manually in Settings → General → Pull Requests, or check your gh permissions." >&2
fi

# 5. Optionally apply rulesets.
if [[ "$SKIP_RULESETS" -eq 0 && -x "${SCRIPT_DIR:-}/apply-rulesets.sh" ]]; then
  # Recover App ID for --app-id from the repo variable written on first-run.
  # Without --app-id, apply-rulesets.sh PUTs an empty bypass_actors and the
  # App loses its bypass entry, breaking semantic-release pushes on re-runs.
  # Cheap and non-interactive — runs regardless of yn so the "skipped" hint
  # below also includes --app-id when known.
  if [[ -z "${CREATED_APP_ID:-}" ]]; then
    CREATED_APP_ID="$(gh variable get FLYWHEEL_GH_APP_ID --repo "$REPO" 2>/dev/null || true)"
  fi
  if [[ "$INTERACTIVE" -eq 1 ]]; then
    read -r -u 3 -p "  Apply branch + tag protection rulesets now? [y/N] " yn
  else
    yn="N"
  fi
  if [[ "${yn:-N}" =~ ^[Yy]$ ]]; then
    # Offer to detect required checks from local quality workflows if the
    # adopter didn't pass --required-checks. Without this, interactive runs
    # default to no required checks and adopters have to re-run apply-rulesets.sh
    # later to wire them up. Heuristic: any non-flywheel workflow that triggers
    # on pull_request is a candidate. Note the GitHub check context name is
    # usually "<workflow name> / <job name>" — adopter may need to refine after
    # the first PR run shows the actual context names.
    if [[ -z "$REQUIRED_CHECKS" && "$INTERACTIVE" -eq 1 ]]; then
      candidates=()
      for path in .github/workflows/*.yml .github/workflows/*.yaml; do
        [[ -f "$path" ]] || continue
        base="$(basename "$path")"
        case "$base" in flywheel-*.yml|flywheel-*.yaml) continue ;; esac
        if grep -qE '^[[:space:]]*pull_request:' "$path"; then
          n="$(grep -m1 -E '^name:' "$path" | sed -E 's/^name:[[:space:]]*//;s/^["'"'"']//;s/["'"'"']$//')"
          candidates+=("${n:-$base}")
        fi
      done
      # Always offer flywheel/conventional-commit as a recommended check.
      if [[ ${#candidates[@]} -gt 0 ]]; then
        echo "  Detected pull_request workflows: ${candidates[*]}"
        echo "  Recommended also: flywheel/conventional-commit"
        read -r -u 3 -p "  Required-check names (comma-separated, blank to skip): " REQUIRED_CHECKS
      else
        echo "  No non-flywheel pull_request workflows detected."
        read -r -u 3 -p "  Required-check names (comma-separated, blank to skip): " REQUIRED_CHECKS
      fi
    fi
    # Prompt fallback for adopters who onboarded before the variable was
    # persisted. The non-interactive case falls through to the warning below.
    if [[ -z "${CREATED_APP_ID:-}" && "$INTERACTIVE" -eq 1 ]]; then
      echo "  App ID not found in repo variables (re-run from before this was persisted)."
      read -r -u 3 -p "  Enter App ID for ruleset bypass-actor configuration (blank to skip): " CREATED_APP_ID
      if [[ -n "$CREATED_APP_ID" ]]; then
        gh variable set FLYWHEEL_GH_APP_ID --body "$CREATED_APP_ID" --repo "$REPO" >/dev/null 2>&1 || true
      fi
    fi
    if [[ -z "${CREATED_APP_ID:-}" ]]; then
      echo "  warning: no App ID available — apply-rulesets.sh will run without --app-id, leaving bypass_actors empty. Re-run scripts/apply-rulesets.sh $REPO --app-id <id> manually after this completes." >&2
    fi
    args=("$REPO")
    [[ -n "$REQUIRED_CHECKS" ]] && args+=(--required-checks "$REQUIRED_CHECKS")
    [[ -n "${CREATED_APP_ID:-}" ]] && args+=(--app-id "$CREATED_APP_ID")
    "$SCRIPT_DIR/apply-rulesets.sh" "${args[@]}"
  else
    echo "  skipped ruleset apply. Run later with: scripts/apply-rulesets.sh $REPO${CREATED_APP_ID:+ --app-id $CREATED_APP_ID}"
  fi
elif [[ "$SKIP_RULESETS" -eq 0 ]]; then
  echo "  apply-rulesets.sh not adjacent to init.sh — fetch the repo or run:"
  echo "    curl -fsSL https://raw.githubusercontent.com/point-source/flywheel/main/scripts/apply-rulesets.sh | bash -s -- $REPO"
fi

cat <<EOF

Flywheel scaffold written to $REPO_ROOT.
Next steps:
  1. Review .flywheel.yml and adjust auto_merge lists for your team.
  2. Commit + push the new files.
  3. Open a 'chore: smoke test' PR to verify the wiring.
  4. Run scripts/doctor.sh (or curl|bash equivalent) to validate the setup.
EOF
