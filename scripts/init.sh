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
#                         which .flywheel.yml to scaffold, described by purpose:
#                           minimal      — a single release line on one branch
#                                          that cuts a release on every
#                                          qualifying push
#                           three-stage  — one release line through staged
#                                          branches (develop → staging → main)
#                                          with promotion PRs between them
#                           multi-stream — two or more independent release lines
#                                          in parallel, each cutting its own
#                                          prereleases with its own version
#                                          suffix and auto-merge rules
#   --skip-secrets        do not prompt for the App's shared credentials
#                         (FLYWHEEL_GH_APP_ID Variable, FLYWHEEL_GH_APP_PRIVATE_KEY Secret)
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

while [[ $# -gt 0 ]]; do
  case "$1" in
    --preset) PRESET="$2"; shift 2 ;;
    --skip-secrets) SKIP_SECRETS=1; shift ;;
    --skip-rulesets) SKIP_RULESETS=1; shift ;;
    --strict) STRICT=1; shift ;;
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
# brownfield_finding. Deliberately minimal and biased to FALSE NEGATIVES: it covers
# the systems that actually race flywheel (release-please, a separate
# semantic-release, hand-rolled gh/git/npm producers in push/dispatch workflows)
# rather than auditing every release tool — a missed exotic system is rare and
# caught downstream, whereas a false positive blocks a clean repo for everyone.
#
# _release_conflict_block <producers> <path> — emit the one standard instance +
# block for a file's detected producer(s); all matches in a file share one block,
# since a single conflicting file is one thing for the adopter to fix. ALSO stash
# <path> in RELEASE_CONFLICT_PATHS so the resolver (brownfield_resolver_release_conflict)
# can offer to remove exactly the flagged files/dirs — detection runs immediately
# before resolution, so the array is fresh.
_release_conflict_block() {
  brownfield_finding release_conflict yes instance block \
    "$1 detected in $2 — it races Flywheel's tag/release creation. Remove or disable the conflicting workflow (see docs/adopter/setup.md §0.2), then re-run."
  RELEASE_CONFLICT_PATHS+=("$2")
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
    # goreleaser — goreleaser/goreleaser-action or a bare `goreleaser` invocation.
    grep -qi 'goreleaser' "$path" && producers+="goreleaser, "
    # changesets — the changesets/action release step.
    grep -qi 'changesets/action' "$path" && producers+="changesets, "
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

  # Config-file producers at repo root — a goreleaser config or a changesets dir
  # is a positively-attributable prior release system even with no workflow yet.
  for path in .goreleaser.yml .goreleaser.yaml; do
    [[ -f "$path" ]] && _release_conflict_block "goreleaser" "$path"
  done
  # changesets keeps its state in .changeset/config.json; flag the directory as the
  # removable unit (the resolver `git rm -r`s it).
  if [[ -f .changeset/config.json ]]; then
    _release_conflict_block "changesets" ".changeset"
  fi
  # A trailing unmatched `grep ... &&` would leave a non-zero status; the gate
  # reads FINDINGS_BLOCK_COUNT, not this return, so end deterministically at 0.
  return 0
}

# ---------------------------------------------------------------------------
# Brownfield-condition registry (SPEC.md §spec:brownfield-resolution).
#
# Every brownfield hazard a detector CONFIRMS is recorded here so the resolution
# phase (brownfield_resolve, below) can iterate the conditions: enumerate them,
# hard-stop the blocks to the manual §0 guide, and — once #233-3 lands the
# resolvers — offer each a shown-before-applied, per-step opt-in fix. Until then
# every entry hard-stops (block) or is deferred (info).
#
# bash 3.2-safe: a single indexed array of tab-separated records
#   token \t bucket \t severity \t resolvable \t message
# `token` and `resolvable` are forward-compat seams for #233-3: it keys each
# resolver on `token` and acts on `resolvable`. Neither is consulted THIS batch
# (only bucket/severity/message are read by brownfield_resolve and the summary
# bridge) — they are carried now so the detectors need not be re-touched when the
# resolvers land. An empty array — a greenfield repo — makes the resolution phase
# a strict no-op (zero blast radius).
#
# could-not-verify warns (a degraded read, not a confirmed condition) are NOT
# registered: they stay plain `finding ... warn`.
# ---------------------------------------------------------------------------
BROWNFIELD_CONDITIONS=()

# BROWNFIELD_OUTCOMES — what the resolution phase DID with each block condition,
# appended by brownfield_resolve and replayed into the completion summary later by
# brownfield_emit_summary_records. bash 3.2-safe: a single indexed array of
# tab-separated records `token \t outcome \t bucket \t severity \t message`, where
# outcome ∈ resolved|declined|hardstop. It exists separately from
# BROWNFIELD_CONDITIONS because brownfield_resolve runs BEFORE record_outcome is
# defined (see the call seam ~"preflight_run / brownfield_resolve / preflight_gate"),
# so the resolution phase may not call record_outcome directly — it stashes the
# verdict here and the summary bridge translates it once record_outcome exists.
BROWNFIELD_OUTCOMES=()

# RELEASE_CONFLICT_PATHS — the config files / workflow files / dirs the
# release-conflict detector flagged, in flag order. This is the exact removable
# set brownfield_resolver_release_conflict offers to delete (one consolidated
# offer for the whole prior release system). Populated by _release_conflict_block;
# read once by the resolver. Detection runs immediately before resolution, so the
# array is always fresh for the resolver.
RELEASE_CONFLICT_PATHS=()

# brownfield_finding <token> <resolvable> <bucket> <severity> <message>
# Emit a brownfield finding through the shared `finding` vocabulary AND record it
# in BROWNFIELD_CONDITIONS, keeping the registry in lockstep with what the adopter
# sees. Use this — not bare `finding` — for every CONFIRMED brownfield hazard.
brownfield_finding() {
  local token="$1" resolvable="$2" bucket="$3" severity="$4" message="$5"
  finding "$bucket" "$severity" "$message" || return 1
  BROWNFIELD_CONDITIONS+=("${token}"$'\t'"${bucket}"$'\t'"${severity}"$'\t'"${resolvable}"$'\t'"${message}")
}

# preflight_detect_version_tag_shape — read-only scan for pre-existing tags whose
# shape would mislead semantic-release's `v`-prefixed versioning (SPEC.md
# §spec:brownfield-detection). `git tag -l` is the authoritative local source: it
# needs no token (an adopter's clone carries the remote tags), so there is no
# could-not-verify path here — local tags are always observable. When REPO is
# resolved we ALSO fold in remote tags (best-effort, errors swallowed) so a tag
# created on the remote after the local fetch is still seen; the merge is deduped.
#
# Classification (biased to FALSE NEGATIVES — never block a clean repo on an
# exotic tag):
#   ^v[0-9]+\.[0-9]+\.[0-9]+  flywheel/semantic-release v-prefixed -> IGNORE.
#   ^[0-9]+\.[0-9]+(\.[0-9]+)? bare-semver (3.4.2, 2.0)            -> instance+block,
#                             resolvable inline later by re-tagging with a `v`.
#   ^(release|stable|rel|ver|version)[-_/.] (case-insensitive)    -> instance+block,
#                             a named release scheme that needs an adopter baseline
#                             choice and is NOT auto-resolvable.
#   anything else (nightly, latest, feature tags)                 -> IGNORE.
# One block finding per category, listing the offending tag(s) — one thing to fix
# per category, mirroring the release-conflict detector's style.
#
# PREFLIGHT_REMOTE_TAGS memoizes the paginated remote-tag read so the guided-retag
# resolver can reuse it instead of re-issuing `gh api repos/$REPO/tags` — nothing
# mutates remote tags between detection and the resolver (the resolver is what
# pushes them), so the remote set cannot change within a run. The resolver still
# re-reads LOCAL `git tag -l` live (cheap, no token) for idempotency. Mirrors the
# PREFLIGHT_RULESET_* / PREFLIGHT_MANAGED_BRANCHES memoization that conserves the
# adopter's rate limit.
PREFLIGHT_REMOTE_TAGS=""
preflight_detect_version_tag_shape() {
  local tags tag bare_semver="" non_semver=""
  # git tag -l always works in a git repo (no token); never errors the run.
  tags="$(git tag -l 2>/dev/null || true)"
  # Best-effort cross-check of remote tags; merge + dedupe. Swallow all errors so
  # a missing token / network leaves the local-tag result untouched. Stash the
  # remote set for the retag resolver (see PREFLIGHT_REMOTE_TAGS above).
  if [[ -n "${REPO:-}" ]]; then
    PREFLIGHT_REMOTE_TAGS="$(gh api "repos/$REPO/tags" --paginate -q '.[].name' 2>/dev/null || true)"
    tags="$(printf '%s\n%s\n' "$tags" "$PREFLIGHT_REMOTE_TAGS" | sort -u)"
  fi

  while IFS= read -r tag; do
    [[ -n "$tag" ]] || continue
    # v-prefixed semver is greenfield-compatible — ignore.
    [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+ ]] && continue
    if [[ "$tag" =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?$ ]]; then
      # Idempotency: a bare-semver tag whose `v`-prefixed twin already exists in
      # the gathered set (local + remote) is ALREADY resolved — the guided retag
      # (§spec:brownfield-resolvers) is non-destructive and leaves the original in
      # place, so without this skip a re-run after a successful retag would re-flag
      # the same tag forever. Match against the deduped `tags` list with anchors.
      if printf '%s\n' "$tags" | grep -qxF "v$tag"; then
        continue
      fi
      bare_semver+="$tag, "
    elif printf '%s' "$tag" | grep -qiE '^(release|stable|rel|ver|version)[-_/.]'; then
      non_semver+="$tag, "
    fi
    # Anything else is an exotic tag — ignore (false-negative bias).
  done <<<"$tags"

  if [[ -n "$bare_semver" ]]; then
    brownfield_finding tag_shape_bare_semver yes instance block "bare-semver tag(s) ${bare_semver%, } collide with Flywheel's v-prefixed scheme — semantic-release would silently mis-version the first release. Resolvable inline later by re-tagging with a 'v' prefix."
  fi
  if [[ -n "$non_semver" ]]; then
    brownfield_finding tag_shape_non_semver no instance block "non-semver release tag(s) ${non_semver%, } collide with Flywheel's v-prefixed scheme. This needs an adopter baseline choice and is NOT auto-resolvable — pick a starting version before layering Flywheel on."
  fi
  # See preflight_detect_release_conflict: end deterministically at 0; the gate
  # reads FINDINGS_BLOCK_COUNT, not this return.
  return 0
}

