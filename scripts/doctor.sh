#!/usr/bin/env bash
# doctor.sh — validate that a repo is correctly configured for Flywheel.
#
# Read-only. Exits 0 if every check passes, 1 if any FAIL is reported.
# Usage:
#   ./scripts/doctor.sh [--skip-credentials] [--summary] [owner/repo]
# If owner/repo is omitted, uses 'gh repo view' on the current directory.
#
# --skip-credentials skips the FLYWHEEL_GH_APP_ID / FLYWHEEL_GH_APP_PRIVATE_KEY
# checks. Use it from CI runs that already proved the credentials work by
# minting an App installation token (the mint failing is itself a hard
# error, so a downstream listing check is redundant). Without the flag,
# doctor expects to be run with a token that can list repo Variables and
# Secrets — i.e. an admin PAT.
#
# --summary suppresses decoration (section headers, green ok lines, and the
# trailing FAIL/OK summary block) but still emits every block/warn/info
# finding, then prints a single machine-readable trailer as its last line:
#   DOCTOR_RESULT blocks=<n> warns=<m>
# init.sh consumes this to fold doctor's verdict into its completion summary.
# The exit contract is unchanged (1 iff a block fired, else 0).
#
# Dependencies: git, gh, jq, python3 with PyYAML.

set -uo pipefail

skip_credentials=0
summary_mode=0
REPO=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-credentials) skip_credentials=1; shift ;;
    --summary) summary_mode=1; shift ;;
    -h|--help)
      cat <<'EOF'
doctor.sh — validate that a repo is correctly configured for Flywheel.

Usage: ./scripts/doctor.sh [--skip-credentials] [--summary] [owner/repo]

If owner/repo is omitted, uses 'gh repo view' on the current directory.

  --skip-credentials  Skip the FLYWHEEL_GH_APP_ID / FLYWHEEL_GH_APP_PRIVATE_KEY
                      checks. Use this from CI runs that already proved the
                      credentials work by minting an App installation token.
                      Without the flag, doctor expects a token that can list
                      repo Variables and Secrets (an admin PAT).
  --summary           Suppress section headers, ok lines, and the trailing
                      summary block; still emit every finding, then print a
                      machine-readable trailer 'DOCTOR_RESULT blocks=<n>
                      warns=<m>' as the last line. Exit code is unchanged.
EOF
      exit 0
      ;;
    -*) echo "error: unknown flag '$1'" >&2; exit 1 ;;
    *)
      if [[ -n "$REPO" ]]; then
        echo "error: unexpected extra argument '$1'" >&2
        exit 1
      fi
      REPO="$1"; shift
      ;;
  esac
done

for tool in git gh jq python3; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "error: '$tool' is required but not installed." >&2
    exit 1
  }
done
python3 -c "import yaml" 2>/dev/null || {
  echo "error: PyYAML is required. Install with: pip3 install --user pyyaml" >&2
  exit 1
}

# Locate the script's directory so we can source on-disk siblings. When doctor
# is invoked via `curl … | bash` there is no on-disk sibling; downstream code
# falls back to fetching from the same v1 source.
doctor_src="${BASH_SOURCE[0]:-}"
doctor_dir=""
if [[ -n "$doctor_src" ]]; then
  doctor_dir="$(cd "$(dirname "$doctor_src")" 2>/dev/null && pwd || true)"
fi

# The single invocation-mode flag. Derived from the one seam — on-disk siblings
# next to this script. Both dependency-loading (below) and remediation
# references (fix_script_cmd) branch on this so there is exactly one notion of
# how doctor was invoked.
if [[ -n "$doctor_dir" && -f "$doctor_dir/lib/findings.sh" ]]; then
  doctor_local=1   # checkout: on-disk siblings present
else
  doctor_local=0   # curl … | bash: fetch over the network
fi

