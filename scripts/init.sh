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
#   --strict              treat warn-severity outstanding items (e.g. deferred
#                         App credentials from --skip-secrets, deferred rulesets
#                         from --skip-rulesets, doctor warnings) as a non-zero
#                         exit. Off by default: deliberate skips/warns keep the
#                         run green; opt in when every warn must be resolved.
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
#   --override-release-conflict
#                         proceed past a detected existing release system
#                         (release-please / semantic-release / a hand-rolled
#                         tag/release step in a workflow). Opt-in and
#                         deliberate; never the default. Interactive only — a
#                         non-interactive run still exits non-zero on the block.
#
# Dependencies: git, gh. (apply-rulesets.sh additionally needs jq + python3
# with PyYAML.)

set -euo pipefail

PRESET=""
SKIP_SECRETS=0
SKIP_RULESETS=0
# Opt-in: when 1, warn-severity outstanding items (deferred App creds / rulesets,
# doctor warnings) elevate the end-of-run exit to non-zero. Default 0 keeps
# deliberate skips green (SPEC.md §spec:setup-exit-contract, strict-mode criterion).
STRICT=0
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
# Opt-in only: set solely by --override-release-conflict. When 1, preflight_block
# demotes the release_conflict block to an advisory warn (never inferred). Read
# via indirect expansion (${!ovar}), so export to mark it used for shellcheck.
export PREFLIGHT_OVERRIDE_release_conflict=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --preset) PRESET="$2"; shift 2 ;;
    --skip-secrets) SKIP_SECRETS=1; shift ;;
    --skip-rulesets) SKIP_RULESETS=1; shift ;;
    --strict) STRICT=1; shift ;;
    --required-checks) REQUIRED_CHECKS="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --override-release-conflict) PREFLIGHT_OVERRIDE_release_conflict=1; shift ;;
    --version) FLYWHEEL_VERSION="$2"; shift 2 ;;
    --scope)
      case "$2" in
        repo|org) SCOPE="$2" ;;
        *) echo "error: --scope must be 'repo' or 'org' (got '$2')" >&2; exit 2 ;;
      esac
      shift 2
      ;;
    -h|--help) sed -n '2,48p' "$0"; exit 0 ;;
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

# Test hooks (FLYWHEEL_ASSUME_INTERACTIVE, FLYWHEEL_PREFLIGHT_INJECT,
# FLYWHEEL_DOCTOR_OVERRIDE) are INERT unless FLYWHEEL_TEST_HOOKS=1 is explicitly
# set. This keeps them usable by the test suite while ensuring a stray or
# maliciously-injected env var in a real adopter run can neither fake a TTY,
# forge/suppress pre-flight findings, nor redirect the end-of-run validation to
# an attacker-controlled script.
FLYWHEEL_TEST_HOOKS="${FLYWHEEL_TEST_HOOKS:-0}"

# Test-only override: force the interactive gate branch without a real TTY. Used
# by the pre-flight test suite to exercise the interactive halt path; never
# honored in normal use (gated on FLYWHEEL_TEST_HOOKS). It does NOT open fd 3, so
# it is only safe on paths that exit before any `read -u 3` — which the pre-flight
# gate (below) does.
if [[ "$FLYWHEEL_TEST_HOOKS" == "1" && "${FLYWHEEL_ASSUME_INTERACTIVE:-0}" == "1" ]]; then
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
# The detectors register at the seam in preflight_run; the gate below enforces
# the severity-driven control flow.
# ---------------------------------------------------------------------------

# Source the shared finding vocabulary, mirroring doctor.sh: locate it next to
# this script, else fetch it. The fetch URL is derived from TEMPLATES_BASE so the
# vocabulary tracks the SAME ref as the workflow templates (overridable via
# FLYWHEEL_TEMPLATES_BASE) — a curl|bash run pinned to a tag fetches that tag's
# findings.sh, not main, so the gate's contract cannot silently skew. Without the
# library the pre-flight pass cannot emit findings — a hard error.
# shellcheck source=scripts/lib/findings.sh
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/lib/findings.sh" ]]; then
  # shellcheck disable=SC1091
  . "$SCRIPT_DIR/lib/findings.sh"
else
  findings_tmp="$(mktemp)"
  if curl -fsSL "${TEMPLATES_BASE%/templates}/lib/findings.sh" -o "$findings_tmp" 2>/dev/null; then
    # shellcheck disable=SC1090
    . "$findings_tmp"
    rm -f "$findings_tmp"
  else
    rm -f "$findings_tmp"
    echo "error: could not locate or fetch scripts/lib/findings.sh — pre-flight cannot run without it." >&2
    exit 1
  fi
fi

# Resolve owner/repo via gh, NON-FATALLY: a missing/unauthenticated gh leaves
# REPO/OWNER empty and surfaces as a pre-flight finding (preflight_detect_gh_capability)
# plus the gate, rather than a hard exit here. The credentials/App detectors
# consult these during the pass; their gh calls all swallow errors, so empty
# values are safe. A still-empty REPO after the gate (gh confirmed good) is a
# hard error below.
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"
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

# preflight_inject — test/debug hook, INERT unless FLYWHEEL_TEST_HOOKS=1 (so it
# cannot forge or suppress findings in a real adopter run). When enabled and
# FLYWHEEL_PREFLIGHT_INJECT is set, emit each "bucket:severity:message" line
# (newline-separated) as a finding. Read-only; used by the pre-flight test suite
# to drive the gate with synthetic findings.
preflight_inject() {
  [[ "$FLYWHEEL_TEST_HOOKS" == "1" ]] || return 0
  [[ -n "${FLYWHEEL_PREFLIGHT_INJECT:-}" ]] || return 0
  local line bucket severity message rest
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    bucket="${line%%:*}"; rest="${line#*:}"
    severity="${rest%%:*}"; message="${rest#*:}"
    finding "$bucket" "$severity" "$message" || true
  done <<< "${FLYWHEEL_PREFLIGHT_INJECT}"
}

