#!/usr/bin/env bash
# init.sh — wire Flywheel into the current git repo.
#
# Writes .flywheel.yml (from a chosen preset), the two adopter workflows
# (flywheel-pr.yml + flywheel-push.yml) using GitHub App tokens, and prompts
# for the FLYWHEEL_GH_APP_ID repo Variable + FLYWHEEL_GH_APP_PRIVATE_KEY repo
# Secret via gh.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/point-source/flywheel/main/scripts/init.sh | bash
#   # or, from a checked-out flywheel repo:
#   ./scripts/init.sh
#
# Flags (all optional):
#   --preset minimal|three-stage|multi-stream
#   --skip-secrets        do not prompt for App credentials (FLYWHEEL_GH_APP_ID
#                         variable, FLYWHEEL_GH_APP_PRIVATE_KEY secret)
#   --skip-rulesets       do not offer to run apply-rulesets.sh
#   --required-checks "quality,build"   passed through to apply-rulesets.sh
#   --force               overwrite flywheel-pr.yml / flywheel-push.yml even
#                         if they already exist (for upgrading workflows
#                         when a new Flywheel version changes the templates).
#   --version <ref>       Flywheel ref baked into the workflow templates'
#                         `uses: point-source/flywheel@<ref>`. Defaults to
#                         the latest released major (e.g. `v2`); pass any
#                         tag, branch, or sha to override (sandbox/E2E
#                         testing typically uses `--version develop`).
#   --scope repo|org      Where to write FLYWHEEL_GH_APP_ID (Variable) and
#                         FLYWHEEL_GH_APP_PRIVATE_KEY (Secret). `org`
#                         shares them across every repo in the owning
#                         org (visibility=all) — useful when the same App
#                         is installed org-wide. Requires an admin:org gh
#                         token. Defaults to prompting interactively when
#                         the owner is an Organization, otherwise `repo`.
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
# Empty until the user picks (interactively) or passes --scope. Resolved
# to "repo" or "org" before any credential write; "org" requires the
# owner to be an Organization and the gh token to have admin:org scope.
SCOPE=""
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
    --scope)
      case "$2" in
        repo|org) SCOPE="$2" ;;
        *) echo "error: --scope must be 'repo' or 'org' (got '$2')" >&2; exit 2 ;;
      esac
      shift 2
      ;;
    -h|--help) sed -n '2,37p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

# Only git is needed immediately (for `git rev-parse` below). gh's install +
# auth state is probed by the pre-flight pass (preflight_detect_gh_capability),
# so a missing/unauthenticated gh surfaces as a finding rather than a hard exit
# here — and the gh-dependent REPO resolution is deferred until after the gate.
command -v git >/dev/null 2>&1 || {
  echo "error: 'git' is required but not installed." >&2
  exit 1
}

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "error: not inside a git repo. Run from your repo root." >&2
  exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

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

# Test-only override: force the interactive gate branch without a real TTY.
# Used by the pre-flight test suite to exercise the interactive halt path; never
# set in normal use. It does NOT open fd 3, so it is only safe on paths that
# exit before any `read -u 3` — which the pre-flight gate (below) does.
if [[ "${FLYWHEEL_ASSUME_INTERACTIVE:-0}" -eq 1 ]]; then
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

# ---------------------------------------------------------------------------
# Pre-flight detection pass (SPEC.md §spec:preflight-gate).
#
# A single READ-ONLY detection pass that runs as the FIRST substantive thing
# init does — before the version is resolved, before any prompt, and before any
# file is written (.flywheel.yml, the workflow files, .gitattributes, merge
# drivers). It collects findings through the shared bucket × severity vocabulary
# (scripts/lib/findings.sh) and renders a summary the adopter sees up front.
# Batches 3–5 register their detectors at the seam in preflight_run; this batch
# ships the harness and (in the gate below) the severity-driven control flow.
# ---------------------------------------------------------------------------

# Source the shared finding vocabulary, mirroring doctor.sh: locate it next to
# this script, else fetch it from the same source. Without it the pre-flight
# pass cannot emit findings — a hard error.
# shellcheck source=scripts/lib/findings.sh
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/lib/findings.sh" ]]; then
  # shellcheck disable=SC1091
  . "$SCRIPT_DIR/lib/findings.sh"