# ---------------------------------------------------------------------------
# Brownfield branch-protection helpers (§spec:brownfield-detection).
#
# These two helpers are SHARED reuse boundaries: the branch-protection-bypass
# detector below uses them, and the sibling signed-commit/tag workstream reuses
# the same managed-branch enumeration + parsed ruleset details rather than
# re-probing gh. Keep them standalone, read-only, and error-swallowing.
# ---------------------------------------------------------------------------

# preflight_brownfield_managed_branches — echo (newline-separated) the candidate
# managed branches that EXIST on the remote. The candidate set is flywheel's
# standard topology (develop main staging) because at pre-flight the preset /
# .flywheel.yml is not yet known — we probe the superset and let the caller act
# only on what exists. Existence is tested with the doctor.sh idiom
# (`gh api repos/$REPO/branches/$b`). REPO may be empty (gh unresolved); in that
# case we can't probe the remote, so echo nothing. Read-only; errors swallowed.
# Memoized once per run: both the bypass and signed-commit detectors call this,
# and each probe is 3 gh API calls (develop/main/staging) — without the guard
# that is 6 calls per run against the adopter's rate limit. preflight_run resets
# the flag so a fresh run re-probes.
PREFLIGHT_MANAGED_BRANCHES=""
PREFLIGHT_MANAGED_BRANCHES_READ=0
preflight_brownfield_managed_branches() {
  if [[ $PREFLIGHT_MANAGED_BRANCHES_READ -eq 0 ]]; then
    PREFLIGHT_MANAGED_BRANCHES_READ=1
    if [[ -n "${REPO:-}" ]]; then
      local b found=""
      for b in develop main staging; do
        if gh api "repos/$REPO/branches/$b" >/dev/null 2>&1; then
          found+="${found:+$'\n'}$b"
        fi
      done
      PREFLIGHT_MANAGED_BRANCHES="$found"
    fi
  fi
  [[ -n "$PREFLIGHT_MANAGED_BRANCHES" ]] && printf '%s\n' "$PREFLIGHT_MANAGED_BRANCHES"
  return 0
}

# preflight_brownfield_read_rulesets — list the repo's branch-target rulesets and
# read each one's detail, mirroring doctor.sh's read_ruleset_detail pattern.
# Populates parallel arrays (bash 3.2 compatible — no associative arrays):
#   PREFLIGHT_RULESET_IDS[]     — ruleset id
#   PREFLIGHT_RULESET_DETAILS[] — the ruleset detail JSON (same index as the id)
# and the flag PREFLIGHT_RULESET_UNREADABLE (0|1): set when listing rulesets
# fails (token lacks repo-admin) OR any single ruleset's DETAIL read fails. As in
# doctor.sh, an unreadable ruleset must NEVER collapse into a false "absent"
# verdict — the caller routes the unreadable flag to a could-not-verify warn. The
# parsed details are exposed as globals so the signed-commit workstream can reuse
# them. Read-only; all gh errors swallowed.
PREFLIGHT_RULESET_IDS=()
PREFLIGHT_RULESET_DETAILS=()
PREFLIGHT_TAG_RULESET_IDS=()
PREFLIGHT_TAG_RULESET_DETAILS=()
PREFLIGHT_RULESET_UNREADABLE=0
# Idempotence guard: the branch-protection-bypass and signed-commit detectors
# each call this reader within one preflight_run, but the ruleset list/detail
# reads are identical between them. Once populated this run, skip the (paged) gh
# API calls and reuse the parallel arrays. preflight_run resets the flag to 0 at
# the top so a fresh run re-reads. Without the guard the two detectors would
# double-list rulesets every run.
PREFLIGHT_RULESETS_READ=0
# BYPASS_RULESET_IDS / BYPASS_CLASSIC_BRANCHES — the EXACT edit targets the
# branch-protection-bypass resolver (brownfield_resolver_branch_protection_bypass,
# §spec:brownfield-resolvers) acts on, stashed by the detector below alongside the
# aggregated finding so the resolver never has to re-derive which ruleset to edit:
#   BYPASS_RULESET_IDS[]      — ruleset id(s) that cover an affected branch with a
#                               blocking rule but no App bypass actor (deduped).
#                               These are the ruleset(s) the resolver PUT-edits.
#   BYPASS_CLASSIC_BRANCHES[] — affected branches whose hazard comes from CLASSIC
#                               branch protection (no editable ruleset). Apps can't
#                               be added as classic-protection bypass actors, so the
#                               resolver names these and routes them to manual.
# Reset at the top of the detector each run so a re-run re-derives from live state.
BYPASS_RULESET_IDS=()
BYPASS_CLASSIC_BRANCHES=()
# _preflight_read_ruleset_details <ids-newline-list> <ids-array-name> <details-array-name>
# Read each ruleset id's detail JSON into the named parallel arrays, mirroring
# doctor.sh's read_ruleset_detail: a denied detail read (listing allowed but
# reading one needs repo-admin) sets PREFLIGHT_RULESET_UNREADABLE so an unread
# ruleset never collapses into a false block (doctor.sh #239 logic).
_preflight_read_ruleset_details() {
  local ids="$1" ids_arr="$2" details_arr="$3" rid detail
  while read -r rid; do
    [[ -z "$rid" ]] && continue
    if ! detail="$(gh api "repos/$REPO/rulesets/$rid" 2>/dev/null)"; then
      PREFLIGHT_RULESET_UNREADABLE=1
      continue
    fi
    eval "$ids_arr+=(\"\$rid\")"
    eval "$details_arr+=(\"\$detail\")"
  done <<< "$ids"
}
# Read both branch- AND tag-target rulesets in one list call: the signed-commit
# detector needs tag rulesets (refs/tags/v* signing) and the bypass detector
# needs branch rulesets, so collecting both here lets the signed-commit detector
# reuse the cached tag details instead of re-listing rulesets a second time.
preflight_brownfield_read_rulesets() {
  [[ $PREFLIGHT_RULESETS_READ -eq 1 ]] && return 0
  PREFLIGHT_RULESET_IDS=()
  PREFLIGHT_RULESET_DETAILS=()
  PREFLIGHT_TAG_RULESET_IDS=()
  PREFLIGHT_TAG_RULESET_DETAILS=()
  PREFLIGHT_RULESET_UNREADABLE=0
  PREFLIGHT_RULESETS_READ=1
  [[ -n "${REPO:-}" ]] || return 0
  local rulesets_json branch_ids tag_ids
  if ! rulesets_json="$(gh api "repos/$REPO/rulesets" 2>/dev/null)"; then
    # Listing failed entirely — token can't read rulesets. Mark indeterminate so
    # the caller emits could-not-verify rather than asserting "no protection".
    PREFLIGHT_RULESET_UNREADABLE=1
    return 0
  fi
  branch_ids="$(echo "$rulesets_json" | jq -r '.[]? | select(.target == "branch") | .id' 2>/dev/null || true)"
  _preflight_read_ruleset_details "$branch_ids" PREFLIGHT_RULESET_IDS PREFLIGHT_RULESET_DETAILS
  tag_ids="$(echo "$rulesets_json" | jq -r '.[]? | select(.target == "tag") | .id' 2>/dev/null || true)"
  _preflight_read_ruleset_details "$tag_ids" PREFLIGHT_TAG_RULESET_IDS PREFLIGHT_TAG_RULESET_DETAILS
}

# preflight_brownfield_ref_covered <detail-json> <ref> — print 1 if the ruleset
# detail's conditions.ref_name.include covers <ref> (exact match, ~ALL, or
# ~DEFAULT_BRANCH), else 0. Centralizes the coverage heuristic the bypass and
# signed-commit detectors share. jq is guarded (2>/dev/null) so a malformed /
# non-object detail can't abort under set -e — it simply reads as not-covered.
preflight_brownfield_ref_covered() {
  if echo "$1" | jq -e --arg ref "$2" \
    '[.conditions?.ref_name?.include[]? | select(. == $ref or . == "~ALL" or . == "~DEFAULT_BRANCH")] | length > 0' \
    >/dev/null 2>&1; then
    printf '1\n'
  else
    printf '0\n'
  fi
}

# _bypass_add_ruleset_id <id> — append <id> to BYPASS_RULESET_IDS unless already
# present. Two managed branches can be covered by the SAME ruleset; without this
# dedup the resolver would PUT-edit that ruleset (and re-add the App entry) twice.
_bypass_add_ruleset_id() {
  local id="$1" existing
  for existing in "${BYPASS_RULESET_IDS[@]}"; do
    [[ "$existing" == "$id" ]] && return 0
  done
  BYPASS_RULESET_IDS+=("$id")
}