# Resolve the flywheel scripts base URL for network fetches, honoring a pinned
# consumer (FLYWHEEL_TEMPLATES_BASE) and defaulting to main. Returns …/scripts.
flywheel_scripts_base() {
  local tb="${FLYWHEEL_TEMPLATES_BASE:-https://raw.githubusercontent.com/point-source/flywheel/main/scripts/templates}"
  printf '%s' "${tb%/templates}"
}

# Emit a remediation reference to a flywheel fix script in the same invocation
# mode doctor was run from. $1 = script filename (e.g. apply-rulesets.sh);
# remaining args = the arguments the script needs. Under a checkout (on-disk
# siblings present) emits the local scripts/… path; under curl emits the
# version-consistent network one-liner against the ref doctor was fetched from.
fix_script_cmd() {
  local script="$1"; shift
  local args="$*"
  # Emit the base command per mode, then append the args as a pure suffix only
  # when present — so an arg-less call (e.g. init.sh) yields a clean
  # `scripts/init.sh` / `curl … | bash` with no trailing space or dangling
  # `-s --`, while arg-bearing callers (apply-rulesets.sh) are byte-identical.
  if [[ "$doctor_local" == 1 ]]; then
    printf 'scripts/%s' "$script"
    [[ -n "$args" ]] && printf ' %s' "$args"
  else
    printf 'curl -fsSL %s/%s | bash' "$(flywheel_scripts_base)" "$script"
    [[ -n "$args" ]] && printf ' -s -- %s' "$args"
  fi
}

# Source the shared finding vocabulary (scripts/lib/findings.sh). Locate it next
# to this script; otherwise fetch it. The fetch ref follows FLYWHEEL_TEMPLATES_BASE
# when set (so a pinned consumer gets the matching findings.sh, not main),
# defaulting to main otherwise. Without it doctor cannot emit vocabulary
# findings — that is a hard error.
# shellcheck source=scripts/lib/findings.sh
if [[ "$doctor_local" == 1 ]]; then
  # shellcheck disable=SC1091
  . "$doctor_dir/lib/findings.sh"
else
  findings_tmp="$(mktemp)"
  if curl -fsSL "$(flywheel_scripts_base)/lib/findings.sh" -o "$findings_tmp" 2>/dev/null; then
    # shellcheck disable=SC1090
    . "$findings_tmp"
    rm -f "$findings_tmp"
  else
    rm -f "$findings_tmp"
    echo "error: could not locate or fetch scripts/lib/findings.sh — doctor cannot emit findings without it." >&2
    exit 1
  fi
fi

warns=0

# In --summary mode, bold section headers and green ok lines are suppressed so
# only real findings (and the machine trailer) reach stdout. fail/warn/note
# always emit — those are the findings init folds into its summary.
bold()  { [[ $summary_mode -eq 1 ]] && return 0; printf '\033[1m%s\033[0m\n' "$*"; }
ok()    { [[ $summary_mode -eq 1 ]] && return 0; printf '  \033[32m✓\033[0m %s\n' "$*"; }
# fail/warn are thin wrappers over the shared `finding` emitter: each takes a
# bucket as its first arg. fail → block (counted by FINDINGS_BLOCK_COUNT),
# warn → warn (counted locally for the summary line).
fail()  { finding "$1" block "$2"; }
warn()  { finding "$1" warn "$2"; warns=$((warns+1)); }
# note → info; same wrapper shape so NOTE sites read like the others.
note()  { finding "$1" info "$2"; }

# Classify a boolean field on an already-successful gh api response as one of
# `true` / `false` / `absent`. GitHub omits admin-gated fields (e.g. the merge
# settings) from the repo object entirely for an under-scoped or App token —
# the call still succeeds, and a plain `jq -r` reads the absent field back as
# `null`, indistinguishable from a genuine `false`. Branching on `has($f)`
# inside jq keeps "could not read it" from being reported as "it is disabled".
classify_repo_field() {
  local json="$1" field="$2"
  echo "$json" | jq -r --arg f "$field" \
    'if has($f) then (.[$f] == true) else "absent" end'
}

