# Squash merge issues in flywheel

A running record of the bugs, near-misses, and design contortions that have come from `merge_strategy: squash` in flywheel's promotion + back-merge pipeline. Captured so future maintainers can weigh "switch to merge commits" against "keep squash and patch" with the actual evidence in front of them.

## Why squash was chosen

Squash gives main a linear, one-commit-per-release history. `git log main --oneline` reads like a release log — every commit is either a `chore(release):` or a promotion squash. Adopters who require the GitHub "Require linear history" branch protection rule get it for free. This is the value prop, and it's real.

The cost — described below — is that squash severs git ancestry between develop and main. Almost every issue in this doc is a downstream consequence of that ancestry break.

---

## Issue 1 — Skip-ci marker propagation

**The problem.** GitHub Actions recognizes six magic strings in commit messages as workflow-suppression directives: `[skip ci]`, `[ci skip]`, `[no ci]`, `[skip actions]`, `[actions skip]`, `***NO_CI***`. When any appear anywhere in a commit message, GitHub silently skips every workflow that would have triggered. GitHub's default `squash_merge_commit_message: COMMIT_MESSAGES` builds the squash commit body by concatenating the squashed commits' messages. A single contaminated commit anywhere in develop's history would propagate into the develop→main promotion squash body and silently suppress every workflow on main — including `Flywheel — Push`, the trigger for semantic-release. Failure mode: "I merged the PR but no release fired," with no surfaceable error. PRs #26 and #59 in this repo's history both hit this.

**Attempts and outcomes.**