# ---------------------------------------------------------------------------
# Reusable pre-flight credential / GitHub-App state (§spec:preflight-credentials-app).
#
# These globals are the REUSE BOUNDARY for the App-credentials detector below:
# sibling issues #234–242 read them instead of re-probing gh. They are set by
# detect_credentials / detect_app_installation during the pre-flight pass and
# are safe to consult anywhere after preflight_run.
# ---------------------------------------------------------------------------
PREFLIGHT_HAS_APP_ID=0              # 0|1
PREFLIGHT_APP_ID_AT=""             # ""|repo|org
PREFLIGHT_APP_ID_VALUE=""          # numeric App ID when readable
PREFLIGHT_HAS_APP_KEY=0            # 0|1
PREFLIGHT_APP_KEY_AT=""            # ""|repo|org
PREFLIGHT_APP_INSTALLED="unknown"  # yes|no|unknown

# detect_credentials — read-only probe for the App-ID variable and private-key
# secret, repo level first (cheapest, no admin:org), then org level only when
# missing AND the owner is an Organization. This is the single credential probe:
# it populates the PREFLIGHT_* globals that the late credential/ruleset logic
# consumes (so neither re-lists via gh), and emits info-level findings only, so a
# clean greenfield repo yields zero blockers.
# Every gh call swallows errors (2>/dev/null || true) so a missing permission or
# a stub never aborts the run.
detect_credentials() {
  local repo_vars repo_secrets org_vars org_secrets

  # App-ID variable — repo level.
  repo_vars="$(gh variable list --json name -q '.[].name' 2>/dev/null || true)"
  if echo "$repo_vars" | grep -qx "FLYWHEEL_GH_APP_ID"; then
    PREFLIGHT_HAS_APP_ID=1
    PREFLIGHT_APP_ID_AT="repo"
    PREFLIGHT_APP_ID_VALUE="$(gh variable get FLYWHEEL_GH_APP_ID --repo "$REPO" 2>/dev/null || true)"
  fi
  # Private-key secret — repo level.
  repo_secrets="$(gh secret list --json name -q '.[].name' 2>/dev/null || true)"
  if echo "$repo_secrets" | grep -qx "FLYWHEEL_GH_APP_PRIVATE_KEY"; then
    PREFLIGHT_HAS_APP_KEY=1
    PREFLIGHT_APP_KEY_AT="repo"
  fi

  # Org level only when something is still missing and the owner is an org.
  if [[ "$PREFLIGHT_HAS_APP_ID" -eq 0 || "$PREFLIGHT_HAS_APP_KEY" -eq 0 ]]; then
    detect_owner_type
    if [[ "$OWNER_TYPE" == "Organization" ]]; then
      if [[ "$PREFLIGHT_HAS_APP_ID" -eq 0 ]]; then
        org_vars="$(gh variable list --org "$OWNER" --json name -q '.[].name' 2>/dev/null || true)"
        if echo "$org_vars" | grep -qx "FLYWHEEL_GH_APP_ID"; then
          PREFLIGHT_HAS_APP_ID=1
          PREFLIGHT_APP_ID_AT="org"
          PREFLIGHT_APP_ID_VALUE="$(gh variable get FLYWHEEL_GH_APP_ID --org "$OWNER" 2>/dev/null || true)"
        fi
      fi
      if [[ "$PREFLIGHT_HAS_APP_KEY" -eq 0 ]]; then
        org_secrets="$(gh secret list --org "$OWNER" --json name -q '.[].name' 2>/dev/null || true)"
        if echo "$org_secrets" | grep -qx "FLYWHEEL_GH_APP_PRIVATE_KEY"; then
          PREFLIGHT_HAS_APP_KEY=1
          PREFLIGHT_APP_KEY_AT="org"
        fi
      fi
    fi
  fi

  if [[ "$PREFLIGHT_HAS_APP_ID" -eq 1 ]]; then
    finding config info "FLYWHEEL_GH_APP_ID variable found (${PREFLIGHT_APP_ID_AT}-level)"
  else
    finding config info "FLYWHEEL_GH_APP_ID variable not set (setup will provision it)"
  fi
  if [[ "$PREFLIGHT_HAS_APP_KEY" -eq 1 ]]; then
    finding config info "FLYWHEEL_GH_APP_PRIVATE_KEY secret found (${PREFLIGHT_APP_KEY_AT}-level)"
  else
    finding config info "FLYWHEEL_GH_APP_PRIVATE_KEY secret not set (setup will provision it)"
  fi
}

