#!/usr/bin/env bash
# scripts/back-merge.sh
#
# Replays a release commit + tag from the currently-checked-out branch
# (`$RELEASED_BRANCH`) back into each upstream branch in `$BACK_MERGE_TARGETS`
# via a true `git merge`, so ancestry is preserved and the next prerelease
# cycle on those upstreams computes from a synced state.
#
# Run as the "Back-merge release into upstream branches" step of the
# Flywheel push workflow (`flywheel-push.yml` / the reusable `push.yml`).
# Extracted from inline YAML in #128 so it can be shellchecked and
# exercised end-to-end by `tests/back-merge.test.ts` — three of the four
# production-halting back-merge bugs (#112, #119, and the apostrophe-
# escape typo in #128 that errored before any merge or fallback PR could
# open) lived in the inline shell with no pre-merge test coverage.
#
# Required env:
#   GITHUB_TOKEN          App installation token with write scope on
#                         `$GITHUB_REPOSITORY`. Used as a Basic-auth
#                         extraheader for `git fetch`/`push` and as the
#                         token `gh` uses for the fallback `gh pr create`.
#   GITHUB_REPOSITORY     `<owner>/<repo>`. Required by `gh`.
#   RELEASED_BRANCH       Name of the branch the release just landed on.
#                         Usually `main`. Tag must point at its HEAD.
#   BACK_MERGE_TARGETS    Comma-separated list of upstream branches to
#                         back-merge into (e.g., `develop` or
#                         `develop,staging`).
#
# Exits 0 on success or when there's no tag at HEAD (semantic-release
# didn't publish a release). Non-zero exit means a real failure that
# must surface in the workflow run; the fallback PR path is the
# *recovery* mechanism, not an error mode.

set -euo pipefail

: "${GITHUB_TOKEN:?GITHUB_TOKEN must be set}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must be set}"
: "${RELEASED_BRANCH:?RELEASED_BRANCH must be set}"
: "${BACK_MERGE_TARGETS:?BACK_MERGE_TARGETS must be set}"

new_tags="$(git tag --points-at HEAD)"
if [[ -z "$new_tags" ]]; then
  echo "::notice::No tag at HEAD — semantic-release did not publish a release. Skipping back-merge."
  exit 0
fi
new_tag="$(echo "$new_tags" | head -n1)"

git config user.name  'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'

# The checkout step ran with `persist-credentials: false` (so the
# workflow's read-scope default GITHUB_TOKEN couldn't shadow
# semantic-release's own push URL during the release step). Back-merge
# needs write scope, so set the extraheader explicitly here using the
# App token (already exported as GITHUB_TOKEN). Mirrors actions/checkout's
# mechanism. Runner is torn down after the job, so persisting in
# `.git/config` has no security cost.
auth_header="Authorization: Basic $(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 | tr -d '\n')"
git config "http.https://github.com/.extraheader" "$auth_header"

# Slugify tag for use in branch names (strip stream/v prefix slash etc.).
safe_tag="${new_tag//[^A-Za-z0-9._-]/-}"

IFS=',' read -ra UPSTREAMS <<< "$BACK_MERGE_TARGETS"
for upstream in "${UPSTREAMS[@]}"; do
  echo "::group::Back-merge $RELEASED_BRANCH ($new_tag) → $upstream"
  git fetch origin "$upstream:$upstream"
  # Operate on a throwaway local branch — we only push to the protected
  # upstream when the merge lands clean. Conflicted states get pushed to
  # a separate PR branch instead.
  git checkout -B _flywheel_back_merge_tmp "$upstream"

  if git merge --ff-only "$RELEASED_BRANCH" 2>/dev/null; then
    git push origin "_flywheel_back_merge_tmp:$upstream"
    echo "Fast-forwarded $upstream to $RELEASED_BRANCH."
  elif git merge --no-ff -m "chore: back-merge $new_tag from $RELEASED_BRANCH into $upstream" "$RELEASED_BRANCH"; then
    git push origin "_flywheel_back_merge_tmp:$upstream"
    echo "Auto-merged $RELEASED_BRANCH into $upstream."
  else
    echo "::warning::back-merge of $new_tag into $upstream failed; opening review PR."
    pr_branch="chore/back-merge-${safe_tag}-into-${upstream}"
    existing="$(gh pr list --head "$pr_branch" --base "$upstream" --state open --json number --jq '.[0].number' 2>/dev/null || true)"
    if [[ -n "$existing" ]]; then
      echo "::notice::back-merge PR #$existing already open for $upstream — skipping."
      git merge --abort 2>/dev/null || true
    else
      # `git commit` refuses to commit unresolved conflicts. `git add -A`
      # followed by `commit --no-verify` works — the resulting commit
      # literally contains the conflict markers, which is what the PR
      # reviewer needs to resolve.
      git add -A
      git commit --no-verify -m "chore: back-merge $new_tag from $RELEASED_BRANCH into $upstream (CONFLICT — manual resolution needed)"
      git push -f origin "_flywheel_back_merge_tmp:$pr_branch"

      # Heredoc instead of printf for the body. Single quotes (Flywheel's)
      # and parens (#120) appear literally without the escape gymnastics
      # that broke the previous form (a one-character typo in the
      # printf-and-positional-args dance closed quoting mid-string and
      # exposed parens to bash; see #128 for the gory details).
      pr_body="$(cat <<EOF
Automatic back-merge of \`$new_tag\` from \`$RELEASED_BRANCH\` into \`$upstream\` failed.

## How to resolve

1. Check out this branch: \`gh pr checkout <PR#>\` (or \`git fetch origin $pr_branch && git checkout $pr_branch\`).
2. The branch HEAD is a merge commit with conflict markers. Resolve them — for \`CHANGELOG.md\`, the union of both sides is correct (regenerated by \`flywheel-changelog\` on healthy adopters; manual here).
3. \`git add\` the resolved files and \`git commit --amend --no-edit\` (keep this as a true merge commit — *do not* \`git reset\` or rebase).
4. \`git push --force-with-lease\`.
5. **Merge with "Create a merge commit"** when checks pass. Squash or rebase will collapse the released commit out of \`$upstream\`'s ancestry and re-open this divergence on the next promotion (#120).

Flywheel's pr-flow deliberately does NOT auto-merge this PR — the merge method is load-bearing for branch lineage.
EOF
)"

      gh pr create \
        --base "$upstream" \
        --head "$pr_branch" \
        --title "chore: back-merge $new_tag from $RELEASED_BRANCH into $upstream" \
        --label "flywheel:needs-review" \
        --body "$pr_body"
    fi
  fi
  echo "::endgroup::"
done