else
  findings_tmp="$(mktemp)"
  if curl -fsSL "https://raw.githubusercontent.com/point-source/flywheel/main/scripts/lib/findings.sh" -o "$findings_tmp" 2>/dev/null; then
    # shellcheck disable=SC1090
    . "$findings_tmp"
  else
    echo "error: could not locate or fetch scripts/lib/findings.sh — pre-flight cannot run without it." >&2
    exit 1
  fi
fi

# preflight_inject — test/debug hook. When FLYWHEEL_PREFLIGHT_INJECT is set,
# emit each "bucket:severity:message" line (newline-separated) as a finding.
# Read-only; never set in normal use. Lets the gate be exercised before the
# real detectors (Batches 3–5) exist.
preflight_inject() {
  [[ -n "${FLYWHEEL_PREFLIGHT_INJECT:-}" ]] || return 0
  local line bucket severity message rest
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    bucket="${line%%:*}"; rest="${line#*:}"
    severity="${rest%%:*}"; message="${rest#*:}"
    finding "$bucket" "$severity" "$message" || true
  done <<< "${FLYWHEEL_PREFLIGHT_INJECT}"
}

# preflight_detect_gh_capability — §spec:preflight-gh-capability.
# READ-ONLY probe of gh install + auth state. Grants/requests nothing.
# Workstream 2 appends path-specific scope checks after the auth check, reusing
# the captured `auth_status`.
preflight_detect_gh_capability() {
  if ! command -v gh >/dev/null 2>&1; then
    finding local-env block "gh (GitHub CLI) is not installed — required to resolve the repository, write App credentials, and apply rulesets (install: https://cli.github.com)"
    return 0
  fi
  # auth_status is captured for Workstream 2's scope checks (it parses the
  # "Token scopes:" line); unused until then.
  local auth_status
  # shellcheck disable=SC2034
  if ! auth_status="$(gh auth status 2>&1)"; then
    finding local-env block "gh is not authenticated — run 'gh auth login' (setup needs it to resolve the repository and write App credentials)"
    return 0
  fi
  finding local-env info "gh installed and authenticated"
  # >>> Workstream 2 scope checks go here (reuse $auth_status) >>>
}

# preflight_run — run every detector and print the pre-flight summary. Detectors
# emit via the shared `finding` (and the preflight_block wrapper added with the
# gate). The summary is the first thing the adopter sees; the gate acts on it
# next.
preflight_run() {
  echo
  echo "Pre-flight checks:"
  # >>> detector seam — Batches 3–5 register their detectors here >>>
  preflight_detect_gh_capability       # §spec:preflight-gh-capability (Batch 3)
  #   preflight_detect_release_conflict  # §spec:preflight-release-conflict (Batch 4)
  #   preflight_detect_credentials_app   # §spec:preflight-credentials-app (Batch 5)
  preflight_inject
  # <<< detector seam <<<
  if [[ "$FINDINGS_BLOCK_COUNT" -gt 0 ]]; then
    printf '  pre-flight: \033[31m%d blocker(s)\033[0m found.\n' "$FINDINGS_BLOCK_COUNT"
  else
    printf '  pre-flight: \033[32mno blockers\033[0m.\n'
  fi
}

# preflight_block <override-token> <bucket> <message>
# Emit a block finding for <message>, UNLESS the override for <override-token> is
# active (env/var PREFLIGHT_OVERRIDE_<token>=1), in which case demote it to an
# advisory warn. The override is opt-in and never the default
# (SPEC §spec:preflight-gate); this batch defines the hook, and Batch 4 wires the
# actual --override-release-conflict FLAG that sets the token. <override-token>
# uses underscores (e.g. release_conflict → flag --override-release-conflict).
preflight_block() {
  local token="$1" bucket="$2" message="$3"
  local ovar="PREFLIGHT_OVERRIDE_${token}"
  if [[ "${!ovar:-0}" -eq 1 ]]; then
    finding "$bucket" warn "$message (overridden via --override-${token//_/-})"
  else
    finding "$bucket" block "$message"
  fi
}

