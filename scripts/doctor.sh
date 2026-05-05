#!/usr/bin/env bash
# doctor.sh — validate that a repo is correctly configured for Flywheel.
#
# Read-only. Exits 0 if every check passes, 1 if any FAIL is reported.
# Usage:
#   ./scripts/doctor.sh [owner/repo]
# If owner/repo is omitted, uses 'gh repo view' on the current directory.
#
# Dependencies: git, gh, jq, python3 with PyYAML.

set -uo pipefail

REPO="${1:-}"
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

# 3. App-token secrets. Listing secrets requires an admin PAT with the
# 'secrets:read' scope; GitHub App installation tokens are NOT permitted
# to read secrets via the API regardless of granted permissions. When the
# listing fails, downgrade to a warning rather than a hard fail so doctor
# can still pass when invoked with App credentials.
bold "Repo secrets"
if secrets_json="$(gh api "repos/$REPO/actions/secrets" 2>/dev/null)"; then
  for name in FLYWHEEL_GH_APP_ID FLYWHEEL_GH_APP_PRIVATE_KEY; do
    if echo "$secrets_json" | jq -e --arg n "$name" '.secrets[] | select(.name == $n)' >/dev/null; then
      ok "$name set"
    else
      fail "$name missing — Flywheel requires GitHub App tokens (PATs are not supported)"
    fi
  done
  if echo "$secrets_json" | jq -e '.secrets[] | select(.name == "GH_PAT")' >/dev/null; then
    warn "GH_PAT secret present — Flywheel does not use it; remove if it's left over from an older setup"
  fi
else
  warn "could not list repo secrets — verify FLYWHEEL_GH_APP_ID and FLYWHEEL_GH_APP_PRIVATE_KEY are set in repo Settings → Secrets and variables → Actions (App tokens cannot list secrets)"
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
    warn "delete_branch_on_merge disabled — recommended on to enforce one-PR-per-branch (Settings → General → 'Automatically delete head branches', or: gh api -X PATCH repos/$REPO -f delete_branch_on_merge=true)"
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
  if echo "$content" | grep -qE "point-source/flywheel@|uses:[[:space:]]*\./"; then
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