# Read a ruleset's detail JSON into the global RULESET_DETAIL. On a failed read
# — a permission gap where listing rulesets is allowed but reading one's detail
# requires repo-admin — emit a could-not-verify warn and return non-zero so the
# caller can mark coverage indeterminate and skip the ruleset. Sets a global
# rather than echoing, so the warn it emits reaches the report instead of being
# swallowed by a caller's command substitution (and `warns` increments persist).
read_ruleset_detail() {
  local rid="$1"
  if RULESET_DETAIL="$(gh api "repos/$REPO/rulesets/$rid" 2>/dev/null)"; then
    return 0
  fi
  warn local-env "could not verify ruleset $rid — reading it requires repo-admin"
  return 1
}

cwd_repo=""
if cwd_repo="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)"; then
  :
fi
if [[ -z "$REPO" ]]; then
  if [[ -z "$cwd_repo" ]]; then
    echo "error: pass owner/repo or run from inside a checked-out repo with 'gh auth login'." >&2
    exit 1
  fi
  REPO="$cwd_repo"
fi
# When validating a different repo than cwd, never trust local files —
# they belong to the running script's repo, not the target.
remote_only=0
if [[ "$REPO" != "$cwd_repo" ]]; then
  remote_only=1
fi

bold "Flywheel doctor — $REPO"

# 1. .flywheel.yml present and parseable.
bold ".flywheel.yml"
yml=""
if [[ $remote_only -eq 0 && -f .flywheel.yml ]]; then
  yml=".flywheel.yml"
  ok "found at $yml"
else
  if yml_content="$(gh api "repos/$REPO/contents/.flywheel.yml" -q .content 2>/dev/null)"; then
    yml="$(mktemp)"
    echo "$yml_content" | base64 --decode > "$yml"
    ok "fetched .flywheel.yml from $REPO"
  else
    fail instance "no .flywheel.yml in $REPO repo root"
    yml=""
  fi
fi

branches=()
if [[ -n "$yml" ]]; then
  # Locate the linter sibling. When doctor.sh is invoked via curl|bash
  # there are no on-disk siblings; fall back to fetching the linter from
  # the same v1 source. ($doctor_dir was resolved near the top.)
  linter=""
  if [[ -n "$doctor_dir" && -f "$doctor_dir/lint-flywheel-config.py" ]]; then
    linter="$doctor_dir/lint-flywheel-config.py"
  else
    linter="$(mktemp)"
    if ! curl -fsSL "https://raw.githubusercontent.com/point-source/flywheel/main/scripts/lint-flywheel-config.py" -o "$linter" 2>/dev/null; then
      linter=""
    fi
  fi

  if [[ -z "$linter" ]]; then
    fail instance ".flywheel.yml linter unavailable — could not locate or fetch lint-flywheel-config.py"
  elif validation="$(python3 "$linter" "$yml" 2>/dev/null)"; then
    have_branches_line=0
    while IFS= read -r line; do
      case "$line" in
        "BRANCHES "*)
          have_branches_line=1
          rest="${line#BRANCHES }"
          # shellcheck disable=SC2206
          branches=($rest)
          ;;
        "RESULT OK "*)   ok        "${line#RESULT OK }"   ;;
        "RESULT FAIL "*) fail config "${line#RESULT FAIL }" ;;
        "RESULT WARN "*) warn config "${line#RESULT WARN }" ;;
        "RESULT NOTE "*) note config "${line#RESULT NOTE }" ;;
      esac
    done <<< "$validation"
    if [[ $have_branches_line -eq 1 ]]; then
      if [[ "${#branches[@]}" -eq 0 ]]; then
        fail instance ".flywheel.yml has no branches"
      else
        ok "${#branches[@]} managed branch(es): ${branches[*]}"
      fi
    fi
  else
    fail instance ".flywheel.yml linter crashed — is PyYAML installed? (pip3 install --user pyyaml)"
  fi
fi

