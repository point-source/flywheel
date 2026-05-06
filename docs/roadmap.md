# Roadmap

Items captured for later investigation. Not commitments.

## Reusable workflow for the adopter surface

Adopters currently paste two complete YAML files into `.github/workflows/` (`flywheel-pr.yml` and `flywheel-push.yml`). They could instead reference a single reusable workflow:

```yaml
# .github/workflows/flywheel-pr.yml — adopter side, ~6 lines
name: Flywheel — PR
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
jobs:
  conduct:
    uses: point-source/flywheel/.github/workflows/pr.yml@v1
    with:
      app-id: ${{ vars.FLYWHEEL_GH_APP_ID }}
    secrets:
      app-private-key: ${{ secrets.FLYWHEEL_GH_APP_PRIVATE_KEY }}
```

### Why investigate

- Removes ~16 lines of copy-paste-prone YAML per adopter workflow.
- Bug fixes in the reusable workflow propagate via the floating `@v1` tag, no adopter PR needed for the boilerplate.
- The doc burden in `docs/adopter-setup.md` shrinks substantially.

### Open questions / known sharp edges

- **Permissions intersection.** A called workflow's `permissions:` block is intersected with the caller's. The adopter caller workflow needs to grant enough scope (`pull-requests: write`, `contents: write`) for the called workflow's needs to materialize. We'd need to document this and probably surface it in `init.sh`.
- **Token plumbing.** App-token minting via `actions/create-github-app-token` works inside reusable workflows, but the secrets must be passed via the `secrets:` block on the caller side. Verify behavior end-to-end against `flywheel-sandbox` before committing to this surface.
- **Adopter override knobs.** Today adopters can edit their workflow YAML to add steps before/after the Flywheel action (e.g. extra checkout depth, custom labels for telemetry). A reusable workflow forecloses that. Decide whether we accept the loss or expose extension points (`pre-steps`, `post-steps` inputs — historically a foot-gun in actions).
- **Testing in the sandbox.** Pre-merge e2e of arbitrary SHAs requires the `swarmflow_repo` / `swarmflow_ref` override pattern from ADR 0001 (rewrite #2). Re-introducing it for rewrite #3 is mechanical but adds a non-trivial input to the reusable-workflow contract.
- **History.** ADR 0001 (rewrite #2) describes a viable side-load + `uses: ./.swarmflow` pattern for reusable workflows. Rewrite #3 simplified past that. Re-introducing reusable workflows means we're partly rolling back rewrite #3's simplification — worth being explicit about the trade.

### What rejecting it preserves

- Single source of truth (one bundled action), no per-event reusable workflow files in this repo's adopter surface.
- Adopters can read their entire Flywheel surface in two short YAML files in their own repo — no `@v1`-pinned indirection.

Status: open. Revisit after `init.sh` / `doctor.sh` adoption telemetry exists, so the decision is informed by which step in `docs/adopter-setup.md` adopters actually trip on.

## Simplify `computePendingCommits` now that ancestry is preserved

Under hybrid mode, promotion PRs land as true merge commits, so source commits become reachable from target and `git log target..source` is reliable. The current implementation in `src/promotion.ts:171-209` still uses two squash-era strategies:

- **Strategy A** (date cutoff) calls `findLastPromotionCommit()` whose regex `^[a-z]+(\([^)]+\))?!?: promote source → target$` matches the squash-merged title format. Under hybrid mode the target's prior promotion is a merge commit with subject `Merge pull request #N from ORG/branch` — the regex never matches, so Strategy A silently no-ops.
- **Strategy B** (title set difference, with `(#NN)` suffix stripping) still produces correct results because develop's individual commits become reachable on target via the merge, so they appear in `targetCommits` and get filtered out.

The dead Strategy A masks a silent failure mode if Strategy B ever regresses. Refactor target: replace both with `git log target..source` semantics. Keep a small fallback for cherry-picked / identical-title cases so cross-stream cherry-picks still dedup.

Status: deferred. `src/promotion.ts:171-209`, `src/promotion.ts:191-209` (`findLastPromotionCommit`, `buildPromotionTitleRegex`).

## Public fork PRs cannot run conduct

`scripts/templates/flywheel-pr.yml:2` triggers on plain `pull_request:`. GitHub does not pass repo secrets (including `FLYWHEEL_GH_APP_PRIVATE_KEY`) to PRs from forks. `action.yml:14` marks `app-private-key` as `required: true`, so the action fails immediately on fork PRs.

Two possible fixes:
1. Add an early-exit branch in `src/main.ts` that detects an empty `app-private-key`, posts a neutral check explaining the limitation, and exits cleanly.
2. Document explicitly that Flywheel-managed repos shouldn't accept fork PRs (e.g., via a PR template or branch-naming rule).

Status: pre-existing. Flywheel hasn't had public-fork adopters yet; revisit if/when.

## `listBranchCommits` is unpaginated at 200

`src/promotion.ts:57-60` requests up to 200 commits per branch; `src/github.ts:189-207` does a single page (`octokit.rest.repos.listCommits` with `per_page`). Long-lived branches with >200 commits between promotions can:

- Lose Strategy A's last-promotion marker (returns null → falls back to Strategy B).
- Treat already-promoted commits whose target-side mirror is older than 200 commits as pending (false positive in Strategy B).

Both manifest as duplicate or noisy promotion PR bodies on slow-moving streams. Fix: paginate or compute against the last release tag instead of a fixed window.

Status: pre-existing. Hybrid-mode-friendly fix is to combine this with the `computePendingCommits` simplification above.

## Multi-stream tag namespace not fully protected

`scripts/rulesets/tag-namespace.json:7` matches only `refs/tags/v*`. Secondary streams emit tags like `customer-acme/v1.2.3` (per `src/release-rc.ts:123-126`) which fall outside the protection — anyone with push scope can delete or force-update them.

Fix: extend `include` to `["refs/tags/v*", "refs/tags/*/v*"]`, or generate the include list per-stream from `.flywheel.yml` in `scripts/apply-rulesets.sh`.

Status: pre-existing.

## semantic-release plugin majors unpinned

`scripts/templates/flywheel-push.yml:31-39` (and the dogfood copy `.github/workflows/flywheel-push.yml:31-39`) pin `semantic-release@24` but leave every `@semantic-release/*` plugin at floating major:

```yaml
npx --yes \
  -p semantic-release@24 \
  -p @semantic-release/commit-analyzer \
  -p @semantic-release/release-notes-generator \
  ...
```

When a plugin major releases, every adopter pipeline picks it up on the next push and can break unexpectedly. Fix: pin each plugin to a known-good major (current state is `commit-analyzer@13`, `release-notes-generator@14`, `changelog@6`, `exec@7`, `git@10`, `github@11`).

Status: pre-existing.