| Attempt | Tradeoff accepted | Outcome |
|---|---|---|
| Patch develop's history once when PR #26 hit it | Quick unblock | Failed: PR #59 hit it again because the back-merge linked git ancestry but did not change what `git log main..develop` enumerates. Recurring class of failure. |
| `formatPromotionBody` sanitizer in `src/promotion.ts` | Strip markers from echoed commit titles in bot-generated PR body | Defense-in-depth only. Doesn't help adopters whose squash setting is `COMMIT_MESSAGES` (the default) — that path doesn't go through the bot's PR body. |
| Flip `squash_merge_commit_message` to `PR_BODY` repo-wide | Loses GitHub's per-commit body in the squash | Rejected by user — didn't want to change the squash body convention. |
| **History rewrite + active block (PR #61)** | Destructive: rewrote 10 commits, deleted 16 tags + 16 GitHub releases, reset main, re-released as v1.0.0 | Resolved for skip-ci specifically. Active enforcement (`flywheel/conventional-commit` check) blocks any future PR whose title, body, or commit messages contain the markers. |

**Status:** ✅ Resolved for the skip-ci marker family. The underlying mechanism (squash bodies re-include already-released commit text) is unchanged — see Issue 4.

---

## Issue 2 — Back-merge CHANGELOG / `release_files` conflicts

**The problem.** After main releases v1.0.0, the chore commit modifies CHANGELOG.md and any configured `release_files` (Flutter `pubspec.yaml`, Cargo `Cargo.toml`, .NET `.csproj`, etc.). The back-merge step then tries to merge main into each upstream branch (develop). Because squash severed ancestry, `git merge`'s 3-way algorithm finds a merge-base much earlier than develop's last release commit. From that base both branches independently prepended sections to CHANGELOG / mutated the version line in `release_files`. Result: a deterministic conflict on every release.

**Attempts and outcomes.**

| Attempt | Tradeoff accepted | Outcome |
|---|---|---|
| `git merge --ff-only` then `--no-ff` fallback | Standard git merge semantics | Failed deterministically on every prod release after the first. |
| CHANGELOG-only `--theirs` conflict resolver | Adopters using `release_files` not covered | Insufficient — would still conflict on `pubspec.yaml`, `Cargo.toml`, etc. The resolver's "only CHANGELOG conflicted" guard would correctly refuse to apply, leaving the back-merge stuck. |
| Cherry-pick of the chore commit | Lose the linkage of "this is a release commit" type | Considered but abandoned. Cherry-pick's 3-way merge (with chore commit's parent as base) handled the case correctly, but synthesizing the commit ourselves was cleaner. |
| **Back-pick (PRs #63 + #64)** | Commit type changes from `chore(release)` to `ci(flywheel)` on the back-merge commit on upstreams. Adopters who customize `releaseRules` to make `chore` bumping would be surprised — but `ci` is non-bumping by default and we add a `Flywheel-Back-Merge:` trailer for future programmatic detection. | Landed. Takes main's version of every file modified by the chore commit, commits with `ci(flywheel):` subject. Verified locally; live test partially run before Issue 4 surfaced. |

**Status:** 🟡 Code shipped (PR #63 + PR #64). Live verification incomplete — Issue 4 derailed the test cycle.

---

## Issue 3 — Forward-merge CHANGELOG conflict (symmetric)

**The problem.** The back-merge problem has a symmetric forward-merge counterpart. Once develop has published its own dev release sections (`## 1.0.0-dev.1`, `## 1.0.0-dev.2`) at the top of CHANGELOG, and main has published its own `## 1.0.0` section at the top of *its* CHANGELOG, the next promotion PR cannot squash-merge cleanly: GitHub's mergeability check does a 3-way merge against the merge-base, sees both branches prepended at the top of CHANGELOG, and reports `mergeable: CONFLICTING`. PR #65 hit this.

**Note on conditions.** This conflict only manifests when develop has *not* received a back-merge from main (so develop lacks main's `## 1.0.0` section in its CHANGELOG). If back-pick (Issue 2) has worked at least once after the prior prod release, develop's CHANGELOG becomes a strict superset of main's, and squash adopts the superset cleanly. So this is a one-time consequence of the prior back-merge having failed.

**Attempts and outcomes.**

| Attempt | Tradeoff accepted | Outcome |
|---|---|---|
| Manual conflict resolution (PR #65) — overwrite develop's CHANGELOG with main's | Lost dev release section headers from CHANGELOG history (still in git tags) | Worked once. Required disabling the managed-branches ruleset to push the resolution commit to develop. |

**Status:** 🟡 No automated fix. Forward-merge resolver in `runPromotion` (e.g., interleave sections by version date when about to update the promotion PR) is the obvious follow-up but not yet designed.

---

## Issue 4 — BREAKING-CHANGE (and feat/fix) re-analysis on every promotion

**The problem.** GitHub's default squash body concatenates the squashed commits' full messages. When PR #61's commit body included `BREAKING CHANGE: PRs whose title...`, that footer-style text rode along into PR #62's squash body (post-rewrite seed promotion → v1.0.0), then *again* into PR #65's squash body. semantic-release's `commit-analyzer` scans commit bodies for `BREAKING CHANGE:` footers — found one → major bump → v2.0.0 unexpectedly published.

This is *exactly the same shape* as the skip-ci propagation bug (Issue 1) — squash bodies re-introduce already-released text on every subsequent promotion — but the released-content "marker" is `BREAKING CHANGE:` rather than `[skip ci]`. Skip-ci was handled with a global active block; BREAKING CHANGE cannot be globally blocked because it's a legitimate part of a working release.

**Why it recurs.** Squash creates a commit on main with main's prior tip as its only parent. Develop's individual commits are not in main's git ancestry. The next promotion squashes develop into main again — develop's history still contains every commit since the post-rewrite root, and `git log main..develop` enumerates all of them. Every promotion squash body re-includes the full message of every develop commit since divergence.

**Attempts and outcomes.** None yet. This was discovered when v2.0.0 published unexpectedly during the live test of Issue 2's fix.

**Open mitigations to consider.**

- **Sanitize the squash body before commit-analyzer reads it.** Not directly possible — semantic-release reads what GitHub writes, and we don't control GitHub's squash output without flipping to `PR_BODY` (rejected by user for Issue 1).
- **Add a sanitizer to the chore-release flow** — strip `BREAKING CHANGE:` and `feat!:` from the message of any release commit on main where the body re-includes already-released content. Brittle.
- **Switch to merge commits.** Merge preserves ancestry → develop's commits become reachable from main → semantic-release sees them as reachable through the prior tag (provided back-merge has previously brought the prior tag into develop's ancestry) → already-released commits are excluded from the "since last release" window automatically.

**Status:** 🔴 Open. Active block until a fix is designed.

---

## Issue 5 — `(#NN)` suffix + SHA-based ancestry breakage in pending-commit detection

**The problem.** Every squash merge into a target branch creates a new SHA on that branch — the underlying source commits are never reachable. SHA-based queries like `git log main..develop` therefore wrongly report already-promoted commits as "pending." This is the fundamental reason `src/promotion.ts:169-187`'s `computePendingCommits()` exists: it has a date-based Strategy A (use the prior `promote source → target` commit's `committerDate` as the cutoff) and a title-based Strategy B (compare commit-message titles, stripping GitHub's `(#NN)` PR-number suffix that squash adds).

**Tradeoffs accepted.** This is workaround code that wouldn't exist if ancestry weren't broken. It works, but:

- Strategy B fails any time develop and main have commits with identical titles for unrelated reasons (e.g., two separate `chore: lint` runs).
- Title comparison is fragile to title rewrites by the bot (Flywheel itself rewrites PR titles on update).
- Documented explicitly in `spec.md:727-728` as a load-bearing assumption: "Because the default `merge_strategy: squash` produces new SHAs on the target branch, SHA-based ancestry will incorrectly show already-promoted commits as pending. Instead, Flywheel compares commit messages..."

**Status:** 🟢 Working but architecturally lossy. Disappears entirely under merge mode (ancestry preserved, `git log main..develop` is reliable).

---

## Common root cause

Issues 2, 3, 4, and 5 are all direct consequences of the same property of squash: **squash creates a new commit on the target branch with the source branch's tree but only the target's prior tip as parent. The source branch's individual commits never become reachable from the target.**

This severs four useful properties:

1. **Ancestry-based merge-base computation** — broken merge-base → conflict on every back-merge (Issue 2) and on first forward-merge after a missed back-merge (Issue 3).
2. **"Commits since last release" being a stable set** — broken because every promotion re-includes the full source history in the squash body, and commit-analyzer treats body content as part of the commit it's analyzing (Issue 4).
3. **SHA-based "what's pending" query** — broken because already-promoted commits' SHAs never appear on the target (Issue 5).
4. **Body content being limited to the merging commit's actual changes** — squash bodies are a concatenation, not a description, so any marker text in any squashed commit appears (Issue 1, Issue 4).

Issue 1 (skip-ci) was eradicated by destructive history rewrite + active block, which is a viable approach for one specific marker family but not generalizable.

Issues 2 and 5 have working mitigations (back-pick, computePendingCommits) — both are workaround code that would not exist if the underlying property held.

Issues 3 and 4 are open. Issue 4 is currently a hard block on the release pipeline.

---

## Status table

| # | Issue | Status | Mitigation |
|---|---|---|---|
| 1 | Skip-ci marker propagation | ✅ Resolved | History rewrite + `flywheel/conventional-commit` active block |
| 2 | Back-merge CHANGELOG / release_files conflict | 🟡 Code shipped, live test interrupted | Back-pick (PR #63 + PR #64) |
| 3 | Forward-merge CHANGELOG conflict | 🟡 Manual resolution only | None automated |
| 4 | BREAKING-CHANGE re-analysis on promotion | 🔴 Open, blocking releases | None |
| 5 | Squash breaks SHA-based ancestry | 🟢 Working but lossy | `computePendingCommits()` workaround |

---

## What changes if we drop squash

True merge commits resolve issues 2, 3, and 4 *provided* back-merge has previously stitched the prior prod tag into the upstream's ancestry. Issue 5 disappears because SHA-based ancestry becomes reliable — `computePendingCommits()` simplifies to `git log main..develop`.

Costs:

- `git log main` becomes noisier — every develop commit is reachable from main. `git log --first-parent main` recovers the clean release-log view.
- main's CHANGELOG.md picks up develop's dev release sections when develop merges in (`## 1.0.X-dev.N` sections appear interleaved with prod sections). Mitigations: accept it (audit trail), strip dev sections in a `prepareCmd` hook, or split CHANGELOG files per branch.
- "Require linear history" branch protection becomes incompatible. flywheel's own `apply-rulesets.sh` applies this rule today; would need to drop it or move to a less strict alternative for adopters who choose merge mode.
- Adopters using `merge_strategy: squash` today would need a migration path.

The decision is a value-prop trade: linear main history and "require linear history" compatibility on one side, ancestry-preserving correctness and ~four classes of bugs gone on the other.

---

## Resolved by hybrid mode

Flywheel now uses a hybrid merge strategy that is not adopter-configurable:

- **Feature PRs into a stream branch** continue to **squash** so each merged PR contributes exactly one CHANGELOG entry and intermediate WIP commits stay invisible. (Preserves the value prop — the per-release log on main is still one promotion merge + one `chore(release):` per release.)
- **Promotion PRs** (e.g. `develop` → `main`) **always merge** (true merge commit). Source ancestry is preserved.
- **Back-merge** after a release uses `git merge --ff-only || --no-ff` instead of the file-based back-pick. CHANGELOG / `release_files` conflicts disappear because ancestry is intact.
- The `merge_strategy` config field has been removed (rejected as an unknown key on load). The `required_linear_history` rule has been dropped from the default managed-branches ruleset, since promotion + back-merge edges now produce merge commits.

Status under hybrid mode:

| # | Issue | Hybrid-mode status |
|---|---|---|
| 1 | Skip-ci marker propagation | ✅ Already resolved by the active `flywheel/conventional-commit` block (independent of merge mode). |
| 2 | Back-merge CHANGELOG / release_files conflict | ✅ Resolved. `git merge` against the released branch finds the right merge-base because ancestry is preserved. The back-pick code path was removed. |
| 3 | Forward-merge CHANGELOG conflict | ✅ Resolved. After the first back-merge under hybrid mode, develop's CHANGELOG is a strict superset of main's, so the next promotion applies cleanly. (One-time manual resolution may still be needed for the cutover release that lands hybrid mode itself — see Phase 1 in the migration plan.) |
| 4 | BREAKING-CHANGE re-analysis on promotion | ✅ Resolved. Promotion PRs use a true merge, so develop's commits become reachable through main's prior tag and `commit-analyzer` excludes already-released commits from the "since last release" window. |
| 5 | Squash breaks SHA-based ancestry | ✅ Architecturally resolved. SHA-based queries (`git log main..develop`) become reliable for the promotion edge. `computePendingCommits()` still uses its title-comparison workaround for now — simplification is tracked as a low-priority follow-up. |

The cost (`git log main` becomes noisier; "Require linear history" no longer applies on the promotion + back-merge edges) was accepted as the right trade in exchange for eliminating the four-class bug family above.