# 2. Each managed branch exists on the remote.
if [[ "${#branches[@]}" -gt 0 ]]; then
  bold "Managed branches exist on $REPO"
  for b in "${branches[@]}"; do
    if gh api "repos/$REPO/branches/$b" >/dev/null 2>&1; then
      ok "$b"
    else
      fail instance "branch '$b' missing on remote"
    fi
  done
fi

# 3. App-token credentials. The App ID lives in a Variable (it's public
# information, visible on the App's settings page); the private key lives in
# a Secret. Both can live at repo level OR at org level (with visibility=all
# or visibility=selected including this repo) — GitHub resolves repo → org at
# workflow run time. Listing either requires an admin PAT — GitHub App
# installation tokens are NOT permitted to read variables or secrets
# regardless of granted permissions. CI flows that already minted an App
# token before invoking doctor should pass --skip-credentials; the mint
# itself is the credential check.

OWNER="${REPO%%/*}"
OWNER_TYPE_RESOLVED=0
OWNER_TYPE=""
detect_owner_type() {
  if [[ $OWNER_TYPE_RESOLVED -eq 0 ]]; then
    OWNER_TYPE="$(gh api "users/$OWNER" --jq .type 2>/dev/null || true)"
    OWNER_TYPE_RESOLVED=1
  fi
}

# Returns 0 if the named org-level resource exists AND is reachable from $REPO
# (via visibility=all, visibility=private when the repo is private, or
# visibility=selected with $REPO in the selected list). Echoes a one-word
# reason on success ("all", "private", or "selected") for the OK message.
# $1 = "variables" or "secrets"
# $2 = resource name
org_resource_visible_to_repo() {
  local kind="$1" name="$2" resp visibility repo_obj
  detect_owner_type
  [[ "$OWNER_TYPE" == "Organization" ]] || return 1
  resp="$(gh api "orgs/$OWNER/actions/$kind/$name" 2>/dev/null)" || return 1
  visibility="$(echo "$resp" | jq -r .visibility 2>/dev/null || echo "")"
  case "$visibility" in
    all)
      echo "all"
      return 0
      ;;
    private)
      # Branch on the repo read SUCCEEDING — a failed/permission-gapped call
      # must not collapse to "" and read back as "repo is not private".
      # `.private` is always present on a successful repo read, so
      # classify_repo_field returns true/false here, never "absent".
      if repo_obj="$(gh api "repos/$REPO" 2>/dev/null)"; then
        if [[ "$(classify_repo_field "$repo_obj" private)" == "true" ]]; then
          echo "private"
          return 0
        fi
      fi
      return 1
      ;;
    selected)
      if gh api "orgs/$OWNER/actions/$kind/$name/repositories" \
           --jq '.repositories[].full_name' 2>/dev/null \
           | grep -qx "$REPO"; then
        echo "selected"
        return 0
      fi
      return 1
      ;;
    *) return 1 ;;
  esac
}

bold "App-token credentials"
# Reassurance appended to every non-pass credential outcome (skipped and
# could-not-verify alike), defined once so the wording cannot drift between the
# two sites. A credential that doctor couldn't see from this machine is NOT a
# credential that's missing — keep the two states visibly distinct.
cred_reassurance="a skipped or unverifiable credential check does not mean flywheel won't work; it means only that doctor could not verify that area from here"
if [[ $skip_credentials -eq 1 ]]; then
  note config "skipped (--skip-credentials) — caller is responsible for verifying FLYWHEEL_GH_APP_ID and FLYWHEEL_GH_APP_PRIVATE_KEY out of band; $cred_reassurance"
