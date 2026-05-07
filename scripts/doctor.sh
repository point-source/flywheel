#!/usr/bin/env bash
# doctor.sh — validate that a repo is correctly configured for Flywheel.
#
# Read-only. Exits 0 if every check passes, 1 if any FAIL is reported.
# Usage:
#   ./scripts/doctor.sh [--skip-credentials] [owner/repo]
# If owner/repo is omitted, uses 'gh repo view' on the current directory.
#
# --skip-credentials skips the FLYWHEEL_GH_APP_ID / FLYWHEEL_GH_APP_PRIVATE_KEY
# checks. Use it from CI runs that already proved the credentials work by
# minting an App installation token (the mint failing is itself a hard
# error, so a downstream listing check is redundant). Without the flag,
# doctor expects to be run with a token that can list repo Variables and
# Secrets — i.e. an admin PAT.
#
# Dependencies: git, gh, jq, python3 with PyYAML.

set -uo pipefail

skip_credentials=0
REPO=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-credentials) skip_credentials=1; shift ;;
    -h|--help)
      cat <<'EOF'
doctor.sh — validate that a repo is correctly configured for Flywheel.

Usage: ./scripts/doctor.sh [--skip-credentials] [owner/repo]

If owner/repo is omitted, uses 'gh repo view' on the current directory.

  --skip-credentials  Skip the FLYWHEEL_GH_APP_ID / FLYWHEEL_GH_APP_PRIVATE_KEY
                      checks. Use this from CI runs that already proved the
                      credentials work by minting an App installation token.
                      Without the flag, doctor expects a token that can list
                      repo Variables and Secrets (an admin PAT).
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

fails=0
warns=0

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail()  { printf '  \033[31m✗\033[0m %s\n' "$*"; fails=$((fails+1)); }
warn()  { printf '  \033[33m!\033[0m %s\n' "$*"; warns=$((warns+1)); }

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
    fail "no .flywheel.yml in $REPO repo root"
    yml=""
  fi
fi

branches=()
if [[ -n "$yml" ]]; then
  # Locate the linter sibling. When doctor.sh is invoked via curl|bash
  # there are no on-disk siblings; fall back to fetching the linter from
  # the same v1 source.
  doctor_src="${BASH_SOURCE[0]:-}"
  doctor_dir=""
  if [[ -n "$doctor_src" ]]; then
    doctor_dir="$(cd "$(dirname "$doctor_src")" 2>/dev/null && pwd || true)"
  fi
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
    fail ".flywheel.yml linter unavailable — could not locate or fetch lint-flywheel-config.py"
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
        "RESULT OK "*)   ok   "${line#RESULT OK }"   ;;
        "RESULT FAIL "*) fail "${line#RESULT FAIL }" ;;
        "RESULT WARN "*) warn "${line#RESULT WARN }" ;;
        "RESULT NOTE "*) printf '  \033[36mi\033[0m %s\n' "${line#RESULT NOTE }" ;;
      esac
    done <<< "$validation"
    if [[ $have_branches_line -eq 1 ]]; then
      if [[ "${#branches[@]}" -eq 0 ]]; then
        fail ".flywheel.yml has no branches"
      else
        ok "${#branches[@]} managed branch(es): ${branches[*]}"
      fi
    fi
  else
    fail ".flywheel.yml linter crashed — is PyYAML installed? (pip3 install --user pyyaml)"
  fi
fi

# 2. Each managed branch exists on the remote.
if [[ "${#branches[@]}" -gt 0 ]]; then
  bold "Managed branches exist on $REPO"
  for b in "${branches[@]}"; do
    if gh api "repos/$REPO/branches/$b" >/dev/null 2>&1; then
      ok "$b"
    else
      fail "branch '$b' missing on remote"
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
  local kind="$1" name="$2" resp visibility priv
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
      priv="$(gh api "repos/$REPO" --jq .private 2>/dev/null || echo "")"
      if [[ "$priv" == "true" ]]; then
        echo "private"
        return 0
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
if [[ $skip_credentials -eq 1 ]]; then
  printf '  \033[36mi\033[0m skipped (--skip-credentials) — caller is responsible for verifying FLYWHEEL_GH_APP_ID and FLYWHEEL_GH_APP_PRIVATE_KEY out of band\n'