# preflight_gate — severity drives control flow. A block halts setup before any
# prompt or file is written. Interactively the adopter must resolve it (or pass
# an offered override flag) and re-run; non-interactively the run exits non-zero
# with the reason. warn/info are advisory and never halt. Runs immediately after
# preflight_run, before the version resolution / first prompt / first write.
preflight_gate() {
  [[ "$FINDINGS_BLOCK_COUNT" -gt 0 ]] || return 0
  if [[ "$INTERACTIVE" -eq 1 ]]; then
    printf '\n\033[31mPre-flight halted\033[0m — %d blocking problem(s) above. Resolve them (or pass an offered override flag) and re-run; no files were written.\n' "$FINDINGS_BLOCK_COUNT" >&2
  else
    printf '\n\033[31mPre-flight failed\033[0m — %d blocking problem(s) above. Non-interactive run; refusing to proceed on defaults. No files were written.\n' "$FINDINGS_BLOCK_COUNT" >&2
  fi
  exit 1
}

preflight_run
preflight_gate

# Resolve owner/repo via gh. Deferred until after the pre-flight gate so that a
# missing/unauthenticated gh surfaces as a pre-flight finding (above) rather than
# a hard exit here — the gate has now confirmed gh is installed + authenticated.
if ! REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)"; then
  echo "error: could not resolve owner/repo via 'gh repo view'. Are you authenticated ('gh auth login') and does this repo have a GitHub remote?" >&2
  exit 1
fi
OWNER="${REPO%%/*}"
# Lazy: only paid for when SCOPE resolution / org detection actually needs it.
# Empty string ≠ "User"; check OWNER_TYPE_RESOLVED before reading OWNER_TYPE.
OWNER_TYPE=""
OWNER_TYPE_RESOLVED=0
detect_owner_type() {
  if [[ "$OWNER_TYPE_RESOLVED" -eq 0 ]]; then
    OWNER_TYPE="$(gh api "users/$OWNER" --jq .type 2>/dev/null || true)"
    OWNER_TYPE_RESOLVED=1
  fi
}
echo "Wiring Flywheel into $REPO..."

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
  sed -i.bak "s|__FLYWHEEL_VERSION__|${FLYWHEEL_VERSION}|g" "$dest" && rm -f "$dest.bak"
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
    # is current. The current `point-source/flywheel@<ref>` form (composite
    # action, v2+) is matched first; the legacy reusable-workflow form
    # (`point-source/flywheel/.github/workflows/...@<ref>`, v1) is also
    # matched so a v1 → v2 upgrade run on an adopter still on the old
    # templates still detects drift.
    existing_ref="$(grep -m1 -oE 'point-source/flywheel(/\.github/workflows/[a-z]+\.yml)?@[^ ]+' "$dest" 2>/dev/null | head -n1 | sed -E 's|.*@||' || true)"
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

# 2.5 Merge drivers for derived artifacts (CHANGELOG.md, release_files paths).
#
# Two pieces are needed to make `git merge` apply a custom driver: a
# `.gitattributes` rule mapping the path to a driver name (committed —
# travels with clones), and a `merge.<name>.driver` git config entry
# mapping the name to a command (per-clone — does NOT travel). Without
# both, git silently falls back to the default text merge.
#
# CI registers the same drivers in .git/info/attributes at workflow time
# (see flywheel-push.yml), so the back-merge step works regardless of
# whether the adopter committed the .gitattributes lines. Writing them
# here is for local devs who do `git pull main` or otherwise merge
# locally — without these, they'd hit textual conflicts on CHANGELOG.md
# even though CI handles them cleanly. See issue #112.
ATTR_BEGIN="# >>> flywheel: managed merge-driver attributes (do not edit) >>>"
ATTR_END="# <<< flywheel: managed merge-driver attributes <<<"
ATTR_BLOCK="$ATTR_BEGIN
CHANGELOG.md merge=flywheel-changelog
# Add a line per release_files entry from .flywheel.yml, e.g.:
#   pubspec.yaml merge=flywheel-release-file
$ATTR_END"

if [[ -f .gitattributes ]] && grep -qF "$ATTR_BEGIN" .gitattributes; then
  # Strip the existing managed block (begin-marker line through end-marker
  # line, inclusive). sed -i.bak is portable across BSD (macOS) and GNU.
  sed -i.bak '/^# >>> flywheel: managed merge-driver attributes/,/^# <<< flywheel: managed merge-driver attributes/d' .gitattributes
  rm -f .gitattributes.bak
  refreshed=1
else
  refreshed=0
fi
# Ensure the file ends in a newline before appending so the block sits on
# its own line. `tail -c 1` of a newline-terminated file is "" via command
# substitution (trailing newline stripped); a non-empty result means the
# file's last byte is some non-newline char and we need to insert a break.
if [[ -f .gitattributes && -s .gitattributes ]] && [[ "$(tail -c 1 .gitattributes)" != "" ]]; then
  printf '\n' >> .gitattributes