else
  # FLYWHEEL_GH_APP_ID — repo level first, then org level.
  # var_could_not_verify tracks the could-not-verify state: the repo list call
  # failed (the common local case — an ordinary `gh auth login` token or an App
  # installation token cannot list variables). That is a limit on the local
  # token, not a missing variable, so it must NOT collapse into a "missing"
  # block.
  found_var_at=""
  var_could_not_verify=0
  if vars_json="$(gh api "repos/$REPO/actions/variables" 2>/dev/null)"; then
    if echo "$vars_json" | jq -e '.variables[] | select(.name == "FLYWHEEL_GH_APP_ID")' >/dev/null; then
      found_var_at="repo"
    fi
  else
    var_could_not_verify=1
  fi
  # Only consult org level when the repo list SUCCEEDED-but-empty. If it failed
  # for scope, the org call would fail the same way and add a guaranteed-failing
  # request — skip it (mirrors §spec:doctor-settings-read branching on call
  # success).
  if [[ -z "$found_var_at" && $var_could_not_verify -eq 0 ]]; then
    if visibility="$(org_resource_visible_to_repo variables FLYWHEEL_GH_APP_ID)"; then
      found_var_at="org ($visibility)"
    fi
  fi
  if [[ -n "$found_var_at" ]]; then
    ok "FLYWHEEL_GH_APP_ID variable set ($found_var_at)"
  elif [[ $var_could_not_verify -eq 1 ]]; then
    warn local-env "could not verify FLYWHEEL_GH_APP_ID variable — listing variables requires an admin PAT (App installation tokens cannot list variables); this is a limit on the local token, not a defect in the repo. Re-run with 'gh auth login' as a repo admin, or pass --skip-credentials if invoking from CI that already minted an App token. $cred_reassurance"
  else
    fail config "FLYWHEEL_GH_APP_ID variable missing — set with: gh variable set FLYWHEEL_GH_APP_ID --body <app-id> --repo $REPO  (or --org $OWNER --visibility all for org-wide)"
  fi

  # FLYWHEEL_GH_APP_PRIVATE_KEY — repo level first, then org level.
  # secret_could_not_verify mirrors var_could_not_verify above.
  found_secret_at=""
  secret_could_not_verify=0
  if secrets_json="$(gh api "repos/$REPO/actions/secrets" 2>/dev/null)"; then
    if echo "$secrets_json" | jq -e '.secrets[] | select(.name == "FLYWHEEL_GH_APP_PRIVATE_KEY")' >/dev/null; then
      found_secret_at="repo"
    fi
    if echo "$secrets_json" | jq -e '.secrets[] | select(.name == "GH_PAT")' >/dev/null; then
      warn config "GH_PAT secret present — Flywheel does not use it; remove if it's left over from an older setup"
    fi
  else
    secret_could_not_verify=1
  fi
  if [[ -z "$found_secret_at" && $secret_could_not_verify -eq 0 ]]; then
    if visibility="$(org_resource_visible_to_repo secrets FLYWHEEL_GH_APP_PRIVATE_KEY)"; then
      found_secret_at="org ($visibility)"
    fi
  fi
  if [[ -n "$found_secret_at" ]]; then
    ok "FLYWHEEL_GH_APP_PRIVATE_KEY secret set ($found_secret_at)"
  elif [[ $secret_could_not_verify -eq 1 ]]; then
    warn local-env "could not verify FLYWHEEL_GH_APP_PRIVATE_KEY secret — listing secrets requires an admin PAT (App installation tokens cannot list secrets); this is a limit on the local token, not a defect in the repo. Re-run with 'gh auth login' as a repo admin, or pass --skip-credentials if invoking from CI that already minted an App token. $cred_reassurance"
  else
    fail config "FLYWHEEL_GH_APP_PRIVATE_KEY secret missing — Flywheel requires GitHub App tokens (PATs are not supported)"
  fi
fi