else
  # FLYWHEEL_GH_APP_ID — repo level first, then org level.
  found_var_at=""
  if vars_json="$(gh api "repos/$REPO/actions/variables" 2>/dev/null)"; then
    if echo "$vars_json" | jq -e '.variables[] | select(.name == "FLYWHEEL_GH_APP_ID")' >/dev/null; then
      found_var_at="repo"
    fi
  else
    fail "could not list repo variables — listing requires an admin PAT (App installation tokens cannot list variables); re-run with 'gh auth login' as a repo admin, or pass --skip-credentials if invoking from CI that already minted an App token"
  fi
  if [[ -z "$found_var_at" ]]; then
    if visibility="$(org_resource_visible_to_repo variables FLYWHEEL_GH_APP_ID)"; then
      found_var_at="org ($visibility)"
    fi
  fi
  if [[ -n "$found_var_at" ]]; then
    ok "FLYWHEEL_GH_APP_ID variable set ($found_var_at)"
  else
    fail "FLYWHEEL_GH_APP_ID variable missing — set with: gh variable set FLYWHEEL_GH_APP_ID --body <app-id> --repo $REPO  (or --org $OWNER --visibility all for org-wide)"
  fi

  # FLYWHEEL_GH_APP_PRIVATE_KEY — repo level first, then org level.
  found_secret_at=""
  if secrets_json="$(gh api "repos/$REPO/actions/secrets" 2>/dev/null)"; then
    if echo "$secrets_json" | jq -e '.secrets[] | select(.name == "FLYWHEEL_GH_APP_PRIVATE_KEY")' >/dev/null; then
      found_secret_at="repo"
    fi
    if echo "$secrets_json" | jq -e '.secrets[] | select(.name == "GH_PAT")' >/dev/null; then
      warn "GH_PAT secret present — Flywheel does not use it; remove if it's left over from an older setup"
    fi
  else
    fail "could not list repo secrets — listing requires an admin PAT (App installation tokens cannot list secrets); re-run with 'gh auth login' as a repo admin, or pass --skip-credentials if invoking from CI that already minted an App token"
  fi
  if [[ -z "$found_secret_at" ]]; then
    if visibility="$(org_resource_visible_to_repo secrets FLYWHEEL_GH_APP_PRIVATE_KEY)"; then
      found_secret_at="org ($visibility)"
    fi
  fi
  if [[ -n "$found_secret_at" ]]; then
    ok "FLYWHEEL_GH_APP_PRIVATE_KEY secret set ($found_secret_at)"
  else
    fail "FLYWHEEL_GH_APP_PRIVATE_KEY secret missing — Flywheel requires GitHub App tokens (PATs are not supported)"
  fi
fi

# 4. Repo settings: allow_auto_merge, delete_branch_on_merge.
bold "Repo settings"
if repo_settings="$(gh api "repos/$REPO" 2>/dev/null)"; then
  if [[ "$(echo "$repo_settings" | jq -r .allow_auto_merge)" == "true" ]]; then
    ok "allow_auto_merge enabled"
  else
    fail "allow_auto_merge disabled — enable in Settings → General → Pull Requests → Allow auto-merge"
  fi
  if [[ "$(echo "$repo_settings" | jq -r .delete_branch_on_merge)" == "true" ]]; then
    ok "delete_branch_on_merge enabled (head branches auto-delete on merge)"
  else
    warn "delete_branch_on_merge disabled — apply-rulesets.sh enables this alongside the deletion-blocking ruleset (re-run scripts/apply-rulesets.sh $REPO), or flip manually in Settings → General → 'Automatically delete head branches'"
  fi