fi
printf '%s\n' "$ATTR_BLOCK" >> .gitattributes
if [[ $refreshed -eq 1 ]]; then
  echo "  refreshed Flywheel block in .gitattributes"
else
  echo "  wrote Flywheel block to .gitattributes"
fi

# Register the per-clone driver bindings. Idempotent — `git config` overwrites
# the same key, so re-running init.sh just re-registers the same driver.
git config merge.flywheel-changelog.name "Flywheel CHANGELOG regenerator" >/dev/null
# Direct redirect to "%A": git runs the driver via `sh -c`, which expands
# variables in the value before exec. The earlier `bash -c "... > \"$1\"" -- %A`
# form was broken — the outer sh expanded `$1` (empty in its context) before
# reaching the inner bash, so the script reduced to `... > ""` and failed
# silently. Single-layer redirect is correctly quoted by the shell git uses.
# See #119.
git config merge.flywheel-changelog.driver \
  'npx --yes conventional-changelog-cli@5 -p angular -r 0 > "%A"' >/dev/null
git config merge.flywheel-release-file.name "Flywheel release-file (keep ours)" >/dev/null
git config merge.flywheel-release-file.driver true >/dev/null
echo "  registered Flywheel merge drivers in .git/config"

# 3. App-token secrets.
#
# SCOPE controls where the credentials live:
#   repo — Variable + Secret on $REPO (default; isolates per repo)
#   org  — Variable + Secret on $OWNER with visibility=all, so every repo
#          in the org inherits them (matches an org-installed App). The
#          gh token must have admin:org for org-level writes/reads.
#
# Workflows reference vars.FLYWHEEL_GH_APP_ID / secrets.FLYWHEEL_GH_APP_PRIVATE_KEY
# and GitHub resolves repo → org automatically, so the workflow templates
# don't need to know which scope was used.

write_app_id_var() {
  local app_id="$1"
  if [[ "$SCOPE" == "org" ]]; then
    gh variable set FLYWHEEL_GH_APP_ID --body "$app_id" --org "$OWNER" --visibility all
  else
    gh variable set FLYWHEEL_GH_APP_ID --body "$app_id" --repo "$REPO"
  fi
}

write_app_key_secret() {
  if [[ "$SCOPE" == "org" ]]; then
    gh secret set FLYWHEEL_GH_APP_PRIVATE_KEY --org "$OWNER" --visibility all
  else
    gh secret set FLYWHEEL_GH_APP_PRIVATE_KEY --repo "$REPO"
  fi
}

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
  local repo_name="${REPO##*/}"
  detect_owner_type
  local org_flag=""
  if [[ "$OWNER_TYPE" == "Organization" ]]; then
    org_flag="--org"
  fi
  echo
  echo "  Creating a GitHub App named 'Flywheel for $repo_name'..."
  local result
  if ! result="$(python3 "$create_script" "$OWNER" $org_flag --app-name "Flywheel for $repo_name")"; then
    echo "  error: App creation failed." >&2
    return 1
  fi
  local app_id pem html_url
  app_id="$(echo "$result" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')"
  pem="$(echo "$result" | python3 -c 'import json,sys;print(json.load(sys.stdin)["pem"])')"
  html_url="$(echo "$result" | python3 -c 'import json,sys;print(json.load(sys.stdin)["html_url"])')"
  CREATED_APP_ID="$app_id"
  # The App ID is public information (visible on the App's settings page) so
  # we store it as a Variable, not a Secret. Scope (repo vs org) follows $SCOPE.
  # init.sh reads it back on re-run for apply-rulesets.sh --app-id.
  write_app_id_var "$app_id" || {
    echo "  error: could not set FLYWHEEL_GH_APP_ID variable at scope=$SCOPE." >&2
    return 1
  }
  printf '%s' "$pem" | write_app_key_secret
  echo "  set FLYWHEEL_GH_APP_ID variable and FLYWHEEL_GH_APP_PRIVATE_KEY secret (scope=$SCOPE)."
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
      echo "  empty App ID — skipping FLYWHEEL_GH_APP_ID variable."
    else
      CREATED_APP_ID="$app_id"
      write_app_id_var "$app_id" || {
        echo "  error: could not set FLYWHEEL_GH_APP_ID variable at scope=$SCOPE." >&2
        return 1
      }
      echo "  set FLYWHEEL_GH_APP_ID variable (scope=$SCOPE)."
    fi
  fi
  if [[ "$has_app_key" -eq 0 ]]; then
    read -r -u 3 -p "  Path to private-key PEM file: " pem_path
    if [[ -z "$pem_path" ]]; then
      echo "  empty path — skipping FLYWHEEL_GH_APP_PRIVATE_KEY secret."
    elif [[ ! -f "$pem_path" ]]; then
      echo "  error: PEM file not found at '$pem_path' — skipping FLYWHEEL_GH_APP_PRIVATE_KEY secret." >&2
    else
      write_app_key_secret < "$pem_path"
      echo "  set FLYWHEEL_GH_APP_PRIVATE_KEY secret (scope=$SCOPE)."
    fi
  fi
}