# preflight_detect_branch_protection_bypass — §spec:brownfield-detection.
# READ-ONLY detector: for each managed branch that exists on the remote, decide
# whether a protection ruleset that would block flywheel's pushes (PR-required,
# no-force-push, or no-deletion) OMITS the flywheel App as a bypass actor. That
# omission is the hazard: the release push and back-merge push the bot performs
# would fail "changes must be made through a pull request". When the App ID is
# configured (PREFLIGHT_APP_ID_VALUE) we look for that exact Integration actor in
# the ruleset's bypass_actors; when the App ID is unknown (greenfield) we fall
# back to "a blocking rule exists and there is NO Integration bypass actor at
# all". Biased to FALSE NEGATIVES: a branch with no protection, or protection
# that already lists the App, emits nothing. When protection can't be read we
# emit a could-not-verify warn (never a false block), mirroring doctor.sh.
preflight_detect_branch_protection_bypass() {
  [[ -n "${REPO:-}" ]] || return 0

  local managed
  managed="$(preflight_brownfield_managed_branches)"
  [[ -n "$managed" ]] || return 0

  preflight_brownfield_read_rulesets

  # Reset the resolver's edit-target stash so it reflects THIS run's live state.
  BYPASS_RULESET_IDS=()
  BYPASS_CLASSIC_BRANCHES=()

  local app_id="${PREFLIGHT_APP_ID_VALUE:-}"
  local affected="" b ref
  while IFS= read -r b; do
    [[ -n "$b" ]] || continue
    ref="refs/heads/$b"
    # Scan readable branch rulesets for one whose conditions include this branch.
    # hazard_ruleset_ids collects the covering ruleset id(s) that carry a blocking
    # rule but lack the App bypass — the exact set the resolver must edit for THIS
    # branch (only stashed if the branch turns out to be affected, below).
    local matched_blocking=0 app_bypass=0 has_integration_bypass=0
    local matched_via_classic=0 hazard_ruleset_ids=""
    local i=0 detail blocking app_actors integ_count rid this_app_bypass
    while [[ $i -lt ${#PREFLIGHT_RULESET_IDS[@]} ]]; do
      detail="${PREFLIGHT_RULESET_DETAILS[$i]}"
      rid="${PREFLIGHT_RULESET_IDS[$i]}"
      i=$((i+1))
      # Skip rulesets that don't cover this branch (shared coverage heuristic).
      [[ "$(preflight_brownfield_ref_covered "$detail" "$ref")" == 1 ]] || continue

      # A "blocking" ruleset carries any rule that stops the bot's direct push:
      # pull_request (changes must go through a PR), non_fast_forward / update
      # (no force-push), or deletion (no branch delete).
      blocking="$(echo "$detail" | jq -r \
        '[.rules[]? | select(.type == "pull_request" or .type == "non_fast_forward" or .type == "update" or .type == "deletion")] | length' 2>/dev/null || true)"
      [[ "${blocking:-0}" -gt 0 ]] || continue
      matched_blocking=1

      # Count Integration-type bypass actors, and whether OUR App is among them.
      integ_count="$(echo "$detail" | jq -r \
        '[.bypass_actors[]? | select(.actor_type == "Integration")] | length' 2>/dev/null || true)"
      [[ "${integ_count:-0}" -gt 0 ]] && has_integration_bypass=1
      this_app_bypass=0
      if [[ -n "$app_id" ]]; then
        app_actors="$(echo "$detail" | jq -r --arg id "$app_id" \
          '[.bypass_actors[]? | select(.actor_type == "Integration" and (.actor_id | tostring) == $id)] | length' 2>/dev/null || true)"
        if [[ "${app_actors:-0}" -gt 0 ]]; then app_bypass=1; this_app_bypass=1; fi
      fi
      # This covering+blocking ruleset is an EDIT TARGET for the branch unless it
      # already lists our App (known App ID) — that one needs no change. Stash its
      # id; it's only promoted into BYPASS_RULESET_IDS if the branch is affected.
      [[ "$this_app_bypass" -eq 0 ]] && hazard_ruleset_ids+="$rid"$'\n'
    done

    # Legacy classic branch-protection fallback: if no ruleset covered the branch
    # but a classic protection rule requires PRs, that also blocks the bot. Classic
    # protection has no per-App bypass we can read here, so treat a readable
    # PR-requiring classic rule as the hazard (rulesets remain the primary surface).
    if [[ $matched_blocking -eq 0 ]]; then
      local classic
      if classic="$(gh api "repos/$REPO/branches/$b/protection" 2>/dev/null)"; then
        local classic_pr
        # `?` suppresses the jq error if the response isn't an object (e.g. the
        # default `[]` stub / a non-protection payload); `|| true` keeps a non-zero
        # jq exit from aborting the run under `set -e`.
        classic_pr="$(echo "$classic" | jq -r '(.required_pull_request_reviews? // null) | if (. != null) then 1 else 0 end' 2>/dev/null || true)"
        if [[ "${classic_pr:-0}" -gt 0 ]]; then
          matched_blocking=1
          matched_via_classic=1
          # Classic protection exposes no Integration bypass list — apps cannot be
          # added as bypass actors there — so this is unambiguously the hazard.
          has_integration_bypass=0
          app_bypass=0
        fi
      fi
    fi

    [[ $matched_blocking -eq 1 ]] || continue

    # Decide hazard. With a known App ID: hazard iff our App is NOT a bypass actor.
    # Without one (greenfield): hazard iff there is NO Integration bypass actor at
    # all (we can't say which App it would be, but any Integration bypass means
    # the adopter has wired SOME app and we don't block — false-negative bias).
    local is_affected=0
    if [[ -n "$app_id" ]]; then
      [[ $app_bypass -eq 0 ]] && is_affected=1
    else
      [[ $has_integration_bypass -eq 0 ]] && is_affected=1
    fi
    [[ $is_affected -eq 1 ]] || continue
    affected+="$b, "

    # Stash the resolver's edit targets for this affected branch. A classic-only
    # hazard has no editable ruleset — route the branch to manual. Otherwise record
    # the covering+blocking ruleset id(s) lacking the App, deduped across branches.
    if [[ $matched_via_classic -eq 1 ]]; then
      BYPASS_CLASSIC_BRANCHES+=("$b")
    else
      while IFS= read -r rid; do
        [[ -n "$rid" ]] || continue
        _bypass_add_ruleset_id "$rid"
      done <<< "$hazard_ruleset_ids"
    fi
  done <<< "$managed"

  if [[ -n "$affected" ]]; then
    brownfield_finding branch_protection_bypass yes instance block "branch protection on ${affected%, } omits the Flywheel App as a bypass actor — the release push and back-merge push will fail \"changes must be made through a pull request\". Add the App (id ${app_id:-<your-app-id>}) as an Integration bypass actor on those branches' ruleset(s)."
  elif [[ $PREFLIGHT_RULESET_UNREADABLE -eq 1 ]]; then
    # Rulesets exist but at least one couldn't be read — never assert absent.
    finding local-env warn "could not verify ${managed//$'\n'/, } branch protection bypass — reading protection requires repo-admin"
  fi
  # See preflight_detect_release_conflict: end deterministically at 0; the gate
  # reads FINDINGS_BLOCK_COUNT, not this return.
  return 0
}

# preflight_detect_signed_commit_requirement — §spec:brownfield-detection.
# READ-ONLY detector: for each managed branch that exists on the remote, decide
# whether a "require signed commits/tags" rule applies that flywheel's App
# identity (semantic-release-bot / github-actions[bot] commits) cannot satisfy —
# in which case the release and back-merge commits the bot pushes are rejected.
# GitHub rulesets express this as a rule with `type == "required_signatures"`;
# the classic branch-protection surface exposes `required_signatures.enabled`.
# We ALSO read tag-target rulesets (which the shared branch-only reader does not
# collect) because semantic-release pushes `v*` tags it cannot sign — a
# required_signatures rule on `refs/tags/v*` is the same hazard. This condition
# is NOT auto-resolvable: disabling a signing requirement is an adopter judgment
# call (a security rule), so it hard-stops to the manual guide in a later batch.
# Biased to FALSE NEGATIVES: no signing rule observed (and reads succeeded)
# emits nothing. When protection can't be read we emit a could-not-verify warn
# (never a false block), mirroring doctor.sh / the bypass detector.
preflight_detect_signed_commit_requirement() {
  [[ -n "${REPO:-}" ]] || return 0

  local managed
  managed="$(preflight_brownfield_managed_branches)"
  [[ -n "$managed" ]] || return 0

  # Shared reader is idempotent per run (PREFLIGHT_RULESETS_READ guard), so this
  # is cheap whether or not the bypass detector already populated the globals.
  preflight_brownfield_read_rulesets

  local affected="" classic_unreadable=0 b ref
  while IFS= read -r b; do
    [[ -n "$b" ]] || continue
    ref="refs/heads/$b"
    local requires_signing=0
    local i=0 detail sig_count
    # Scan readable branch rulesets for one that covers this branch AND carries a
    # required_signatures rule.
    while [[ $i -lt ${#PREFLIGHT_RULESET_IDS[@]} ]]; do
      detail="${PREFLIGHT_RULESET_DETAILS[$i]}"
      i=$((i+1))
      [[ "$(preflight_brownfield_ref_covered "$detail" "$ref")" == 1 ]] || continue
      # `?` + `|| true` keep a malformed/non-object detail from aborting under set -e.
      sig_count="$(echo "$detail" | jq -r \
        '[.rules[]? | select(.type == "required_signatures")] | length' 2>/dev/null || true)"
      [[ "${sig_count:-0}" -gt 0 ]] && requires_signing=1
    done

    # Classic branch-protection fallback: required_signatures.enabled == true.
    if [[ $requires_signing -eq 0 ]]; then
      local classic classic_sig
      if classic="$(gh api "repos/$REPO/branches/$b/protection" 2>/dev/null)"; then
        classic_sig="$(echo "$classic" | jq -r '(.required_signatures?.enabled? // false) | if . == true then 1 else 0 end' 2>/dev/null || true)"
        [[ "${classic_sig:-0}" -gt 0 ]] && requires_signing=1
      else
        # A managed branch whose classic protection we couldn't read (and no
        # ruleset covered it) is indeterminate — never assert absent.
        if [[ $requires_signing -eq 0 ]]; then
          classic_unreadable=1
        fi
      fi
    fi

    [[ $requires_signing -eq 1 ]] && affected+="$b, "
  done <<< "$managed"

  # Tag-target rulesets: semantic-release pushes unsigned `v*` tags, so a
  # required_signatures rule on refs/tags/v* blocks tag creation. The shared
  # reader already collected tag rulesets (and routes any unreadable detail to
  # PREFLIGHT_RULESET_UNREADABLE), so reuse the cached details — no second list.
  local tag_signing=0 i tdetail tsig
  i=0
  while [[ $i -lt ${#PREFLIGHT_TAG_RULESET_IDS[@]} ]]; do
    tdetail="${PREFLIGHT_TAG_RULESET_DETAILS[$i]}"
    i=$((i+1))
    [[ "$(preflight_brownfield_ref_covered "$tdetail" "refs/tags/v*")" == 1 ]] || continue
    tsig="$(echo "$tdetail" | jq -r '[.rules[]? | select(.type == "required_signatures")] | length' 2>/dev/null || true)"
    [[ "${tsig:-0}" -gt 0 ]] && tag_signing=1
  done

  if [[ -n "$affected" || $tag_signing -eq 1 ]]; then
    local what="${affected%, }"
    [[ $tag_signing -eq 1 ]] && what="${affected:+${affected%, }, }refs/tags/v*"
    brownfield_finding signed_commit no instance block "$what requires signed commits/tags, which flywheel's App identity (semantic-release-bot / github-actions[bot] commits) cannot satisfy — the release and back-merge commits (and v* tags) it pushes will be rejected. This is NOT auto-resolvable: disabling a signing requirement is an adopter judgment call, so setup hard-stops to the manual brownfield guide (docs/adopter/setup.md §0)."
  elif [[ $PREFLIGHT_RULESET_UNREADABLE -eq 1 || $classic_unreadable -eq 1 ]]; then
    finding local-env warn "could not verify ${managed//$'\n'/, } signed-commit requirement — reading protection requires repo-admin"
  fi
  # End deterministically at 0; the gate reads FINDINGS_BLOCK_COUNT, not this return.
  return 0
}

# preflight_detect_history_and_prs — §spec:brownfield-detection.
# READ-ONLY, ADVISORY-ONLY detector: surfaces conditions in existing history and
# open PRs that will affect — but not break — flywheel's first release/promotion.
# Unlike the other brownfield detectors, flywheel cannot and should not mutate
# history or others' PRs, so EVERYTHING here is `info` (or a could-not-verify
# `warn` for the token-gated PR read). It emits NO `block` under any circumstance.
#
# History scan (no token; local `git log`):
#   * commits whose subject carries `[skip ci]` / `[ci skip]` — these suppress
#     workflow runs, so legacy occurrences would suppress the first promotion's
#     workflows. One summary info naming the count.
#   * commit subjects that are NOT Conventional Commits — they distort the first
#     semantic-release version computation. ONE summary info (not one per commit);
#     ANY non-conventional subject in the window is enough. Biased to FALSE
#     NEGATIVES: a clean conventional window emits nothing.
# Open-PR scan (token-gated; gh api):
#   * open PRs whose title is NOT Conventional Commits — flywheel rewrites these
#     at cutover. ONE summary info naming the count. When the list can't be read
#     (token gap) a could-not-verify `warn`; when REPO is unresolved, skip the PR
#     read silently (gh-capability already covers an unusable token).
# Bounded window (-n 50) keeps the log scan cheap on large repos.
preflight_detect_history_and_prs() {
  # Conventional Commits shape (case-insensitive): type(optional-scope)!: subject.
  local cc_re='^(feat|fix|chore|docs|refactor|test|ci|build|perf|style|revert)(\([^)]*\))?!?: '

  # --- History scan (local; no token). Swallow errors: a repo with no commits or
  # a non-git dir yields an empty list and emits nothing.
  local subjects skipci_count=0 nonconv_count=0 subject
  subjects="$(git log --format='%s' -n 50 2>/dev/null || true)"
  if [[ -n "$subjects" ]]; then
    while IFS= read -r subject; do
      [[ -n "$subject" ]] || continue
      # `[skip ci]` / `[ci skip]` (case-insensitive) suppresses workflow runs.
      if printf '%s' "$subject" | grep -qiF -e '[skip ci]' -e '[ci skip]'; then
        skipci_count=$((skipci_count + 1))
      fi
      # Non-conventional subject: case-insensitive CC match.
      if ! printf '%s' "$subject" | grep -qiE "$cc_re"; then
        nonconv_count=$((nonconv_count + 1))
      fi
    done <<< "$subjects"
  fi

  if [[ $skipci_count -gt 0 ]]; then
    brownfield_finding history_skip_ci no instance info "$skipci_count recent commit(s) carry [skip ci]/[ci skip] — these suppress workflow runs, so they could suppress the first promotion's workflows. Advisory only: flywheel does not rewrite history."
  fi
  if [[ $nonconv_count -gt 0 ]]; then
    brownfield_finding history_nonconventional no instance info "$nonconv_count of the recent commit(s) are not Conventional Commits — legacy non-conventional history may distort the first semantic-release version computation. Advisory only: flywheel does not rewrite history."
  fi

  # --- Open-PR scan (token-gated). When REPO is unresolved, skip silently:
  # gh-capability already flags an unusable token, and the could-not-verify warn
  # is reserved for a real read failure under a resolved REPO.
  if [[ -n "${REPO:-}" ]]; then
    local pulls titles rewrite_count=0 title
    if pulls="$(gh api "repos/$REPO/pulls?state=open&per_page=100" 2>/dev/null)"; then
      # `?` + `|| true` keep a malformed/empty body from aborting under set -e.
      titles="$(echo "$pulls" | jq -r '.[]?.title // empty' 2>/dev/null || true)"
      while IFS= read -r title; do
        [[ -n "$title" ]] || continue
        if ! printf '%s' "$title" | grep -qiE "$cc_re"; then
          rewrite_count=$((rewrite_count + 1))
        fi
      done <<< "$titles"
      if [[ $rewrite_count -gt 0 ]]; then
        brownfield_finding open_pr_rewrite no instance info "$rewrite_count open PR(s) have non-conventional titles that flywheel will rewrite to Conventional Commits at cutover. Advisory only: review the rewritten titles after setup."
      fi
    else
      finding local-env warn "could not verify open PRs — listing pull requests requires repo access"
    fi
  fi

  # Advisory-only: never emits a block. End deterministically at 0.
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
# emit via the shared `finding`. The summary is the first thing the adopter sees;
# the gate acts on it next.
preflight_run() {
  echo
  echo "Pre-flight checks:"
  # Reset the per-run memoization guards so this run re-probes once, then shares
  # the managed-branch list and ruleset details across the detectors that consult
  # them (rather than each detector re-probing the same gh endpoints).
  PREFLIGHT_MANAGED_BRANCHES_READ=0
  PREFLIGHT_RULESETS_READ=0
  # >>> detector seam — add new detectors here >>>
  preflight_detect_gh_capability       # §spec:preflight-gh-capability
  preflight_detect_release_conflict    # §spec:preflight-release-conflict
  preflight_detect_version_tag_shape   # §spec:brownfield-detection
  preflight_detect_credentials_app     # §spec:preflight-credentials-app
  preflight_detect_branch_protection_bypass # §spec:brownfield-detection
  preflight_detect_signed_commit_requirement # §spec:brownfield-detection
  preflight_detect_history_and_prs     # §spec:brownfield-detection
  preflight_inject                     # test-only hook (inert unless FLYWHEEL_TEST_HOOKS=1)
  # <<< detector seam <<<
  if [[ "$FINDINGS_BLOCK_COUNT" -gt 0 ]]; then
    printf '  pre-flight: \033[31m%d blocker(s)\033[0m found.\n' "$FINDINGS_BLOCK_COUNT"
  else
    printf '  pre-flight: \033[32mno blockers\033[0m.\n'
  fi
}

# preflight_gate — severity drives control flow. A block halts setup before any
# prompt or file is written. Interactively the adopter must resolve it and
# re-run; non-interactively the run exits non-zero with the reason. warn/info are
# advisory and never halt. Runs immediately after preflight_run, before the
# version resolution / first prompt / first write.
preflight_gate() {
  [[ "$FINDINGS_BLOCK_COUNT" -gt 0 ]] || return 0
  if [[ "$INTERACTIVE" -eq 1 ]]; then
    printf '\n\033[31mPre-flight halted\033[0m — %d blocking problem(s) above. Resolve them and re-run; no files were written.\n' "$FINDINGS_BLOCK_COUNT" >&2
  else
    printf '\n\033[31mPre-flight failed\033[0m — %d blocking problem(s) above. Non-interactive run; refusing to proceed on defaults. No files were written.\n' "$FINDINGS_BLOCK_COUNT" >&2
  fi
  exit 1
}

# brownfield_confirm <prompt> — the SINGLE confirm primitive shared by every
# brownfield resolver (§spec:brownfield-resolution "explicit, per-step, opt-in").
# Prints the prompt and reads a y/N answer from fd 3 — the interactive descriptor
# every other init prompt reads (`read -r -u 3`). Default is No: returns 0 only on
# an explicit yes (y/Y/yes), non-zero otherwise. Interactive-only by construction —
# the dispatcher never reaches a resolver on a non-interactive run, so this is never
# asked there; if it somehow were, the empty read degrades to No (no mutation).
brownfield_confirm() {
  local prompt="$1" reply=""
  read -r -u 3 -p "$prompt" reply
  [[ "$reply" =~ ^(y|Y|yes)$ ]]
}

# brownfield_resolver_tag_shape_bare_semver — the GUIDED RETAG resolver
# (SPEC.md §spec:brownfield-resolvers "Guided retag"). Implements the WS0 RESOLVER
# CONTRACT (see brownfield_resolve below): re-derive from LIVE state, show the full
# change, confirm via brownfield_confirm, return 0=applied / 1=declined / 2=unable.
#
# The change is NON-DESTRUCTIVE: for each colliding bare-semver tag X (3.4.2, 2.0)
# it CREATES `vX` pointing at the same commit and pushes it, NEVER deleting or
# moving X. The adopter can prune the originals later on their own terms.
#
# The detector already filters out any X whose `vX` exists (idempotency), but this
# re-derives independently from live state and applies the same filter defensively,
# so a stale registry message can never make it create a duplicate.
brownfield_resolver_tag_shape_bare_semver() {
  local tags tag bare bare_tags="" had_any=0
  # Re-derive the tag set the way the detector does: re-read LOCAL tags live (cheap,
  # no token, and another resolver may have mutated tags this run), unioned with the
  # remote set the detector already gathered (PREFLIGHT_REMOTE_TAGS) — no second
  # paginated `gh api repos/$REPO/tags`, since remote tags can't change before the
  # resolver that pushes them.
  tags="$(git tag -l 2>/dev/null || true)"
  if [[ -n "${PREFLIGHT_REMOTE_TAGS:-}" ]]; then
    tags="$(printf '%s\n%s\n' "$tags" "$PREFLIGHT_REMOTE_TAGS" | sort -u)"
  fi

  # Collect the bare-semver tags to retag, skipping any X whose vX already exists
  # (resolved). Each entry is the bare value X; the v-twin is derived as `v$X`.
  while IFS= read -r tag; do
    [[ -n "$tag" ]] || continue
    [[ "$tag" =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?$ ]] || continue
    had_any=1
    if printf '%s\n' "$tags" | grep -qxF "v$tag"; then
      continue   # vX already exists — already retagged.
    fi
    bare_tags+="$tag"$'\n'
  done <<<"$tags"

  # Nothing left to do (all bare tags already have their v-twin) — treat as a
  # resolved no-op so the gate stops counting the block. The detector normally
  # prevents reaching here, but a stale message must not be a false hard-stop.
  if [[ -z "$bare_tags" ]]; then
    if [[ "$had_any" -eq 1 ]]; then
      printf '  Bare-semver tags already retagged with a v-prefix — nothing to do.\n'
    fi
    return 0
  fi

  # SHOW the exact change in full BEFORE applying (shown-before-applied contract).
  printf '  Guided retag — these bare-semver tags collide with the v-prefixed scheme.\n'
  printf '  This is NON-DESTRUCTIVE: the v-prefixed tags are added alongside the\n'
  printf '  originals (which are kept); you can prune the originals later yourself.\n'
  while IFS= read -r bare; do
    [[ -n "$bare" ]] || continue
    printf '    %s -> v%s\n' "$bare" "$bare"
  done <<<"$bare_tags"

  if ! brownfield_confirm "  Create and push these v-prefixed tags? [y/N] "; then
    return 1   # DECLINED — dispatcher prints the manual pointer; change nothing.
  fi

  # APPLY: for each pair create vX at the same commit as X, then push it. NEVER
  # delete or move X. A push failure (no origin / no network / no perms) routes to
  # manual: naming what was created locally but not pushed (no false success).
  local created="" failed=0
  while IFS= read -r bare; do
    [[ -n "$bare" ]] || continue
    # git tag vX X — point the v-tag at the same commit as the bare tag.
    if ! git tag "v$bare" "$bare" 2>/dev/null; then
      # Already created on a prior partial run, or X resolved away — skip safely.
      git rev-parse -q --verify "refs/tags/v$bare" >/dev/null 2>&1 || { failed=1; continue; }
    fi
    if git push origin "v$bare" >/dev/null 2>&1; then
      created+="${created:+, }v$bare"
    else
      failed=1
      printf '  Created v%s locally but could not push it to origin.\n' "$bare"
    fi
  done <<<"$bare_tags"

  if [[ "$failed" -eq 1 ]]; then
    printf '  Push the remaining v-prefixed tag(s) yourself (check `origin` and your push access), then re-run.\n'
    return 2   # UNABLE — route to manual; do not claim success.
  fi

  printf '  Created and pushed v-prefixed tag(s): %s. Originals kept.\n' "$created"
  return 0   # APPLIED.
}

# brownfield_resolver_release_conflict — the PRIOR RELEASE-SYSTEM REMOVAL resolver
# (SPEC.md §spec:brownfield-resolvers "Prior release-system removal",
# docs/adopter/setup.md §0.2). Implements the WS0 RESOLVER CONTRACT: show the full
# change, confirm via brownfield_confirm, return 0=applied / 1=declined / 2=unable.
#
# The detector flags one block per conflicting file (a goreleaser/changesets config,
# a release-please/semantic-release/hand-rolled workflow). brownfield_resolve dedups
# by token and invokes this resolver ONCE per run, so a single consolidated offer
# covers the whole prior release system: it computes the removal set from
# RELEASE_CONFLICT_PATHS (filtered to paths still on disk — idempotency for a path
# already removed earlier this run or by a prior run), shows it, and confirms once.
#
# Removal is RECOVERABLE: each path is removed with `git rm` (file) / `git rm -r`
# (the .changeset dir), so it stays in git history and can be restored with
# `git checkout`/`git revert`. An UNTRACKED path falls back to `rm`/`rm -r` and is
# NOTEd as not recoverable from history. This removal is what replaces the deleted
# `--override-release-conflict` layer-on-top behavior — two release systems never
# run at once.
brownfield_resolver_release_conflict() {
  # Compute the removal set = flagged paths that still EXIST on disk.
  local path remove=()
  for path in "${RELEASE_CONFLICT_PATHS[@]}"; do
    [[ -e "$path" ]] && remove+=("$path")
  done

  # Nothing left to remove (all already gone) — a resolved no-op.
  if [[ "${#remove[@]}" -eq 0 ]]; then
    return 0
  fi

  # SHOW the exact list BEFORE removing (shown-before-applied contract).
  printf '  Prior release-system removal — these files race Flywheel and will be removed:\n'
  for path in "${remove[@]}"; do
    printf '    %s\n' "$path"
  done
  printf '  This is RECOVERABLE: removal uses `git rm`, so the files stay in git\n'
  printf '  history and can be restored with `git checkout`/`git revert`.\n'

  if ! brownfield_confirm "  Remove these prior release-system files? [y/N] "; then
    return 1   # DECLINED — dispatcher prints the manual pointer; change nothing.
  fi

  # APPLY: prefer `git rm` (keeps the file in history); fall back to plain `rm` for
  # an untracked path, NOTEing that it is NOT recoverable. A genuine failure routes
  # to manual (return 2) without claiming success.
  local removed="" rm_flag
  for path in "${remove[@]}"; do
    # `-r` for the .changeset directory; plain for files.
    if [[ -d "$path" ]]; then rm_flag="-r"; else rm_flag=""; fi
    if git ls-files --error-unmatch -- "$path" >/dev/null 2>&1; then
      if git rm $rm_flag -- "$path" >/dev/null 2>&1; then
        removed+="${removed:+, }$path"
      else
        printf '  Could not remove %s with `git rm`.\n' "$path"
        return 2
      fi
    else
      # Untracked: not in git history, so removal is NOT recoverable. Say so.
      if rm $rm_flag -f -- "$path" 2>/dev/null; then
        printf '  Removed untracked %s (NOT recoverable from git history).\n' "$path"
        removed+="${removed:+, }$path"
      else
        printf '  Could not remove %s.\n' "$path"
        return 2
      fi
    fi
  done

  printf '  Removed prior release-system file(s): %s.\n' "$removed"
  return 0   # APPLIED.
}

# _bypass_blocking_rule_labels <detail-json> — print the human labels for the
# blocking rule types this ruleset carries (one per line), so the offer can name
# the EXACT rules flywheel's pushes hit (not a blanket "protection"). Read-only.
_bypass_blocking_rule_labels() {
  local detail="$1"
  echo "$detail" | jq -r '
    [ .rules[]? | .type
      | if . == "pull_request" then "pull request required"
        elif . == "non_fast_forward" then "no force-push"
        elif . == "update" then "no force-push (update)"
        elif . == "deletion" then "no branch deletion"
        else empty end ]
    | unique | .[]' 2>/dev/null || true
}

# brownfield_resolver_branch_protection_bypass — the APP BYPASS-ACTOR ADDITION
# resolver (SPEC.md §spec:brownfield-resolvers "App bypass-actor addition",
# docs/adopter/setup.md §0.3). Implements the WS0 RESOLVER CONTRACT: show the full
# change, confirm via brownfield_confirm, return 0=applied / 1=declined / 2=unable.
#
# This is the MOST security-sensitive resolver — it changes WHO can bypass branch
# protection — so it is held to the tightest form of the safety contract:
#   * NO-PRIVILEGE-ESCALATION GATE FIRST. If the token lacks repo-admin we do NOT
#     attempt the edit: we report the limit and route to manual (return 2), NEVER
#     demanding a broader token (§spec:preflight-gh-capability,
#     §spec:doctor-credential-clarity). Signals: PREFLIGHT_RULESET_UNREADABLE=1
#     (rulesets weren't readable), and any ruleset PUT that fails with a
#     permissions error (treated as a limit, routed to manual — never retried).
#   * APP ID REQUIRED. The bypass entry is keyed on the App's numeric id; absent
#     PREFLIGHT_APP_ID_VALUE we can't construct it → report + route to manual.
#   * CLASSIC-protection branches can't be fixed via a ruleset edit (apps can't be
#     classic-protection bypass actors) → name them, route to manual.
#   * SHOW THE EXACT CHANGE before applying: per ruleset, the blocking rule type(s)
#     and the EXACT bypass entry added. The grant is SCOPED to that ruleset's
#     blocking rules (NOT a blanket exemption) and REVERSIBLE (remove the entry).
#
# APPLY adds ONLY `{actor_id:<App>, actor_type:"Integration", bypass_mode:"always"}`
# to each target ruleset's bypass_actors (deduped) and PUTs the ruleset back built
# from its cached detail (read-only fields stripped). We never modify/remove a rule
# and never add ~ALL/teams — the tightest grant that lets the release + back-merge
# pushes through. Any PUT failure → report the limit, return 2 (no partial-success
# claim). All targets updated → brief confirmation, return 0.
brownfield_resolver_branch_protection_bypass() {
  # NO-PRIVILEGE-ESCALATION GATE (first). If we couldn't even read the rulesets,
  # the token lacks repo-admin — report the limit, route to manual, never escalate.
  if [[ "${PREFLIGHT_RULESET_UNREADABLE:-0}" -eq 1 ]]; then
    printf '  Branch-protection bypass: your token cannot read this repo'\''s rulesets\n'
    printf '  (repo-admin required). Add the Flywheel App as a bypass actor yourself, or\n'
    printf '  re-run with an admin token: docs/adopter/setup.md §0.\n'
    return 2
  fi

  # APP ID REQUIRED — the bypass entry is keyed on the App's numeric id.
  local app_id="${PREFLIGHT_APP_ID_VALUE:-}"
  if [[ -z "$app_id" ]]; then
    printf '  Branch-protection bypass: the Flywheel App ID is not known yet, so the\n'
    printf '  bypass entry can'\''t be constructed. Provision the App (it writes\n'
    printf '  FLYWHEEL_GH_APP_ID), then add the App as a bypass actor: docs/adopter/setup.md §0.\n'
    return 2
  fi
  # The App ID is the adopter-set FLYWHEEL_GH_APP_ID variable; assert it is numeric
  # before it reaches the bypass-entry JSON below. jq's --argjson already fails
  # closed on a malformed value, but this resolver GRANTS branch-protection bypass,
  # so a non-numeric id is rejected up front rather than smuggled into the PUT body.
  if [[ ! "$app_id" =~ ^[0-9]+$ ]]; then
    printf '  Branch-protection bypass: the configured Flywheel App ID (%s) is not numeric,\n' "$app_id"
    printf '  so the bypass entry can'\''t be constructed safely. Fix FLYWHEEL_GH_APP_ID, then\n'
    printf '  add the App as a bypass actor: docs/adopter/setup.md §0.\n'
    return 2
  fi

  # CLASSIC-protection branches can't be fixed by a ruleset edit — name them.
  if [[ "${#BYPASS_CLASSIC_BRANCHES[@]}" -gt 0 ]]; then
    printf '  These branch(es) use CLASSIC branch protection, which has no per-App bypass\n'
    printf '  list — apps cannot be added as bypass actors there. Resolve them manually\n'
    printf '  (migrate to a ruleset, or relax the rule): %s\n' \
      "$(IFS=', '; echo "${BYPASS_CLASSIC_BRANCHES[*]}")"
  fi

  # If ALL affected branches were classic-only (no editable ruleset), there is
  # nothing to PUT — route entirely to manual.
  if [[ "${#BYPASS_RULESET_IDS[@]}" -eq 0 ]]; then
    printf '  No editable ruleset covers the affected branch(es) — routing to manual: docs/adopter/setup.md §0.\n'
    return 2
  fi

  # The EXACT bypass entry we will add (shown, then applied verbatim).
  local entry
  entry="$(printf '{"actor_id":%s,"actor_type":"Integration","bypass_mode":"always"}' "$app_id")"

  # SHOW the exact change in full BEFORE applying (shown-before-applied contract).
  printf '  Branch-protection bypass — these ruleset(s) block Flywheel'\''s release and\n'
  printf '  back-merge pushes and do not list the Flywheel App as a bypass actor:\n'
  local id detail name labels label
  for id in "${BYPASS_RULESET_IDS[@]}"; do
    detail="$(_bypass_cached_detail "$id")"
    name="$(echo "$detail" | jq -r '.name // "(unnamed)"' 2>/dev/null || true)"
    printf '    ruleset "%s" (id %s) — blocking rule(s):\n' "${name:-(unnamed)}" "$id"
    labels="$(_bypass_blocking_rule_labels "$detail")"
    while IFS= read -r label; do
      [[ -n "$label" ]] || continue
      printf '      - %s\n' "$label"
    done <<< "$labels"
  done
  printf '  It will ADD this bypass actor (the Flywheel App, id %s) to each:\n' "$app_id"
  printf '    %s\n' "$entry"
  printf '  This is SCOPED to exactly those ruleset(s)'\'' blocking rules (NOT a blanket\n'
  printf '  exemption) and is REVERSIBLE — the entry can be removed from the ruleset'\''s\n'
  printf '  bypass actors at any time.\n'

  if ! brownfield_confirm "  Add the Flywheel App as a bypass actor on these ruleset(s)? [y/N] "; then
    return 1   # DECLINED — dispatcher prints the manual pointer; change nothing.
  fi

  # APPLY: for each target ruleset, append the App entry to bypass_actors (dedup),
  # rebuild a PUT body from the cached detail (read-only fields stripped), and PUT.
  # A failed PUT is reported as a limit and routes to manual (return 2) — NEVER
  # retried with a broader token, NEVER claimed as partial success.
  local updated="" body
  for id in "${BYPASS_RULESET_IDS[@]}"; do
    detail="$(_bypass_cached_detail "$id")"
    # Build the update body: preserve name/target/enforcement/conditions/rules,
    # add the App to bypass_actors (deduped on actor_id+Integration), and strip the
    # read-only fields the rulesets PUT endpoint rejects.
    body="$(echo "$detail" | jq \
      --argjson entry "$entry" '
        .bypass_actors = ((.bypass_actors // [])
          + ( if any(.bypass_actors[]?;
                       .actor_type == "Integration"
                       and (.actor_id | tostring) == ($entry.actor_id | tostring))
              then [] else [$entry] end ))
        | {name, target, enforcement, conditions, rules, bypass_actors}' \
      2>/dev/null || true)"
    if [[ -z "$body" ]]; then
      printf '  Could not construct the update for ruleset id %s — routing to manual.\n' "$id"
      return 2
    fi
    if printf '%s' "$body" | gh api -X PUT "repos/$REPO/rulesets/$id" --input - >/dev/null 2>&1; then
      updated+="${updated:+, }$id"
    else
      # A permissions error (or any PUT failure) is a capability LIMIT: report and
      # route to manual. Do not retry with a broader token; do not claim success.
      printf '  Could not update ruleset id %s (this needs repo-admin) — add the App as a\n' "$id"
      printf '  bypass actor yourself, or re-run with an admin token: docs/adopter/setup.md §0.\n'
      return 2
    fi
  done

  printf '  Added the Flywheel App (id %s) as a bypass actor on ruleset(s): %s.\n' "$app_id" "$updated"
  return 0   # APPLIED.
}

# _bypass_cached_detail <id> — print the cached ruleset detail JSON for <id> by
# matching the id in the parallel PREFLIGHT_RULESET_IDS / PREFLIGHT_RULESET_DETAILS
# arrays (no second gh read). Empty if not found (defensive — shouldn't happen).
_bypass_cached_detail() {
  local want="$1" i=0
  while [[ $i -lt ${#PREFLIGHT_RULESET_IDS[@]} ]]; do
    if [[ "${PREFLIGHT_RULESET_IDS[$i]}" == "$want" ]]; then
      printf '%s' "${PREFLIGHT_RULESET_DETAILS[$i]}"
      return 0
    fi
    i=$((i+1))
  done
}

# brownfield_resolve — the resolution phase (SPEC.md §spec:brownfield-resolution).
# Runs AFTER the detection pass and BEFORE the gate / any scaffold write — the
# first point init could mutate PRE-EXISTING repo state, so it is governed by the
# safety contract: shown-before-applied, explicit per-step opt-in, NOTHING
# destructive non-interactively, idempotent, no new privilege.
#
# PER-CONDITION DISPATCH. For each `block` condition this looks for a resolver
# function named `brownfield_resolver_<token>` (e.g. brownfield_resolver_tag_shape_bare_semver)
# and dispatches to it ONLY when the condition is marked resolvable, the run is
# interactive, AND the function is actually defined. Everything else degrades to
# the hard-stop print (named in the shared bucket x severity vocabulary, routed to
# the manual §0 guide). The gate (next) owns the single non-zero exit, so this
# never overrides the gate's contract (§spec:setup-exit-contract).
#
# RESOLVER CONTRACT (#233-3 WS1–WS3 implement to this). A resolver is invoked as:
#       brownfield_resolver_<token> "<message>"
# It re-derives its exact change from LIVE state, shows the full change, asks via
# `brownfield_confirm`, then returns:
#   0 = APPLIED   — the change was made. The dispatcher records `resolved` and
#                   decrements FINDINGS_BLOCK_COUNT so the gate stops counting it.
#   1 = DECLINED  — adopter said no; nothing changed. The dispatcher records
#                   `declined`, decrements FINDINGS_BLOCK_COUNT (a deliberate
#                   deferral, not a blocker — the run continues), and prints a
#                   one-line pointer to the manual procedure (§spec:brownfield-resolution
#                   "accept some, decline others").
#   2 = UNABLE    — a capability/scope limit or anything the resolver will not do
#                   safely; route to manual. The dispatcher records `hardstop`,
#                   leaves the block counted, and falls through to the hard-stop
#                   print, exactly like a condition with no resolver.
#
# OUTCOMES are stashed in BROWNFIELD_OUTCOMES (NOT record_outcome — that is defined
# AFTER this runs); brownfield_emit_summary_records replays them into the summary.
#
# NON-INTERACTIVE (curl|bash, CI): INTERACTIVE -ne 1, so NO resolver is dispatched
# and NO mutation happens — every resolvable block degrades to hard-stop
# (detect-and-report), satisfying the spec's "nothing destructive non-interactively"
# rule. Reporting/routing happens in both modes — only mutation is interactive-only.
#
#   * info   -> DEFERRED (advisory): skipped here; a later step folds these into
#               the completion summary.
#
# GREENFIELD: BROWNFIELD_CONDITIONS is empty -> strict no-op, no output.
brownfield_resolve() {
  [[ "${#BROWNFIELD_CONDITIONS[@]}" -gt 0 ]] || return 0
  local rec token bucket severity resolvable message printed_header=0
  # Per-token resolver-result cache. A resolver runs at most ONCE per run even when
  # the detector emits several block records for one token (release_conflict emits
  # one block per flagged file). Each record still records its own outcome and
  # decrements the gate count, so the per-file summary lines and block accounting
  # are unchanged — only the resolver CALL (its prompt + mutation) is deduplicated.
  # This keeps the resolvers pure: none needs a run-scoped guard of its own, and a
  # resolver that returns 2 (unable) is never re-prompted on a sibling record.
  # bash 3.2-safe: a newline list of "<token>\t<rc>" scanned with a read loop.
  local dispatched=""
  for rec in "${BROWNFIELD_CONDITIONS[@]}"; do
    IFS=$'\t' read -r token bucket severity resolvable message <<< "$rec"
    # Advisory infos are folded into the completion summary later — not here.
    [[ "$severity" == "block" ]] || continue

    # Dispatch to a resolver only when the condition is resolvable, the run is
    # interactive (no mutation otherwise), and the resolver function exists.
    if [[ "$resolvable" == "yes" && "$INTERACTIVE" -eq 1 ]] \
       && declare -F "brownfield_resolver_${token}" >/dev/null 2>&1; then
      # Reuse this token's result if a prior record already dispatched its resolver;
      # otherwise call it once and cache the code. `|| rc=$?` keeps a non-zero return
      # (declined/unable) from tripping `set -e` before we can branch on it.
      local rc="" dt drc
      while IFS=$'\t' read -r dt drc; do
        [[ "$dt" == "$token" ]] && { rc="$drc"; break; }
      done <<< "$dispatched"
      if [[ -z "$rc" ]]; then
        rc=0
        "brownfield_resolver_${token}" "$message" || rc=$?
        dispatched+="${token}"$'\t'"${rc}"$'\n'
      fi
      case "$rc" in
        0) # APPLIED — change made; stop the gate counting this block.
          BROWNFIELD_OUTCOMES+=("${token}"$'\t'resolved$'\t'"${bucket}"$'\t'"${severity}"$'\t'"${message}")
          [[ "$FINDINGS_BLOCK_COUNT" -gt 0 ]] && FINDINGS_BLOCK_COUNT=$((FINDINGS_BLOCK_COUNT - 1))
          continue ;;
        1) # DECLINED — unchanged, but a deliberate deferral: uncount + point to manual.
          BROWNFIELD_OUTCOMES+=("${token}"$'\t'declined$'\t'"${bucket}"$'\t'"${severity}"$'\t'"${message}")
          [[ "$FINDINGS_BLOCK_COUNT" -gt 0 ]] && FINDINGS_BLOCK_COUNT=$((FINDINGS_BLOCK_COUNT - 1))
          printf '  Declined — resolve this later with the manual brownfield guide: docs/adopter/setup.md §0.\n'
          continue ;;
        *) # UNABLE (2, or any non-0/1) — route to manual; fall through to hard-stop.
          BROWNFIELD_OUTCOMES+=("${token}"$'\t'hardstop$'\t'"${bucket}"$'\t'"${severity}"$'\t'"${message}")
          ;;
      esac
    else
      # resolvable=no, OR non-interactive, OR no resolver function -> hard-stop.
      BROWNFIELD_OUTCOMES+=("${token}"$'\t'hardstop$'\t'"${bucket}"$'\t'"${severity}"$'\t'"${message}")
    fi

    # Hard-stop print: name the still-counted block in the shared vocabulary.
    if [[ "$printed_header" -eq 0 ]]; then
      printf '\nBrownfield conditions need your hand before adoption:\n'
      printed_header=1
    fi
    format_finding "$bucket" "$severity" "$message"
  done
  if [[ "$printed_header" -eq 1 ]]; then
    printf '  Resolve these with the manual brownfield guide: docs/adopter/setup.md §0 (Adopting Flywheel into an existing project), then re-run.\n'
  fi
  return 0
}

preflight_run
brownfield_resolve
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

# brownfield_emit_summary_records — fold the run's brownfield conditions into the
# completion summary (SPEC.md §spec:brownfield-resolution, §spec:setup-completion-summary).
# This runs on a run that PROCEEDED past the gate, so the only `block` conditions
# that reach it are ones the resolution phase cleared the gate of: resolved (applied)
# or declined (a deliberate deferral). A hard-stopped block never reaches here — the
# gate exits first. Two sources, no double-recording:
#   * BROWNFIELD_OUTCOMES drives the block verdicts the dispatcher reached:
#       resolved -> `configured`, declined -> `deferred`.
#   * BROWNFIELD_CONDITIONS drives the advisory `info` conditions (legacy [skip ci] /
#     non-conventional history, open-PR title rewrites), recorded `deferred` as before.
# Both land in the SAME bucket x severity vocabulary as the rest of the summary;
# a deferral the adopter has been shown is never a failure, so it never moves the
# complete/incomplete verdict (§spec:setup-exit-contract). Empty -> no-op.
brownfield_emit_summary_records() {
  local rec token outcome bucket severity resolvable message
  # Block verdicts from the resolution phase. Guard the empty case so an unset
  # array expansion does not abort under `set -u` (bash 3.2-safe, as elsewhere).
  if [[ "${#BROWNFIELD_OUTCOMES[@]}" -gt 0 ]]; then
    for rec in "${BROWNFIELD_OUTCOMES[@]}"; do
      IFS=$'\t' read -r token outcome bucket severity message <<< "$rec"
      case "$outcome" in
        resolved) record_outcome "brownfield: ${message}" configured "$bucket" "$severity" ;;
        declined) record_outcome "brownfield: ${message}" deferred "$bucket" "$severity" ;;
        # hardstop never reaches here (the gate exits first) — defensive skip.
      esac
    done
  fi
  # Advisory info conditions (severity != block) fold in as deliberate deferrals.
  if [[ "${#BROWNFIELD_CONDITIONS[@]}" -gt 0 ]]; then
    for rec in "${BROWNFIELD_CONDITIONS[@]}"; do
      IFS=$'\t' read -r token bucket severity resolvable message <<< "$rec"
      [[ "$severity" == "block" ]] && continue
      record_outcome "brownfield: ${message}" deferred "$bucket" "$severity"
    done
  fi
}
brownfield_emit_summary_records

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
      # OR an UNRESOLVED block-severity finding. A deliberate skip (deferred
      # warn/info) never counts; neither does a `configured` step that happens to
      # carry block severity — a resolved brownfield block (resolution phase ->
      # `configured`, severity `block`) is a completed step, not an outstanding
      # blocker (§spec:brownfield-resolution "the run still completes"). SPEC.md
      # §spec:setup-completion-summary: "only a step that was meant to run and
      # failed, or an unresolved block-severity finding, makes the verdict
      # incomplete".
      if [[ "$outcome" == "failed" || ( "$severity" == "block" && "$outcome" != "configured" ) ]]; then
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
      echo "  1) minimal       — a single release line on one branch that cuts a release on every qualifying push"
      echo "  2) three-stage   — one release line through staged branches (develop → staging → main) with promotion PRs between them"
      echo "  3) multi-stream  — two or more independent release lines in parallel, each cutting its own prereleases with its own version suffix and auto-merge rules"
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
# SCOPE controls where the App's shared credentials (FLYWHEEL_GH_APP_ID Variable
# + FLYWHEEL_GH_APP_PRIVATE_KEY Secret) live:
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
  printf '%s' "$pem" | write_app_key_secret || {
    echo "  error: could not set FLYWHEEL_GH_APP_PRIVATE_KEY secret at scope=$SCOPE." >&2
    return 1
  }
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

# app_install_url — the GitHub org-installations settings page where an existing
# org-level flywheel App is added to this repo. Single source for the URL shared
# by the interactive guided prompt (install_app_on_repo) and the recorded finish
# command (app_install_finish_cmd), so a GitHub URL change is a one-line edit.
app_install_url() {
  printf '%s' "https://github.com/organizations/$OWNER/settings/installations"
}

# install_app_on_repo — route the adopter to install an already-existing org-level
# flywheel App onto THIS repo: the one action that lets its tokens act here
# (§spec:init-app-step, "exists at the org level but is not installed"). Consumes
# PREFLIGHT_* globals + OWNER/REPO; issues NO gh probes (the reuse boundary). The
# caller (app_step_render_detected + the not-installed prompt) has already named
# the detected App and the not-installed state, so this prints only the action.
install_app_on_repo() {
  echo
  echo "  Install the existing App on this repo:"
  echo "    Open: $(app_install_url)"
  echo "    Find the flywheel App, click Configure, add $REPO under 'Only select repositories', and Save."
  echo "    This is the one step that lets the App mint tokens for $REPO."
  if [[ "$INTERACTIVE" -eq 1 ]]; then
    read -r -u 3 -p "  Press ENTER once the App is installed on $REPO..."
  fi
  return 0
}

prompt_existing_app_credentials() {
  cat <<EOF
  Paste the Flywheel GitHub App's shared credentials (the App's own identity,
  not a personal access token): its numeric App ID — stored as the
  FLYWHEEL_GH_APP_ID Variable — and its PEM private key — stored as the
  FLYWHEEL_GH_APP_PRIVATE_KEY Secret.
  If you haven't created the App yet, follow:
    https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/creating-a-github-app
  Required permissions: Contents r/w, Pull requests r/w, Issues r/w,
  Checks r/w, Metadata r. Install on $REPO.
EOF
  # Tri-state result so callers record an honest outcome:
  #   0 = every requested piece was written            (configured)
  #   1 = a gh WRITE failed                            (hard error — fail loudly)
  #   2 = a piece was deliberately skipped/not provided (defer, warn severity)
  # The old single "success" return reported a skip as 0, so a caller recorded
  # `configured` while the secret was still unset — finish_existing_app_creds now
  # maps these three states to configured / failed-block / deferred-warn.
  local skipped=0
  if [[ "$has_app_id" -eq 0 ]]; then
    read -r -u 3 -p "  App ID (numeric, stored as the FLYWHEEL_GH_APP_ID Variable): " app_id
    if [[ -z "$app_id" ]]; then
      echo "  empty App ID — skipping FLYWHEEL_GH_APP_ID variable."
      skipped=1
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
    read -r -u 3 -p "  Path to PEM private-key file (stored as the FLYWHEEL_GH_APP_PRIVATE_KEY Secret): " pem_path
    if [[ -z "$pem_path" ]]; then
      echo "  empty path — skipping FLYWHEEL_GH_APP_PRIVATE_KEY secret."
      skipped=1
    elif [[ ! -f "$pem_path" ]]; then
      echo "  error: PEM file not found at '$pem_path' — skipping FLYWHEEL_GH_APP_PRIVATE_KEY secret." >&2
      skipped=1
    else
      write_app_key_secret < "$pem_path" || {
        echo "  error: could not set FLYWHEEL_GH_APP_PRIVATE_KEY secret at scope=$SCOPE." >&2
        return 1
      }
      echo "  set FLYWHEEL_GH_APP_PRIVATE_KEY secret (scope=$SCOPE)."
    fi
  fi
  [[ "$skipped" -eq 0 ]] && return 0
  return 2
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

# app_install_finish_cmd — single source of truth for the install-this-App
# instruction recorded/printed when an org-level flywheel App exists but is not
# installed on THIS repo (§spec:init-app-step, "exists at the org level but is
# not installed"). The credentials are already set; the missing action is
# installing the App on the repo so its tokens can act here. $REPO/$OWNER expand
# at call time, matching app_creds_finish_cmd.
app_install_finish_cmd() {
  printf '%s' "Install the existing flywheel App on $REPO: open $(app_install_url) , Configure the App, and add $REPO under 'Only select repositories'."
}

# app_step_render_detected — READ-ONLY summary of what the pre-flight pass already
# found, for showing the adopter at the App step (§spec:init-app-step: "the step
# reflects what pre-flight already found rather than starting cold"). Consumes the
# PREFLIGHT_* globals directly — it is the reuse boundary, so it issues NO gh
# calls and never re-probes. Uses the same vocabulary as pre-flight/doctor
# (FLYWHEEL_GH_APP_ID variable, FLYWHEEL_GH_APP_PRIVATE_KEY secret, repo/org
# levels). Output is indented two spaces to match the surrounding echo style.
app_step_render_detected() {
  if [[ -n "$PREFLIGHT_APP_ID_VALUE" ]]; then
    echo "  Detected App ID ${PREFLIGHT_APP_ID_VALUE} (${PREFLIGHT_APP_ID_AT}-level)."
  fi
  if [[ "$PREFLIGHT_HAS_APP_ID" -eq 1 ]]; then
    echo "  FLYWHEEL_GH_APP_ID variable: found (${PREFLIGHT_APP_ID_AT}-level)"
  else
    echo "  FLYWHEEL_GH_APP_ID variable: missing"
  fi
  if [[ "$PREFLIGHT_HAS_APP_KEY" -eq 1 ]]; then
    echo "  FLYWHEEL_GH_APP_PRIVATE_KEY secret: found (${PREFLIGHT_APP_KEY_AT}-level)"
  else
    echo "  FLYWHEEL_GH_APP_PRIVATE_KEY secret: missing"
  fi
  # Both present but at different levels: workflows read the repo-level value first,
  # so warn here too (not only on the non-interactive path) to keep one account of
  # the split-level precedence across every surface (§spec:init-app-step).
  if [[ "$PREFLIGHT_HAS_APP_ID" -eq 1 && "$PREFLIGHT_HAS_APP_KEY" -eq 1 \
        && "$PREFLIGHT_APP_ID_AT" != "$PREFLIGHT_APP_KEY_AT" ]]; then
    echo "  Split levels — workflows will prefer the repo-level value when both exist."
  fi
}

# finish_existing_app_creds <finish-cmd> — run prompt_existing_app_credentials for
# whatever piece is missing and record the outcome from its tri-state result:
#   complete    → configured
#   skipped     → deferred (warn): the adopter chose to finish later, so the run
#                 stays green (only --strict elevates it) and the summary carries
#                 the finishing command instead of a false "configured"
#   write error → failed (block): a real gh failure fails the run loudly
# Single source for this prompt-then-record sequence, shared by the detected-creds
# partial path and the cold create/paste menu so the three can never diverge.
finish_existing_app_creds() {
  local finish_cmd="$1" rc=0
  # `&& rc=0 || rc=$?` keeps the non-zero tri-state returns from tripping `set -e`
  # (the function sits on the left of `&&`, which errexit exempts).
  prompt_existing_app_credentials && rc=0 || rc=$?
  case "$rc" in
    0) record_outcome "App credentials" configured ;;
    2) record_outcome "App credentials" deferred config warn "$finish_cmd" ;;
    *) record_outcome "App credentials" failed config block "$finish_cmd" ;;
  esac
}

# app_keep_detected — keep the credentials pre-flight already found and record
# the outcome. SCOPE is where any missing piece gets written: if the App ID is
# present, write the key beside it; if the App ID is the missing piece, write it
# at repo level — a repo-scoped variable never needs an admin:org token, so an
# under-scoped adopter can still finish (inheriting the key's org level would
# force admin:org for the id write). Shared by the confirm ("use the detected
# credentials") path and the install-on-repo path so the record_outcome logic
# lives in exactly one place. Sets app_step_resolved=1.
app_keep_detected() {
  if [[ "$has_app_id" -eq 1 ]]; then
    SCOPE="$app_id_found_at"
  else
    SCOPE="repo"
  fi
  app_step_resolved=1
  if [[ "$has_app_id" -eq 1 && "$has_app_key" -eq 1 ]]; then
    echo "  Keeping the detected credentials."
    record_outcome "App credentials" configured
  else
    # Partial: prompt only for the missing piece (prompt_existing_app_credentials
    # guards each prompt on has_app_id / has_app_key, so the present piece is never
    # re-pasted) and record honestly via the shared finisher.
    finish_existing_app_creds "$(app_creds_finish_cmd "$SCOPE")"
  fi
}

if [[ "$SKIP_SECRETS" -eq 1 ]]; then
  echo "  --skip-secrets set; not touching the App's FLYWHEEL_GH_APP_ID Variable or FLYWHEEL_GH_APP_PRIVATE_KEY Secret."
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

  if [[ "$INTERACTIVE" -eq 0 ]]; then
    # Non-interactive: no prompts, ever. A complete, installed setup reports as
    # configured; anything missing — a credential piece or the repo install —
    # defers with the manual finishing command(s). The not-installed case
    # deliberately defers rather than reporting configured: an org App that is not
    # installed on this repo cannot mint tokens here, so "configured" would be
    # dishonest (a behavior change from the old unconditional "both set →
    # configured"; §spec:init-app-step, "non-interactive and piped runs").
    if [[ "$PREFLIGHT_APP_INSTALLED" == "no" ]]; then
      # Org-level App detected but NOT installed on this repo. Non-interactively we
      # can't run the guided install (install_app_on_repo reads from a prompt), so
      # print the manual install action and defer. PREFLIGHT_APP_INSTALLED=="no"
      # only occurs with has_app_id=1, but the private-key secret may still be
      # missing — surface that finishing command too, so the adopter is not told to
      # install an App whose key is not even set.
      app_install_cmd="$(app_install_finish_cmd)"
      echo "  non-interactive shell — the org App is not installed on $REPO. Finish manually:"
      echo "    $app_install_cmd"
      if [[ "$has_app_key" -eq 0 ]]; then
        app_creds_cmd="$(app_creds_finish_cmd "$app_id_found_at")"
        echo "  The FLYWHEEL_GH_APP_PRIVATE_KEY secret is also missing — set it too:"
        echo "    $app_creds_cmd"
        record_outcome "App credentials" deferred config warn "$app_install_cmd ; $app_creds_cmd"
      else
        record_outcome "App credentials" deferred config warn "$app_install_cmd"
      fi
    elif [[ "$has_app_id" -eq 1 && "$has_app_key" -eq 1 ]]; then
      if [[ "$app_id_found_at" == "$app_key_found_at" ]]; then
        echo "  FLYWHEEL_GH_APP_ID variable + FLYWHEEL_GH_APP_PRIVATE_KEY secret already set ($app_id_found_at-level)."
      else
        echo "  FLYWHEEL_GH_APP_ID set at ${app_id_found_at}-level, FLYWHEEL_GH_APP_PRIVATE_KEY at ${app_key_found_at}-level — workflows will prefer the repo-level value when both exist."
      fi
      record_outcome "App credentials" configured
    else
      # Derive the displayed hint from app_creds_finish_cmd so the command form
      # lives in exactly one place (it is also what gets recorded below).
      app_creds_cmd="$(app_creds_finish_cmd "$SCOPE")"
      echo "  non-interactive shell — skipping App-credential prompts. Set the Flywheel"
      echo "  GitHub App's two shared values manually — the FLYWHEEL_GH_APP_ID Variable and"
      echo "  the FLYWHEEL_GH_APP_PRIVATE_KEY Secret, under Settings → Secrets and variables → Actions:"
      echo "    $app_creds_cmd"
      record_outcome "App credentials" deferred config warn "$app_creds_cmd"
    fi
  elif [[ "$has_app_id" -eq 1 || "$has_app_key" -eq 1 ]]; then
    # Interactive AND pre-flight detected at least one credential: present the
    # detection as a confirm-or-override default rather than silently deciding
    # for the adopter (§spec:init-app-step). Confirm reuses what was found and
    # fills only the missing piece; override wipes the locals and falls through
    # to the cold create/paste/skip menu.
    echo
    echo "  Pre-flight already found App credentials:"
    app_step_render_detected
    echo
    if [[ "$PREFLIGHT_APP_INSTALLED" == "no" ]]; then
      # Org-level App detected but NOT installed on this repo (§spec:init-app-step,
      # "exists at the org level but is not installed"): the creds exist yet the
      # App cannot mint tokens for $REPO. Surface the install action as the primary
      # recommended fix instead of the plain confirm; "use anyway" and "override"
      # remain available. PREFLIGHT_APP_INSTALLED=="no" only occurs with
      # has_app_id=1, so the detected-creds vocabulary above still applies.
      echo "  This App is not installed on $REPO, so its tokens cannot act here yet."
      echo "  Pick how to proceed:"
      echo "    1) Install the existing App on this repo (recommended)"
      echo "    2) Use the detected credentials anyway"
      echo "    3) Override — create or paste different credentials"
      read -r -u 3 -p "  Selection [1/2/3] (default 1): " app_installed_choice
      case "${app_installed_choice:-1}" in
        2)
          # Use anyway: same effect as confirming the detection below.
          app_keep_detected
          ;;
        3)
          # Override: clear the locals so the cold paste path prompts for BOTH
          # pieces, then fall through to the cold create/paste/skip menu below.
          has_app_id=0; has_app_key=0
          ;;
        *)
          # Install (recommended): route the adopter to install the existing App
          # on this repo, then keep the already-detected credentials.
          install_app_on_repo
          app_keep_detected
          ;;
      esac
    else
      read -r -u 3 -p "  Use the detected credentials? [Y/n] (default Y; N to override): " app_detected_choice
      case "${app_detected_choice:-Y}" in
        [Nn]*)
          # Override: adopter wants to supply credentials from scratch. Clear the
          # locals so the cold paste path prompts for BOTH pieces, then fall
          # through to the cold menu below (its copy is pinned by tests).
          has_app_id=0; has_app_key=0
          ;;
        *)
          # Confirm: keep what pre-flight found (shared with the install path).
          app_keep_detected
          ;;
      esac
    fi
  fi

  if [[ "$INTERACTIVE" -eq 1 && -z "${app_step_resolved:-}" ]]; then
    # Resolve SCOPE before the App-source prompt so write_app_id_var /
    # write_app_key_secret know where to write. If the owner is a User
    # account, org-level vars/secrets don't exist on GitHub at all, so
    # we silently lock to repo. If --scope was set explicitly, honor it.
    # In partial state SCOPE is now non-empty, so the scope prompt below is
    # skipped; the org-owner validation still runs for an explicit/co-located org.
    if [[ -z "$SCOPE" ]]; then
      detect_owner_type
      if [[ "$OWNER_TYPE" == "Organization" ]]; then
        echo
        echo "  Where should the Flywheel GitHub App's shared credentials live?"
        echo "  These are the App's own identity (its numeric App ID + PEM private key),"
        echo "  not a personal access token or per-user secret. Each option writes both:"
        echo "  the FLYWHEEL_GH_APP_ID Variable and the FLYWHEEL_GH_APP_PRIVATE_KEY Secret."
        echo "    1) Repo $REPO only (default) — writes the Variable + Secret on this repo"
        echo "    2) Org-wide ($OWNER) — writes the Variable + Secret on the org with"
        echo "       visibility=all, shared across every repo in the org"
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
    echo "  Flywheel needs a GitHub App. The App is how the flywheel workflows act on"
    echo "  this repo as a bot: push releases and tags, open and merge promotion PRs,"
    echo "  and apply labels. To do that it needs these permissions: Contents"
    echo "  (read/write), Pull requests (read/write), Issues (read/write), Checks"
    echo "  (read/write), and Metadata (read)."
    echo
    echo "  The App is a permanent dependency, used on every workflow run for the life"
    echo "  of the adoption — not one-time install scaffolding to delete later."
    echo "  Changing it later means rotating its credential or revoking the App."
    echo
    echo "  Why an App and not a personal access token? Flywheel registers the App as"
    echo "  an Integration-type bypass actor in the branch/tag rulesets so the bot can"
    echo "  push to protected branches, and only a GitHub App can be that bypass actor."
    echo "  A PAT would also tie the automation to one person's account and rate limit"
    echo "  and live as a long-lived manual secret."
    echo
    echo "  Pick a setup path:"
    echo "    1) Create the App for me  — opens browser, ~30s round-trip"
    echo "    2) I have an App already — paste its App ID (Variable) + PEM private key (Secret)"
    echo "    3) Skip — I'll set the App's Variable + Secret later"
    read -r -u 3 -p "  Selection [1/2/3] (default 1): " app_choice
    case "${app_choice:-1}" in
      1)
        if create_app_via_manifest; then
          record_outcome "App credentials" configured
        else
          echo "  Falling back to manual prompts."
          finish_existing_app_creds "$app_creds_cmd"
        fi
        ;;
      2)
        finish_existing_app_creds "$app_creds_cmd"
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