# 4. Repo settings: allow_auto_merge, delete_branch_on_merge.
bold "Repo settings"
if repo_settings="$(gh api "repos/$REPO" 2>/dev/null)"; then
  case "$(classify_repo_field "$repo_settings" allow_auto_merge)" in
    true)  ok "allow_auto_merge enabled" ;;
    false) warn config "allow_auto_merge disabled — flywheel cannot schedule native auto-merge, so eligible PRs fall back to a direct merge that bypasses required status checks (#147). Re-run $(fix_script_cmd apply-rulesets.sh "$REPO --app-id <your-app-id>"), or enable in Settings → General → Pull Requests → Allow auto-merge" ;;
    absent) warn local-env "could not verify allow_auto_merge — reading it requires repo-admin" ;;
    *) warn local-env "could not verify allow_auto_merge — unexpected response from repos/$REPO" ;;
  esac
  case "$(classify_repo_field "$repo_settings" delete_branch_on_merge)" in
    true)  ok "delete_branch_on_merge enabled (head branches auto-delete on merge)" ;;
    false) warn config "delete_branch_on_merge disabled — apply-rulesets.sh enables this alongside the deletion-blocking ruleset (re-run $(fix_script_cmd apply-rulesets.sh "$REPO --app-id <your-app-id>")), or flip manually in Settings → General → 'Automatically delete head branches'" ;;
    absent) warn local-env "could not verify delete_branch_on_merge — reading it requires repo-admin" ;;
    *) warn local-env "could not verify delete_branch_on_merge — unexpected response from repos/$REPO" ;;
  esac
else
  fail instance "could not read repo settings"
fi

# 5. Workflow files. Read from cwd when validating the local repo,
# fetch from $REPO otherwise so the check reflects the remote contents.
bold "Workflow files"
for wf in flywheel-pr.yml flywheel-push.yml; do
  path=".github/workflows/$wf"
  content=""
  if [[ $remote_only -eq 0 && -f "$path" ]]; then
    content="$(cat "$path")"
  elif wf_content="$(gh api "repos/$REPO/contents/$path" -q .content 2>/dev/null)"; then
    content="$(echo "$wf_content" | base64 --decode)"
  else
    fail instance "$path missing in $REPO"
    continue
  fi
  # Match either the action ref (`point-source/flywheel@<ver>`), the reusable
  # workflow ref (`point-source/flywheel/.github/workflows/{pr,push}.yml@<ver>`),
  # or the local-checkout form used in this repo's dogfood.
  if echo "$content" | grep -qE "point-source/flywheel(/\.github/workflows/[a-z]+\.yml)?@|uses:[[:space:]]*\./"; then
    ok "$path references the flywheel action"
  else
    fail instance "$path exists but does not reference point-source/flywheel@<version>"
  fi
  if echo "$content" | grep -qE "(app-id:|actions/create-github-app-token)"; then
    ok "$path uses App-token plumbing"
  else
    warn instance "$path does not use app-id input or actions/create-github-app-token — Flywheel expects App-token plumbing"
  fi
done