if [[ "$SKIP_SECRETS" -eq 1 ]]; then
  echo "  --skip-secrets set; not touching App credentials."
else
  # Repo-level lookup first (cheapest — no admin:org needed). If anything is
  # missing AND the owner is an Organization, also probe org-level so a
  # re-run from a repo whose creds live on the org doesn't double-prompt.
  existing_vars="$(gh variable list --json name -q '.[].name' 2>/dev/null || true)"
  existing_secrets="$(gh secret list --json name -q '.[].name' 2>/dev/null || true)"
  has_app_id=0; has_app_key=0
  app_id_found_at=""; app_key_found_at=""
  if echo "$existing_vars" | grep -qx "FLYWHEEL_GH_APP_ID"; then
    has_app_id=1; app_id_found_at="repo"
  fi
  if echo "$existing_secrets" | grep -qx "FLYWHEEL_GH_APP_PRIVATE_KEY"; then
    has_app_key=1; app_key_found_at="repo"
  fi

  if [[ "$has_app_id" -eq 0 || "$has_app_key" -eq 0 ]]; then
    detect_owner_type
    if [[ "$OWNER_TYPE" == "Organization" ]]; then
      org_vars="$(gh variable list --org "$OWNER" --json name -q '.[].name' 2>/dev/null || true)"
      org_secrets="$(gh secret list --org "$OWNER" --json name -q '.[].name' 2>/dev/null || true)"
      if [[ "$has_app_id" -eq 0 ]] && echo "$org_vars" | grep -qx "FLYWHEEL_GH_APP_ID"; then
        has_app_id=1; app_id_found_at="org"
      fi
      if [[ "$has_app_key" -eq 0 ]] && echo "$org_secrets" | grep -qx "FLYWHEEL_GH_APP_PRIVATE_KEY"; then
        has_app_key=1; app_key_found_at="org"
      fi
    fi
  fi

  if [[ "$has_app_id" -eq 1 && "$has_app_key" -eq 1 ]]; then
    if [[ "$app_id_found_at" == "$app_key_found_at" ]]; then
      echo "  FLYWHEEL_GH_APP_ID variable + FLYWHEEL_GH_APP_PRIVATE_KEY secret already set ($app_id_found_at-level)."
    else
      echo "  FLYWHEEL_GH_APP_ID set at ${app_id_found_at}-level, FLYWHEEL_GH_APP_PRIVATE_KEY at ${app_key_found_at}-level — workflows will prefer the repo-level value when both exist."
    fi
  elif [[ "$INTERACTIVE" -eq 0 ]]; then
    echo "  non-interactive shell — skipping App-credential prompts. Set them manually:"
    if [[ "$SCOPE" == "org" ]]; then
      echo "    gh variable set FLYWHEEL_GH_APP_ID --body '<your-app-id>' --org $OWNER --visibility all"
      echo "    gh secret set FLYWHEEL_GH_APP_PRIVATE_KEY < /path/to/private-key.pem --org $OWNER --visibility all"
    else
      echo "    gh variable set FLYWHEEL_GH_APP_ID --body '<your-app-id>' --repo $REPO"
      echo "    gh secret set FLYWHEEL_GH_APP_PRIVATE_KEY < /path/to/private-key.pem --repo $REPO"
    fi
  else
    # Resolve SCOPE before the App-source prompt so write_app_id_var /
    # write_app_key_secret know where to write. If the owner is a User
    # account, org-level vars/secrets don't exist on GitHub at all, so
    # we silently lock to repo. If --scope was set explicitly, honor it.
    if [[ -z "$SCOPE" ]]; then
      detect_owner_type
      if [[ "$OWNER_TYPE" == "Organization" ]]; then
        echo
        echo "  Where should the credentials live?"
        echo "    1) Repo $REPO only (default)"
        echo "    2) Org-wide ($OWNER) — visibility=all, shared across every repo in the org"
        echo "       (requires an admin:org gh token; useful when one App serves many repos)"
        read -r -u 3 -p "  Selection [1/2] (default 1): " scope_choice
        case "${scope_choice:-1}" in
          1|"") SCOPE="repo" ;;
          2) SCOPE="org" ;;
          *) echo "  invalid selection — defaulting to repo." >&2; SCOPE="repo" ;;
        esac
      else
        SCOPE="repo"
      fi
    elif [[ "$SCOPE" == "org" ]]; then
      detect_owner_type
      if [[ "$OWNER_TYPE" != "Organization" ]]; then
        echo "  warning: --scope org requested but $OWNER is not an Organization — falling back to repo scope." >&2
        SCOPE="repo"
      fi
    fi

    echo
    echo "  Flywheel needs a GitHub App for installation tokens. Pick a setup path:"
    echo "    1) Create the App for me  — opens browser, ~30s round-trip"
    echo "    2) I have an App already — paste credentials manually"
    echo "    3) Skip — I'll set the App credentials later"
    read -r -u 3 -p "  Selection [1/2/3] (default 1): " app_choice
    case "${app_choice:-1}" in
      1)
        if ! create_app_via_manifest; then
          echo "  Falling back to manual prompts."
          prompt_existing_app_credentials
        fi
        ;;
      2) prompt_existing_app_credentials ;;
      3) echo "  Skipped — set FLYWHEEL_GH_APP_ID variable and FLYWHEEL_GH_APP_PRIVATE_KEY secret before any Flywheel workflow runs." ;;
      *) echo "  invalid selection — skipping." ;;
    esac
  fi