# detect_app_installation — best-effort, false-negative-tolerant check that the
# GitHub App is installed on the owner. The only reliable read-only signal is the
# org installations list, which needs an org owner + admin:org; anything else
# leaves PREFLIGHT_APP_INSTALLED=unknown (we'll confirm during install rather than
# block on a probe we can't trust). Read-only; errors degrade to "unknown".
detect_app_installation() {
  if [[ "$PREFLIGHT_HAS_APP_ID" -eq 0 || -z "$PREFLIGHT_APP_ID_VALUE" ]]; then
    finding instance info "GitHub App installation: no App ID configured yet (setup will create or prompt for the App)"
    return 0
  fi
  detect_owner_type
  if [[ "$OWNER_TYPE" != "Organization" ]]; then
    finding instance info "GitHub App installation: could not verify (best-effort; will confirm during install)"
    return 0
  fi
  local installed_ids
  installed_ids="$(gh api "orgs/$OWNER/installations" --jq '.installations[].app_id' 2>/dev/null || true)"
  if [[ -z "$installed_ids" ]]; then
    # Empty could mean none installed OR the call failed (no admin:org). We can't
    # tell the two apart from a read-only probe, so stay conservative: unknown.
    finding instance info "GitHub App installation: could not verify (best-effort; will confirm during install)"
    return 0
  fi
  # PREFLIGHT_APP_INSTALLED is read only by sibling issues #234–242 (the reuse
  # boundary), not within init — hence the SC2034 suppressions.
  if echo "$installed_ids" | grep -qx "$PREFLIGHT_APP_ID_VALUE"; then
    # shellcheck disable=SC2034
    PREFLIGHT_APP_INSTALLED="yes"
    finding instance info "GitHub App (id ${PREFLIGHT_APP_ID_VALUE}) installed on ${OWNER}"
  else
    # shellcheck disable=SC2034
    PREFLIGHT_APP_INSTALLED="no"
    finding instance warn "GitHub App (id ${PREFLIGHT_APP_ID_VALUE}) not installed on ${OWNER} — install it so installation-token minting works"
  fi
}

# preflight_detect_credentials_app — seam entry point (§spec:preflight-credentials-app).
# Probes App credentials then App installation, setting the reusable PREFLIGHT_*
# globals consumed by sibling issues #234–242. Read-only and ADDITIVE: it runs in
# the pre-flight pass and leaves the late credential/prompt logic untouched.
preflight_detect_credentials_app() {
  detect_credentials
  detect_app_installation
}