# 5b. Quality workflows (any non-flywheel workflow on pull_request) should
# also subscribe to merge_group — otherwise the merge queue stalls forever
# waiting for a check that never fires. Local-only check; remote scan would
# need a directory listing API call per workflow.
if [[ $remote_only -eq 0 ]]; then
  bold "Quality workflows include merge_group trigger"
  found_any=0
  for path in .github/workflows/*.yml .github/workflows/*.yaml; do
    [[ -f "$path" ]] || continue
    base="$(basename "$path")"
    case "$base" in flywheel-*.yml|flywheel-*.yaml) continue ;; esac
    if grep -qE '^[[:space:]]*pull_request:' "$path"; then
      found_any=1
      if grep -qE '^[[:space:]]*merge_group:' "$path"; then
        ok "$path triggers on merge_group"
      else
        warn config "$path triggers on pull_request but not merge_group — required-check workflows must include merge_group: to unblock the merge queue"
      fi
    fi
  done
  [[ $found_any -eq 0 ]] && ok "no non-flywheel pull_request workflows to inspect"
fi

# 6. Branch ruleset(s) covering each managed branch.
bold "Branch protection rulesets"
if rulesets_json="$(gh api "repos/$REPO/rulesets" 2>/dev/null)"; then
  branch_ruleset_ids="$(echo "$rulesets_json" | jq -r '.[] | select(.target == "branch") | .id')"
  if [[ -z "$branch_ruleset_ids" ]]; then
    fail instance "no branch rulesets defined — run $(fix_script_cmd apply-rulesets.sh "$REPO --app-id <your-app-id>")"
  else
    # Parallel arrays (bash 3.2 compatible — no associative arrays).
    ruleset_includes=()
    ruleset_has_pr=()
    # Track whether any ruleset DETAIL read failed (permission gap). A failed
    # detail call must not collapse into empty includes and surface as a false
    # "no ruleset covers branch" BLOCK — it is a could-not-verify warn instead.
    ruleset_detail_unreadable=0
    while read -r rid; do
      [[ -z "$rid" ]] && continue
      if ! read_ruleset_detail "$rid"; then
        ruleset_detail_unreadable=1
        continue
      fi
      detail="$RULESET_DETAIL"
      includes="$(echo "$detail" | jq -r '.conditions.ref_name.include[]?' 2>/dev/null)"
      has_pr="$(echo "$detail" | jq -r '[.rules[]? | select(.type == "pull_request")] | length' 2>/dev/null)"
      while IFS= read -r inc; do
        [[ -z "$inc" ]] && continue
        ruleset_includes+=("$inc")
        ruleset_has_pr+=("${has_pr:-0}")
      done <<< "$includes"
    done <<< "$branch_ruleset_ids"

    for b in "${branches[@]}"; do
      ref="refs/heads/$b"
      matched=0
      pr_required=0
      i=0
      while [[ $i -lt ${#ruleset_includes[@]} ]]; do
        inc="${ruleset_includes[$i]}"
        if [[ "$inc" == "$ref" || "$inc" == "~ALL" ]]; then
          matched=1
          [[ "${ruleset_has_pr[$i]}" -gt 0 ]] && pr_required=1
        fi
        i=$((i+1))
      done
      if [[ $matched -eq 0 ]]; then
        if [[ $ruleset_detail_unreadable -eq 1 ]]; then
          warn local-env "could not verify branch '$b' is covered by a ruleset — reading rulesets requires repo-admin"
        else
          fail instance "no ruleset covers branch '$b' — run $(fix_script_cmd apply-rulesets.sh "$REPO --app-id <your-app-id>")"
        fi
      elif [[ $pr_required -eq 0 ]]; then
        if [[ $ruleset_detail_unreadable -eq 1 ]]; then
          # A matched branch with no PR rule among the READABLE rulesets is only
          # a genuine misconfiguration if every ruleset was readable — an unread
          # ruleset could carry the PR requirement, so report could-not-verify
          # rather than a false block (#239).
          warn local-env "could not verify branch '$b' pull_request requirement — reading rulesets requires repo-admin"
        else
          fail instance "branch '$b' is in a ruleset but no pull_request requirement — re-run $(fix_script_cmd apply-rulesets.sh "$REPO --app-id <your-app-id>")"
        fi
      else
        ok "branch '$b' protected, requires PRs"
      fi
    done
  fi
else
  fail instance "could not list rulesets"
fi

# 7. Tag-namespace ruleset on v*.
bold "Tag namespace ruleset"
if [[ -n "${rulesets_json:-}" ]]; then
  tag_ruleset_ids="$(echo "$rulesets_json" | jq -r '.[] | select(.target == "tag") | .id')"
  found_v_protect=0
  tag_ruleset_detail_unreadable=0
  while read -r rid; do
    [[ -z "$rid" ]] && continue
    if ! read_ruleset_detail "$rid"; then
      tag_ruleset_detail_unreadable=1
      continue
    fi
    detail="$RULESET_DETAIL"
    if echo "$detail" | jq -e '.conditions.ref_name.include[]? | select(. == "refs/tags/v*")' >/dev/null 2>&1; then
      found_v_protect=1
    fi
  done <<< "$tag_ruleset_ids"
  if [[ $found_v_protect -eq 1 ]]; then
    ok "v* tag namespace protected"
  elif [[ $tag_ruleset_detail_unreadable -eq 1 ]]; then
    warn local-env "could not verify 'refs/tags/v*' protection — reading rulesets requires repo-admin"
  else
    fail instance "no ruleset protects 'refs/tags/v*' — run $(fix_script_cmd apply-rulesets.sh "$REPO --app-id <your-app-id>")"
  fi
fi

# 8. .gitattributes merge-driver block. Local-only — requires reading the
# adopter's checked-in .gitattributes against their .flywheel.yml. The CI
# back-merge step injects equivalent rules into .git/info/attributes at run
# time, so a missing block here doesn't break CI; it only matters for local
# developer merges (e.g. `git pull main`). See issue #112.
if [[ $remote_only -eq 0 && -n "$yml" ]]; then
  bold ".gitattributes merge drivers"
  if [[ ! -f .gitattributes ]]; then
    warn instance ".gitattributes missing — local merges of CHANGELOG.md will fall back to text merge (CI is unaffected). Re-run $(fix_script_cmd init.sh) to write the managed block."
  elif ! grep -qF "flywheel: managed merge-driver attributes" .gitattributes; then
    warn instance ".gitattributes lacks Flywheel-managed block — re-run $(fix_script_cmd init.sh) to add it."
  else
    if grep -qE '^CHANGELOG\.md[[:space:]]+merge=flywheel-changelog' .gitattributes; then
      ok "CHANGELOG.md mapped to flywheel-changelog driver"
    else
      warn instance ".gitattributes block exists but missing 'CHANGELOG.md merge=flywheel-changelog' — re-run $(fix_script_cmd init.sh)."
    fi
    # Each release_files entry in .flywheel.yml should also have a
    # merge=flywheel-release-file mapping. Init writes a comment template
    # but not per-path entries (paths are adopter-specific); doctor surfaces
    # the drift so adopters know to add them.
    missing_paths="$(python3 - "$yml" <<'PY' || true
import sys, yaml, pathlib
yml_path = sys.argv[1]
attrs = pathlib.Path('.gitattributes').read_text() if pathlib.Path('.gitattributes').exists() else ''
try:
    with open(yml_path) as f:
        cfg = yaml.safe_load(f) or {}
except Exception:
    sys.exit(0)
files = (cfg.get('flywheel') or {}).get('release_files') or []
for entry in files:
    path = entry.get('path') if isinstance(entry, dict) else None
    if not path:
        continue
    needle = f"{path} merge=flywheel-release-file"
    if needle not in attrs:
        print(path)
PY
)"
    if [[ -n "$missing_paths" ]]; then
      while IFS= read -r p; do
        [[ -z "$p" ]] && continue
        warn instance "release_files path '$p' lacks merge=flywheel-release-file in .gitattributes — add: '$p merge=flywheel-release-file'"
      done <<< "$missing_paths"
    else
      ok "release_files paths covered (or none declared)"
    fi
  fi
fi

# Summary. Exit 1 iff any block-severity finding was emitted (tracked by the
# shared FINDINGS_BLOCK_COUNT), else 0 — warnings/info never fail the run.
# In --summary mode, suppress the human FAIL/OK block and instead print a single
# machine-readable trailer as the last line (mirrors the linter→doctor RESULT
# convention) for init.sh to parse.
if [[ $summary_mode -eq 1 ]]; then
  printf 'DOCTOR_RESULT blocks=%d warns=%d\n' "$FINDINGS_BLOCK_COUNT" "$warns"
else
  echo
  if [[ "$FINDINGS_BLOCK_COUNT" -gt 0 ]]; then
    printf '\033[31mFAIL\033[0m — %d blocking finding(s), %d warning(s)\n' "$FINDINGS_BLOCK_COUNT" "$warns"
  elif [[ $warns -gt 0 ]]; then
    printf '\033[33mOK with warnings\033[0m — %d warning(s)\n' "$warns"
  else
    printf '\033[32mOK\033[0m — all checks pass\n'
  fi
fi
exit "$(findings_exit_code)"