else
  fail "could not read repo settings"
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
    fail "$path missing in $REPO"
    continue
  fi
  # Match either the action ref (`point-source/flywheel@<ver>`), the reusable
  # workflow ref (`point-source/flywheel/.github/workflows/{pr,push}.yml@<ver>`),
  # or the local-checkout form used in this repo's dogfood.
  if echo "$content" | grep -qE "point-source/flywheel(/\.github/workflows/[a-z]+\.yml)?@|uses:[[:space:]]*\./"; then
    ok "$path references the flywheel action"
  else
    fail "$path exists but does not reference point-source/flywheel@<version>"
  fi
  if echo "$content" | grep -qE "(app-id:|actions/create-github-app-token)"; then
    ok "$path uses App-token plumbing"
  else
    warn "$path does not use app-id input or actions/create-github-app-token — Flywheel expects App-token plumbing"
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
        warn "$path triggers on pull_request but not merge_group — required-check workflows must include merge_group: to unblock the merge queue"
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
    fail "no branch rulesets defined — run scripts/apply-rulesets.sh $REPO"
  else
    # Parallel arrays (bash 3.2 compatible — no associative arrays).
    ruleset_includes=()
    ruleset_has_pr=()
    while read -r rid; do
      [[ -z "$rid" ]] && continue
      detail="$(gh api "repos/$REPO/rulesets/$rid" 2>/dev/null || true)"
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
        fail "no ruleset covers branch '$b' — run scripts/apply-rulesets.sh $REPO"
      elif [[ $pr_required -eq 0 ]]; then
        fail "branch '$b' is in a ruleset but no pull_request requirement — re-run scripts/apply-rulesets.sh"
      else
        ok "branch '$b' protected, requires PRs"
      fi
    done
  fi
else
  fail "could not list rulesets"
fi

# 7. Tag-namespace ruleset on v*.
bold "Tag namespace ruleset"
if [[ -n "${rulesets_json:-}" ]]; then
  tag_ruleset_ids="$(echo "$rulesets_json" | jq -r '.[] | select(.target == "tag") | .id')"
  found_v_protect=0
  while read -r rid; do
    [[ -z "$rid" ]] && continue
    detail="$(gh api "repos/$REPO/rulesets/$rid" 2>/dev/null || true)"
    if echo "$detail" | jq -e '.conditions.ref_name.include[]? | select(. == "refs/tags/v*")' >/dev/null 2>&1; then
      found_v_protect=1
    fi
  done <<< "$tag_ruleset_ids"
  if [[ $found_v_protect -eq 1 ]]; then
    ok "v* tag namespace protected"
  else
    fail "no ruleset protects 'refs/tags/v*' — run scripts/apply-rulesets.sh $REPO"
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
    warn ".gitattributes missing — local merges of CHANGELOG.md will fall back to text merge (CI is unaffected). Re-run scripts/init.sh to write the managed block."
  elif ! grep -qF "flywheel: managed merge-driver attributes" .gitattributes; then
    warn ".gitattributes lacks Flywheel-managed block — re-run scripts/init.sh to add it."
  else
    if grep -qE '^CHANGELOG\.md[[:space:]]+merge=flywheel-changelog' .gitattributes; then
      ok "CHANGELOG.md mapped to flywheel-changelog driver"
    else
      warn ".gitattributes block exists but missing 'CHANGELOG.md merge=flywheel-changelog' — re-run scripts/init.sh."
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
        warn "release_files path '$p' lacks merge=flywheel-release-file in .gitattributes — add: '$p merge=flywheel-release-file'"
      done <<< "$missing_paths"
    else
      ok "release_files paths covered (or none declared)"
    fi
  fi
fi

# Summary.
echo
if [[ $fails -gt 0 ]]; then
  printf '\033[31mFAIL\033[0m — %d failing check(s), %d warning(s)\n' "$fails" "$warns"
  exit 1
elif [[ $warns -gt 0 ]]; then
  printf '\033[33mOK with warnings\033[0m — %d warning(s)\n' "$warns"
  exit 0
else
  printf '\033[32mOK\033[0m — all checks pass\n'
  exit 0
fi