fi

# 4. Apply rulesets. The managed-branches ruleset includes a {type: deletion}
# rule that prevents GitHub's auto-delete-on-merge from clobbering long-lived
# stream branches (develop, customer-acme, etc.) when a promotion PR or
# stream-targeted PR merges. apply-rulesets.sh also flips delete_branch_on_merge
# on as part of the same run, so the two can never be on in the wrong order
# (#60, #94).
if [[ "$SKIP_RULESETS" -eq 0 && -x "${SCRIPT_DIR:-}/apply-rulesets.sh" ]]; then
  # Recover App ID for --app-id from the variable written on first-run.
  # Without --app-id, apply-rulesets.sh PUTs an empty bypass_actors and the
  # App loses its bypass entry, breaking semantic-release pushes on re-runs.
  # Cheap and non-interactive — runs regardless of yn so the "skipped" hint
  # below also includes --app-id when known. Try repo-level first (matches
  # the historical default); fall back to org-level if the owner is an
  # Organization, so re-runs on an org-scoped install still find the value.
  if [[ -z "${CREATED_APP_ID:-}" ]]; then
    CREATED_APP_ID="$(gh variable get FLYWHEEL_GH_APP_ID --repo "$REPO" 2>/dev/null || true)"
    if [[ -z "$CREATED_APP_ID" ]]; then
      detect_owner_type
      if [[ "$OWNER_TYPE" == "Organization" ]]; then
        CREATED_APP_ID="$(gh variable get FLYWHEEL_GH_APP_ID --org "$OWNER" 2>/dev/null || true)"
      fi
    fi
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
    # Prompt fallback if the variable is missing (e.g. user deleted it manually).
    # The non-interactive case falls through to the warning below.
    if [[ -z "${CREATED_APP_ID:-}" && "$INTERACTIVE" -eq 1 ]]; then
      echo "  App ID not found in repo or org variables."
      read -r -u 3 -p "  Enter App ID for ruleset bypass-actor configuration (blank to skip): " CREATED_APP_ID
      if [[ -n "$CREATED_APP_ID" ]]; then
        # Cache for next-run readback. Use SCOPE if resolved earlier in this
        # run, otherwise default to repo-level (safe for User-owned repos).
        [[ -z "$SCOPE" ]] && SCOPE="repo"
        write_app_id_var "$CREATED_APP_ID" >/dev/null 2>&1 || true
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