# preflight_detect_release_conflict — read-only scan for an existing release
# system that would race flywheel's tag/release creation (SPEC.md
# §spec:preflight-release-conflict). Iterates the adopter's own workflow files
# (skipping flywheel's scaffold and anything referencing point-source/flywheel)
# and emits an instance + block per (file, producer-kind) match via
# preflight_block. Deliberately minimal and biased to FALSE NEGATIVES: it covers
# the systems that actually race flywheel (release-please, a separate
# semantic-release, hand-rolled gh/git/npm producers in push/dispatch workflows)
# rather than auditing every release tool — a missed exotic system is rare and
# caught downstream, whereas a false positive blocks a clean repo for everyone.
#
# _release_conflict_block <producers> <path> — emit the one standard instance +
# block for a file's detected producer(s); all matches in a file share one block,
# since a single conflicting file is one thing for the adopter to fix.
_release_conflict_block() {
  preflight_block release_conflict instance \
    "$1 detected in $2 — it races Flywheel's tag/release creation. Remove or disable it, or re-run with --override-release-conflict."
}
preflight_detect_release_conflict() {
  local path base producers
  for path in .github/workflows/*.yml .github/workflows/*.yaml; do
    [[ -f "$path" ]] || continue
    base="$(basename "$path")"
    # Skip flywheel's own scaffold workflows.
    case "$base" in flywheel-*.yml|flywheel-*.yaml) continue ;; esac
    # Defensive self-exclusion: any workflow wiring up flywheel itself is ours.
    if grep -qiF 'point-source/flywheel' "$path"; then
      continue
    fi

    # Accumulate every producer this file matches, then emit ONE block per file
    # (one finding per file to fix, not one per regex hit).
    producers=""
    # release-please — googleapis/release-please-action or release-please-action.
    grep -qi 'release-please' "$path" && producers+="release-please, "
    # A separate semantic-release (cycjimmy/semantic-release-action or
    # npx semantic-release). flywheel's own files are already excluded above.
    grep -qi 'semantic-release' "$path" && producers+="semantic-release, "
    # Hand-rolled producers only count when the workflow runs on push or
    # workflow_dispatch — the triggers that publish releases on merge/manual run.
    if grep -qE '^[[:space:]]*push:' "$path" || grep -qE '^[[:space:]]*workflow_dispatch:' "$path"; then
      grep -qE 'gh release create' "$path" && producers+="gh release create, "
      # `git tag` only when it CREATES a tag: require a creation flag (-a/-s/-f/-m)
      # or a following tag-name token, so read-only forms (git tag -l / --list /
      # --contains / -n …) don't false-positive — the spec biases to false
      # negatives over blocking a clean repo. `git push --tags|--follow-tags` also
      # publishes tags created elsewhere.
      grep -qE "git tag[[:space:]]+(-[asfm]|[A-Za-z0-9_.\"'\$])|git push[[:space:]]+--(follow-)?tags" "$path" \
        && producers+="git tag, "
      grep -qE 'npm version' "$path" && producers+="npm version, "
    fi

    [[ -n "$producers" ]] && _release_conflict_block "${producers%, }" "$path"
  done
  # A trailing unmatched `grep ... &&` would leave a non-zero status; the gate
  # reads FINDINGS_BLOCK_COUNT, not this return, so end deterministically at 0.
  return 0
}

# preflight_detect_gh_capability — §spec:preflight-gh-capability.
# READ-ONLY probe of gh install + auth state, then the path-specific scope checks
# (which parse the captured `auth_status`). Grants/requests nothing.
preflight_detect_gh_capability() {
  if ! command -v gh >/dev/null 2>&1; then
    finding local-env block "gh (GitHub CLI) is not installed — required to resolve the repository, write App credentials, and apply rulesets (install: https://cli.github.com)"
    return 0
  fi
  # auth_status is captured here and reused below for the path-specific scope
  # checks (which parse its "Token scopes:" line).
  local auth_status
  if ! auth_status="$(gh auth status 2>&1)"; then
    finding local-env block "gh is not authenticated — run 'gh auth login' (setup needs it to resolve the repository and write App credentials)"
    return 0
  fi
  finding local-env info "gh installed and authenticated"

  # Path-specific scope checks (§spec:preflight-gh-capability): probe only the
  # scopes the CHOSEN path (resolved from flags up front) will exercise. Read
  # the classic OAuth token scopes from gh auth state.
  local scopes_line scopes
  # `|| true` is load-bearing: init.sh runs under `set -euo pipefail`, so without
  # it a no-match grep (exit 1) would abort the whole run on a fine-grained PAT /
  # App token — the case handled below. `-m1` stops at the first match.
  scopes_line="$(grep -im1 'Token scopes:' <<<"$auth_status" || true)"
  if [[ -z "$scopes_line" ]]; then
    # No classic "Token scopes:" line means a fine-grained PAT or App token,
    # whose grants aren't expressible as classic scopes. We can't pre-check them,
    # so surface that explicitly (rather than silently skipping) — the credential
    # WRITE helpers fail loudly later if the token's grant is insufficient.
    finding local-env info "gh token scopes could not be read (fine-grained PAT or GitHub App token) — required permissions can't be pre-checked; setup will surface any gap when it writes credentials"
    return 0
  fi
  # Normalize the scope names into a padded, space-delimited set for EXACT-token
  # matching: "Token scopes: 'repo', 'read:org'" -> " repo read:org ". Exact
  # matching is required because ':' is a grep word boundary, so `grep -w 'repo'`
  # would wrongly accept a token carrying only the narrower 'repo:status' scope.
  scopes=" ${scopes_line#*scopes:} "
  scopes="${scopes//[\',]/ }"
  # repo-admin: needed unless BOTH credential writes and ruleset apply are
  # skipped (rulesets are repo-level even under --scope org).
  if [[ "$SKIP_SECRETS" -ne 1 || "$SKIP_RULESETS" -ne 1 ]] && [[ "$scopes" != *" repo "* ]]; then
    finding local-env block "gh token lacks the 'repo' scope (repo-admin) — required later to write the FLYWHEEL_GH_APP_ID variable and FLYWHEEL_GH_APP_PRIVATE_KEY secret and to apply rulesets. Re-auth with: gh auth refresh -s repo"
  fi
  # admin:org: needed when credentials are scoped org-wide. With an explicit
  # --scope org the org write is certain, so a missing admin:org is a block. When
  # the scope is still unresolved (interactive runs pick repo-vs-org at a later
  # prompt) and the owner is an Organization, org is only POSSIBLE — so warn
  # rather than block, to avoid halting an adopter who will choose repo scope.
  if [[ "$scopes" != *" admin:org "* ]]; then
    if [[ "$SCOPE" == "org" ]]; then
      finding local-env block "gh token lacks 'admin:org' — required later to write org-wide (--scope org) credentials: the FLYWHEEL_GH_APP_ID variable and FLYWHEEL_GH_APP_PRIVATE_KEY secret at org level. Re-auth with: gh auth refresh -s admin:org"
    elif [[ -z "$SCOPE" && "$SKIP_SECRETS" -ne 1 ]]; then
      detect_owner_type
      if [[ "$OWNER_TYPE" == "Organization" ]]; then
        finding local-env warn "gh token lacks 'admin:org' — only needed if you choose org-wide credentials at the upcoming prompt (repo-scoped credentials don't need it). If so, re-auth with: gh auth refresh -s admin:org"
      fi
    fi
  fi
  # GitHub-App creation permission: the create-vs-reuse-App choice is interactive
  # and not knowable from a flag at pre-flight time, so it cannot be definitively
  # pre-checked. We deliberately do NOT invent a flag or block speculatively.
  # Creating an App under an Organization effectively requires org-owner /
  # 'admin:org' (covered above); under a User account no extra scope is needed.
  # The de-swallowed credential WRITE (write_app_id_var/write_app_key_secret) is
  # the backstop if the chosen App-creation path exceeds the token's grant.
}

# preflight_run — run every detector and print the pre-flight summary. Detectors
# emit via the shared `finding` (and the preflight_block wrapper added with the
# gate). The summary is the first thing the adopter sees; the gate acts on it
# next.
preflight_run() {
  echo
  echo "Pre-flight checks:"
  # >>> detector seam — add new detectors here >>>
  preflight_detect_gh_capability       # §spec:preflight-gh-capability
  preflight_detect_release_conflict    # §spec:preflight-release-conflict
  preflight_detect_credentials_app     # §spec:preflight-credentials-app
  preflight_inject                     # test-only hook (inert unless FLYWHEEL_TEST_HOOKS=1)
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
# (SPEC §spec:preflight-gate). The --override-release-conflict flag sets the
# token PREFLIGHT_OVERRIDE_release_conflict. <override-token> uses underscores
# (e.g. release_conflict → flag --override-release-conflict).
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

# ---------------------------------------------------------------------------
# Setup outcome tracking (SPEC.md §spec:setup-completion-summary).
#
# Every scaffold step records its real outcome here. The end-of-run summary
# (added by a later workstream) renders these records and derives the
# complete/incomplete verdict. bash 3.2-safe: a single indexed array of
# tab-separated records (label, outcome, bucket, severity, command); finishing
# commands never contain a literal tab. bucket/severity/command are filled in
# by later workstreams and may be empty for now.
# ---------------------------------------------------------------------------
SUMMARY_RECORDS=()

# FORCED_EXIT_STATUS — forced-status seam for print_completion_summary's
# end-of-run exit (SPEC.md §spec:setup-exit-contract). Empty means derive the
# exit code from the completion verdict; a non-empty value (set by a caller with
# a genuine non-zero status to preserve, e.g. the rulesets-apply failure path)
# is honored verbatim after the summary prints.
FORCED_EXIT_STATUS=""

# record_outcome <label> <outcome> [bucket] [severity] [command]
#   outcome is one of: configured | skipped | failed | deferred
record_outcome() {
  local label="$1" outcome="$2" bucket="${3:-}" severity="${4:-}" command="${5:-}"
  SUMMARY_RECORDS+=("${label}"$'\t'"${outcome}"$'\t'"${bucket}"$'\t'"${severity}"$'\t'"${command}")
}

# run_setup_validation — auto-run doctor.sh at the end of the run and fold its
# findings into the completion summary (SPEC.md §spec:setup-auto-validation), so
# init and doctor produce ONE picture of "done". Read-only; never aborts the run.
#
# Prints a "Setup validation" heading, the canonical green/red headline (via
# findings_validation_headline), and doctor's finding lines verbatim (already in
# the shared [bucket]/glyph vocabulary); on an all-green run there are no finding
# lines, only the headline. The block count doctor reported is returned to the
# caller via the global VALIDATION_BLOCKS, keeping this function's stdout purely
# the human-readable section (no machine marker for the caller to re-parse).
#
# Budget rationale (§req:sandbox-ci-budget): $REPO is already resolved, so doctor
# skips its own `gh repo view`; --skip-credentials is passed because init's
# pre-flight already probed the FLYWHEEL_GH_APP_ID/PRIVATE_KEY credentials, and
# re-listing them needs an admin-PAT round trip the run already covered. doctor
# stays read-only. Run identically in interactive and non-interactive runs.
VALIDATION_BLOCKS=0
# Doctor's warn count from the same `DOCTOR_RESULT ... warns=M` trailer. Folded
# into print_completion_summary's warn_count so --strict elevates doctor warnings
# too (SPEC.md §spec:setup-exit-contract).
VALIDATION_WARNS=0
run_setup_validation() {
  VALIDATION_BLOCKS=0
  VALIDATION_WARNS=0
  printf '\nSetup validation:\n'

  # Resolve the doctor command, mirroring the findings.sh source/curl fallback.
  local doctor_cmd="" doctor_tmp=""
  # Test seam: FLYWHEEL_DOCTOR_OVERRIDE points the validation at a stub doctor.
  # INERT in real runs (gated on FLYWHEEL_TEST_HOOKS), exactly like
  # FLYWHEEL_ASSUME_INTERACTIVE / FLYWHEEL_PREFLIGHT_INJECT.
  if [[ "$FLYWHEEL_TEST_HOOKS" == "1" && -n "${FLYWHEEL_DOCTOR_OVERRIDE:-}" ]]; then
    doctor_cmd="$FLYWHEEL_DOCTOR_OVERRIDE"
  elif [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/doctor.sh" ]]; then
    doctor_cmd="$SCRIPT_DIR/doctor.sh"
  else
    doctor_tmp="$(mktemp)"
    if curl -fsSL "${TEMPLATES_BASE%/templates}/doctor.sh" -o "$doctor_tmp" 2>/dev/null; then
      doctor_cmd="$doctor_tmp"
    else
      rm -f "$doctor_tmp"
      doctor_tmp=""
    fi
  fi

  if [[ -z "$doctor_cmd" ]]; then
    # Could not locate or fetch doctor — surface a deferred (non-block) line and
    # skip the rest of validation rather than aborting the run.
    format_finding instance warn "Setup validation — deferred (doctor.sh unavailable)"
    printf '      finish with: scripts/doctor.sh %s\n' "$REPO"
    return 0
  fi

  # Run doctor read-only. Capture stdout + exit code without tripping `set -e`.
  local out=""
  out="$(bash "$doctor_cmd" "$REPO" --skip-credentials --summary 2>/dev/null || true)"
  [[ -n "$doctor_tmp" ]] && rm -f "$doctor_tmp"

  # The `DOCTOR_RESULT blocks=N warns=M` trailer is doctor's last line; read the
  # counts from it and drop it from the finding lines shown to the adopter.
  local blocks=0 warns=0 body
  if [[ "$(printf '%s\n' "$out" | tail -n1)" =~ ^DOCTOR_RESULT\ blocks=([0-9]+)\ warns=([0-9]+)$ ]]; then
    blocks="${BASH_REMATCH[1]}"
    warns="${BASH_REMATCH[2]}"
  fi
  body="$(printf '%s\n' "$out" | grep -vE '^DOCTOR_RESULT blocks=[0-9]+ warns=[0-9]+$' || true)"

  findings_validation_headline "$blocks" "$warns"
  # Print the remaining finding lines verbatim (empty on an all-green run).
  [[ -n "$body" ]] && printf '%s\n' "$body"

  VALIDATION_BLOCKS="$blocks"
  VALIDATION_WARNS="$warns"
}

# print_completion_summary — render the end-of-run outcome summary
# (SPEC.md §spec:setup-completion-summary). Lists every scaffold step init can
# touch with its real outcome, then closes with a complete/incomplete verdict.
# Renders to stdout in the same bucket/severity vocabulary the pre-flight pass
# and doctor.sh speak: `configured` steps print a green check; `deferred`/`failed`
# steps reuse format_finding (so an item reads identically at completion as it
# did at pre-flight) followed by the exact finishing command.
print_completion_summary() {
  local rec label outcome bucket severity command
  local incomplete_count=0
  # warn-severity outstanding items (deliberate deferrals: App creds, rulesets).
  # These never touch incomplete_count / the verdict — they drive the --strict
  # exit only (SPEC.md §spec:setup-exit-contract, strict-mode criterion).
  local warn_count=0

  # One summary, two audiences (SPEC.md §spec:setup-exit-contract). Interactive
  # runs (a real TTY) get today's human prose; non-interactive runs (curl|bash,
  # CI, no TTY — INTERACTIVE -eq 0) get a stable, greppable rendering of the SAME
  # data. The machine path emits one `FLYWHEEL_SETUP_STEP` line per scaffold step
  # and a final `FLYWHEEL_SETUP_RESULT` trailer; the verdict token is derived from
  # the very same incomplete_count that drives the exit code below, so the two can
  # never disagree. This is NOT a divorced second output mode — it is the interactive
  # summary rendered for the reader at hand.
  local machine=0
  [[ "$INTERACTIVE" -eq 0 ]] && machine=1

  if [[ "$machine" -eq 0 ]]; then
    printf '\nFlywheel scaffold written to %s.\n' "$REPO_ROOT"
    printf 'Flywheel setup summary for %s:\n\n' "$REPO"
  fi

  # bash 3.2-safe iteration: guard the empty case so `set -u` does not abort on
  # an unset array expansion.
  if [[ "${#SUMMARY_RECORDS[@]}" -gt 0 ]]; then
    for rec in "${SUMMARY_RECORDS[@]}"; do
      IFS=$'\t' read -r label outcome bucket severity command <<< "$rec"
      if [[ "$machine" -eq 1 ]]; then
        # Machine rendering: one logical line per step. The free-text fields
        # (command, label) come LAST and are double-quoted so a value containing
        # spaces/quotes stays parseable on a single line; embedded double quotes
        # are backslash-escaped. bucket/severity/command stay present with empty
        # values for `configured` steps so the column set is stable to grep/awk.
        local q_command q_label
        q_command="${command//\"/\\\"}"
        q_label="${label//\"/\\\"}"
        printf 'FLYWHEEL_SETUP_STEP outcome=%s bucket=%s severity=%s command="%s" label="%s"\n' \
          "$outcome" "$bucket" "$severity" "$q_command" "$q_label"
      else
        case "$outcome" in
          configured)
            printf '  \033[32m✓\033[0m %s — configured\n' "$label"
            ;;
          *)
            # deferred / failed / skipped: render in the pre-flight vocabulary, then
            # surface the finishing command on the next indented line if present.
            format_finding "$bucket" "$severity" "$label — $outcome"
            [[ -n "$command" ]] && printf '      finish with: %s\n' "$command"
            ;;
        esac
      fi
      # N (the count that drives "incomplete") = records whose outcome is `failed`
      # OR whose severity is `block`. A deliberate skip (deferred warn/info) never
      # counts. SPEC.md §spec:setup-completion-summary: "only a step that was meant
      # to run and failed, or an unresolved block-severity finding, makes the
      # verdict incomplete".
      if [[ "$outcome" == "failed" || "$severity" == "block" ]]; then
        incomplete_count=$((incomplete_count + 1))
      fi
      # warn-severity items (deliberate deferrals like skipped App creds /
      # rulesets) are tallied separately — they fail the run only under --strict.
      if [[ "$severity" == "warn" ]]; then
        warn_count=$((warn_count + 1))
      fi
    done
  fi

  # Auto-run doctor and fold its blocking findings into the verdict so the run is
  # "complete" only when BOTH the scaffold steps AND doctor are clean
  # (SPEC.md §spec:setup-auto-validation). run_setup_validation prints the
  # "Setup validation" section to stdout and sets the global VALIDATION_BLOCKS to
  # doctor's block count; add that to incomplete_count.
  run_setup_validation
  incomplete_count=$((incomplete_count + VALIDATION_BLOCKS))
  # Doctor's warn count folds into warn_count so --strict elevates doctor
  # warnings the same as deferred scaffold items; never into incomplete_count.
  warn_count=$((warn_count + VALIDATION_WARNS))

  if [[ "$machine" -eq 1 ]]; then
    # Machine trailer: the verdict token is derived from the SAME incomplete_count
    # that selects the exit code below, so verdict=incomplete <=> non-zero exit.
    local verdict="complete"
    [[ "$incomplete_count" -gt 0 ]] && verdict="incomplete"
    # verdict=/items= keep their block/failure-driven meaning (warns never move
    # them). strict=/warn_items= are additive: they expose the strict-mode inputs
    # so a consumer can see why the exit code went non-zero under --strict.
    printf 'FLYWHEEL_SETUP_RESULT verdict=%s items=%d strict=%d warn_items=%d\n' \
      "$verdict" "$incomplete_count" "$STRICT" "$warn_count"
  elif [[ "$incomplete_count" -gt 0 ]]; then
    printf '\n\033[1;31mincomplete — %d item(s) remain\033[0m\n' "$incomplete_count"
  else
    printf '\n\033[1;32mcomplete\033[0m\n'
    printf 'Next: commit + push the new files and open a smoke-test PR to verify the wiring.\n'
  fi

  # End-of-run exit contract (SPEC.md §spec:setup-exit-contract). The function
  # owns the script's terminal exit so the code reflects the verdict on the same
  # severity vocabulary the summary speaks. This is strictly ADDITIVE beneath the
  # pre-flight gate's block-exit (§spec:preflight-gate), which fires earlier.
  #
  # FORCED_EXIT_STATUS seam: a caller that already has a genuine non-zero status
  # to preserve (e.g. the rulesets-apply failure path) sets it before calling, so
  # the exact apply-rulesets status survives rather than being flattened to 1.
  # Empty (the normal case) means derive the code from the verdict: non-zero when
  # any step failed or an unresolved block remains, zero otherwise (deliberate
  # deferrals are complete). Explicit `exit` keeps the EXIT-trap status gotcha at
  # bay — the genuine terminal action, never a fall-through.
  #
  # Strict-mode criterion: --strict (STRICT=1) elevates warn-severity outstanding
  # items (warn_count) to a non-zero exit. Without it, warns never fail the run —
  # most adopters deliberately defer steps, so the default stays green and strict
  # is opt-in (SPEC.md §spec:setup-exit-contract, "Why a strict mode…"). This
  # affects the EXIT CODE only; the verdict text/machine fields are unchanged.
  if [[ -n "$FORCED_EXIT_STATUS" ]]; then
    exit "$FORCED_EXIT_STATUS"
  elif [[ "$incomplete_count" -gt 0 ]]; then
    exit 1
  elif [[ "$STRICT" -eq 1 && "$warn_count" -gt 0 ]]; then
    exit 1
  else
    exit 0
  fi
}

# gh is confirmed installed + authenticated by the gate above. REPO/OWNER and
# detect_owner_type were resolved non-fatally before the pass (so the
# credentials/App detectors could consult them); a still-empty REPO now means the
# repo has no GitHub remote, or gh repo view failed — a hard error.
if [[ -z "$REPO" ]]; then
  echo "error: could not resolve owner/repo via 'gh repo view'. Are you authenticated ('gh auth login') and does this repo have a GitHub remote?" >&2
  exit 1
fi
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
  record_outcome ".flywheel.yml preset" configured
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
  record_outcome ".flywheel.yml preset" configured
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
# Both workflow files are present after the loop (written, force-overwritten, or
# left in place), so the step is configured regardless of which branch each took.
record_outcome "PR + push workflow files" configured

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
record_outcome ".gitattributes + merge drivers" configured

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

# app_creds_finish_cmd <scope> — emit the exact gh commands that set the App
# credentials (the FLYWHEEL_GH_APP_ID variable + FLYWHEEL_GH_APP_PRIVATE_KEY
# secret) at the given scope (org|repo). Single source of truth for the
# finishing command recorded against every deferred/failed App-credential
# outcome; $REPO/$OWNER expand at call time.
app_creds_finish_cmd() {
  if [[ "$1" == "org" ]]; then
    printf '%s' "gh variable set FLYWHEEL_GH_APP_ID --body '<your-app-id>' --org $OWNER --visibility all && gh secret set FLYWHEEL_GH_APP_PRIVATE_KEY < /path/to/private-key.pem --org $OWNER --visibility all"
  else
    printf '%s' "gh variable set FLYWHEEL_GH_APP_ID --body '<your-app-id>' --repo $REPO && gh secret set FLYWHEEL_GH_APP_PRIVATE_KEY < /path/to/private-key.pem --repo $REPO"
  fi
}

if [[ "$SKIP_SECRETS" -eq 1 ]]; then
  echo "  --skip-secrets set; not touching App credentials."
  # SCOPE is not yet resolved this early; default to the repo form (matches the
  # non-interactive branch's fallback below).
  app_creds_cmd="$(app_creds_finish_cmd repo)"
  record_outcome "App credentials" deferred config warn "$app_creds_cmd"
else
  # Reuse the pre-flight credential probe (detect_credentials) instead of
  # re-listing variables/secrets: the pass already ran the repo-then-org lookup
  # and stored the result in PREFLIGHT_*, so consuming it here avoids 2–6
  # redundant gh API round-trips per run (this is the reuse boundary
  # detect_credentials documents).
  has_app_id="$PREFLIGHT_HAS_APP_ID"; has_app_key="$PREFLIGHT_HAS_APP_KEY"
  app_id_found_at="$PREFLIGHT_APP_ID_AT"; app_key_found_at="$PREFLIGHT_APP_KEY_AT"

  if [[ "$has_app_id" -eq 1 && "$has_app_key" -eq 1 ]]; then
    if [[ "$app_id_found_at" == "$app_key_found_at" ]]; then
      echo "  FLYWHEEL_GH_APP_ID variable + FLYWHEEL_GH_APP_PRIVATE_KEY secret already set ($app_id_found_at-level)."
    else
      echo "  FLYWHEEL_GH_APP_ID set at ${app_id_found_at}-level, FLYWHEEL_GH_APP_PRIVATE_KEY at ${app_key_found_at}-level — workflows will prefer the repo-level value when both exist."
    fi
    record_outcome "App credentials" configured
  elif [[ "$INTERACTIVE" -eq 0 ]]; then
    # Derive the displayed hint from app_creds_finish_cmd so the command form
    # lives in exactly one place (it is also what gets recorded below).
    app_creds_cmd="$(app_creds_finish_cmd "$SCOPE")"
    echo "  non-interactive shell — skipping App-credential prompts. Set them manually:"
    echo "    $app_creds_cmd"
    record_outcome "App credentials" deferred config warn "$app_creds_cmd"
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

    # Finishing command for any deferred/failed App-credential outcome below,
    # in the same form the non-interactive branch prints, keyed off the now-
    # resolved SCOPE so it's copy-pasteable.
    app_creds_cmd="$(app_creds_finish_cmd "$SCOPE")"

    echo
    echo "  Flywheel needs a GitHub App for installation tokens. Pick a setup path:"
    echo "    1) Create the App for me  — opens browser, ~30s round-trip"
    echo "    2) I have an App already — paste credentials manually"
    echo "    3) Skip — I'll set the App credentials later"
    read -r -u 3 -p "  Selection [1/2/3] (default 1): " app_choice
    case "${app_choice:-1}" in
      1)
        if create_app_via_manifest; then
          record_outcome "App credentials" configured
        else
          echo "  Falling back to manual prompts."
          # Only the credential-WRITE failures inside the helper return non-zero;
          # the empty-input/skip paths return success, so a non-zero here is a
          # genuine write failure.
          if prompt_existing_app_credentials; then
            record_outcome "App credentials" configured
          else
            record_outcome "App credentials" failed config block "$app_creds_cmd"
          fi
        fi
        ;;
      2)
        if prompt_existing_app_credentials; then
          record_outcome "App credentials" configured
        else
          record_outcome "App credentials" failed config block "$app_creds_cmd"
        fi
        ;;
      3)
        echo "  Skipped — set FLYWHEEL_GH_APP_ID variable and FLYWHEEL_GH_APP_PRIVATE_KEY secret before any Flywheel workflow runs."
        record_outcome "App credentials" deferred config warn "$app_creds_cmd"
        ;;
      *)
        echo "  invalid selection — skipping."
        record_outcome "App credentials" deferred config warn "$app_creds_cmd"
        ;;
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
    # Reuse the App-ID value the pre-flight probe already read (repo- or
    # org-level) instead of re-fetching it with another gh call. Absence is
    # legitimately non-fatal (the variable is expected to be missing on a first
    # run); a real scope gap is surfaced up front by the pre-flight scope block
    # and loudly by the credential WRITE helpers, never hidden here.
    CREATED_APP_ID="$PREFLIGHT_APP_ID_VALUE"
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
        # De-swallowed credential WRITE (§spec:preflight-gh-capability): a
        # scope/permission failure here must surface, not vanish behind
        # `|| true`. The cache-write is non-essential to this run (the App ID is
        # still passed via --app-id below), so we warn rather than abort — but
        # we no longer hide the gh error.
        if ! write_app_id_var "$CREATED_APP_ID"; then
          echo "  warning: could not cache FLYWHEEL_GH_APP_ID variable (check 'repo'/'admin:org' scope) — continuing with --app-id only." >&2
        fi
      fi
    fi
    if [[ -z "${CREATED_APP_ID:-}" ]]; then
      echo "  warning: no App ID available — apply-rulesets.sh will run without --app-id, leaving bypass_actors empty. Re-run scripts/apply-rulesets.sh $REPO --app-id <id> manually after this completes." >&2
    fi
    args=("$REPO")
    [[ -n "$REQUIRED_CHECKS" ]] && args+=(--required-checks "$REQUIRED_CHECKS")
    [[ -n "${CREATED_APP_ID:-}" ]] && args+=(--app-id "$CREATED_APP_ID")
    # Record the apply outcome. On a non-zero exit, record `failed`, then render
    # the completion summary BEFORE exiting — the spec requires a failed step to
    # appear in the summary with an "incomplete" verdict
    # (SPEC.md §spec:setup-completion-summary), so the summary must print ahead of
    # the exit. The genuine apply-rulesets status is preserved via the
    # FORCED_EXIT_STATUS seam: print_completion_summary now owns the terminal exit
    # (§spec:setup-exit-contract) and honors the forced status after printing, so
    # the failure is not silently swallowed.
    rulesets_status=0
    "$SCRIPT_DIR/apply-rulesets.sh" "${args[@]}" || rulesets_status=$?
    if [[ "$rulesets_status" -eq 0 ]]; then
      record_outcome "Branch + tag protection rulesets" configured
    else
      record_outcome "Branch + tag protection rulesets" failed instance block "scripts/apply-rulesets.sh $REPO${CREATED_APP_ID:+ --app-id $CREATED_APP_ID}"
      FORCED_EXIT_STATUS="$rulesets_status"
      print_completion_summary
    fi
  else
    # One string for both the printed hint and the recorded finishing command,
    # so they can never drift.
    rulesets_cmd="scripts/apply-rulesets.sh $REPO${CREATED_APP_ID:+ --app-id $CREATED_APP_ID}"
    echo "  skipped ruleset apply. Run later with: $rulesets_cmd"
    record_outcome "Branch + tag protection rulesets" deferred instance warn "$rulesets_cmd"
  fi
elif [[ "$SKIP_RULESETS" -eq 0 ]]; then
  echo "  apply-rulesets.sh not adjacent to init.sh — fetch the repo or run:"
  echo "    curl -fsSL https://raw.githubusercontent.com/point-source/flywheel/main/scripts/apply-rulesets.sh | bash -s -- $REPO"
  record_outcome "Branch + tag protection rulesets" deferred instance warn "curl -fsSL https://raw.githubusercontent.com/point-source/flywheel/main/scripts/apply-rulesets.sh | bash -s -- $REPO"
else
  # --skip-rulesets passed: no apply attempted, deferred to the adopter.
  record_outcome "Branch + tag protection rulesets" deferred instance warn "scripts/apply-rulesets.sh $REPO${CREATED_APP_ID:+ --app-id $CREATED_APP_ID}"
fi

print_completion_summary
