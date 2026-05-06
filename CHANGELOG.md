# [1.0.0-dev.2](https://github.com/point-source/flywheel/compare/v1.0.0-dev.1...v1.0.0-dev.2) (2026-05-06)


### Bug Fixes

* **push:** back-pick release files into upstreams to survive squash/rebase ([#63](https://github.com/point-source/flywheel/issues/63)) ([a4ef65d](https://github.com/point-source/flywheel/commit/a4ef65d6e6235e9944aed6a218f33fece51e9293))
* **push:** use multiple -m flags so back-pick commit message is YAML-safe ([#64](https://github.com/point-source/flywheel/issues/64)) ([0ece7ac](https://github.com/point-source/flywheel/commit/0ece7acb71cb4dd4e5a4cc41285ace82c1c5e9a7)), closes [#63](https://github.com/point-source/flywheel/issues/63)

# 1.0.0-dev.1 (2026-05-05)


* feat!: block skip-ci markers at PR time and require check by default ([#61](https://github.com/point-source/flywheel/issues/61)) ([1426340](https://github.com/point-source/flywheel/commit/1426340caba43be0012093e609b90089332c024d))
* feat!: initial v1.0.0 release of the Flywheel action ([#14](https://github.com/point-source/flywheel/issues/14)) ([ff81df7](https://github.com/point-source/flywheel/commit/ff81df7caa24b8ee896f2a782da84061964583e4)), closes [#4](https://github.com/point-source/flywheel/issues/4) [#6](https://github.com/point-source/flywheel/issues/6) [#1](https://github.com/point-source/flywheel/issues/1) [#8](https://github.com/point-source/flywheel/issues/8) [#7](https://github.com/point-source/flywheel/issues/7) [#2](https://github.com/point-source/flywheel/issues/2) [#7](https://github.com/point-source/flywheel/issues/7) [#3](https://github.com/point-source/flywheel/issues/3) [#13](https://github.com/point-source/flywheel/issues/13) [#NN](https://github.com/point-source/flywheel/issues/NN) [#5](https://github.com/point-source/flywheel/issues/5) [#4](https://github.com/point-source/flywheel/issues/4)
* feat!: release v2.0.0 ([#24](https://github.com/point-source/flywheel/issues/24)) ([5c0ba62](https://github.com/point-source/flywheel/commit/5c0ba622c0b074a87dd5d675cc07b886488e27e4))


### Bug Fixes

* **compute-version:** use reachable tag for base version lookup ([c36b732](https://github.com/point-source/flywheel/commit/c36b7328eec8f9578f65f1287234204606abcd74))
* **config:** pre-v2.1.0 cleanup — close [#28](https://github.com/point-source/flywheel/issues/28), [#29](https://github.com/point-source/flywheel/issues/29), [#30](https://github.com/point-source/flywheel/issues/30), [#33](https://github.com/point-source/flywheel/issues/33) ([#34](https://github.com/point-source/flywheel/issues/34)) ([5c0cd95](https://github.com/point-source/flywheel/commit/5c0cd957d47ec5fabc25f507082967fff35cff00))
* **detect-merge-queue:** authenticate gh api and surface failures ([46da99c](https://github.com/point-source/flywheel/commit/46da99cd5a5be450595bdaed72d6799abfedf2c6))
* **doctor:** hard-fail listing errors; add --skip-credentials ([#54](https://github.com/point-source/flywheel/issues/54)) ([125e206](https://github.com/point-source/flywheel/commit/125e206811dcdb397913647e9216b67c1917a2b3)), closes [#52](https://github.com/point-source/flywheel/issues/52) [#26](https://github.com/point-source/flywheel/issues/26)
* **e2e:** bump test 07 per-test timeout to 600s ([#56](https://github.com/point-source/flywheel/issues/56)) ([b3b8b44](https://github.com/point-source/flywheel/commit/b3b8b440d477b4e9dbcd3f2a5decf417796e80e3))
* **e2e:** copy fresh templates into sandbox in the pin step ([4074da7](https://github.com/point-source/flywheel/commit/4074da759b7ed9a9d1def38b0b261fd38ce0f526))
* **e2e:** exercise auto-merge with fix:, not feat: ([75792ac](https://github.com/point-source/flywheel/commit/75792ac236701cda52a831ca00345edb6b15e67f))
* **e2e:** force-update sandbox refs so sync survives concurrent test merges ([#53](https://github.com/point-source/flywheel/issues/53)) ([afaeb5c](https://github.com/point-source/flywheel/commit/afaeb5c31292b80eadd129d310a5a6baba295777))
* **e2e:** mint App token scoped to the sandbox repo ([9750ef4](https://github.com/point-source/flywheel/commit/9750ef477644886cbb5b89314428298705ac31d7))
* **e2e:** pin develop and staging entrypoints alongside main ([625e038](https://github.com/point-source/flywheel/commit/625e0385909e97005c37e7dbaf364bb8877775b4))
* **e2e:** scope presweep to e2e-prefixed head refs only ([#58](https://github.com/point-source/flywheel/issues/58)) ([e681121](https://github.com/point-source/flywheel/commit/e68112111e408b5de052f2db8aad39b2cb6ce573))
* **e2e:** widen pre-cleanup tag glob to match teardown ([f406105](https://github.com/point-source/flywheel/commit/f406105a4d49543df8b5503fdd272dfab7a0a278))
* **github:** rename $method GraphQL var; bump actions/checkout to v6 ([#32](https://github.com/point-source/flywheel/issues/32)) ([51e5a21](https://github.com/point-source/flywheel/commit/51e5a215e54e2c8cf8f8b0d5e1654023e8c21b88))
* **init:** persist FLYWHEEL_GH_APP_ID across re-runs to keep ruleset bypass ([#48](https://github.com/point-source/flywheel/issues/48)) ([04c957b](https://github.com/point-source/flywheel/commit/04c957b420669a13f563a49c6e49c96753d315a8))
* **init:** propagate App ID to apply-rulesets.sh ([#38](https://github.com/point-source/flywheel/issues/38)) ([93743ab](https://github.com/point-source/flywheel/commit/93743abb02b0180ff75b733a22febf89c46cf76e))
* post-filter on headBranch when polling for runs ([07f2c24](https://github.com/point-source/flywheel/commit/07f2c2442d40f2b9fcb007f535e662e51edf060e))
* **pr-lifecycle:** re-render PR body with quality outcome ([2a6ffc7](https://github.com/point-source/flywheel/commit/2a6ffc72d708cc03fbf65a5c2f63876bccea34aa))
* **promote:** allow publish on chore-only pushes per spec ([5f4c62b](https://github.com/point-source/flywheel/commit/5f4c62b0d1b6180b29cc95630d9fd6344bf44b0a))
* **release:** tag and publish before pushing the changelog commit ([841f63b](https://github.com/point-source/flywheel/commit/841f63b04579b286a6c08a291ad9e3eefdb12eb1))
* **render-pr-body:** pick highest-bump commit for the PR title ([fe1d068](https://github.com/point-source/flywheel/commit/fe1d06879464f03ae0b9849b1b63f57fd302a6b9))
* **scripts:** address review findings on PR [#27](https://github.com/point-source/flywheel/issues/27) ([#31](https://github.com/point-source/flywheel/issues/31)) ([bac3c5c](https://github.com/point-source/flywheel/commit/bac3c5c11446de207ef45afe35d096cbe13691f9))
* side-load swarmflow at workflow SHA for cross-repo composite use ([1bf074e](https://github.com/point-source/flywheel/commit/1bf074e63433f80d2a3145155a13d9623584c6e6))
* stop emitting skip-ci in release and back-merge commits ([#50](https://github.com/point-source/flywheel/issues/50)) ([3d57078](https://github.com/point-source/flywheel/commit/3d57078cc941d220de015cfb85465e13e4ccd813))
* **template:** dispatch publish with App token, not GITHUB_TOKEN ([92b86f2](https://github.com/point-source/flywheel/commit/92b86f2522dbeaa3be8460c0bfadffca20486a79))
* **template:** leave quality workflow unset by default ([5b8db85](https://github.com/point-source/flywheel/commit/5b8db85985ee30dd3ff0b8456755d8ec6b045663))
* **templates:** grant explicit permissions for orchestrator chain ([28632ca](https://github.com/point-source/flywheel/commit/28632ca977fe0b82903546ece6abf127d8426680))
* **templates:** grant union of pipeline permissions to caller ([ef5f00e](https://github.com/point-source/flywheel/commit/ef5f00e2ce736de34f48430ec94f3b75f55eaeca))
* thread swarmflow_repo/swarmflow_ref through workflow_call chain ([1a68689](https://github.com/point-source/flywheel/commit/1a686890d5fd071557badb1c7d1ee2a37c188d39))
* use canonical lowercase swarmflow owner in adopter templates ([e14063e](https://github.com/point-source/flywheel/commit/e14063eac00543a19fd2067f0342e56ecdf09660))
* **workflow:** bundle @semantic-release/exec in dogfood push workflow ([#44](https://github.com/point-source/flywheel/issues/44)) ([4fb7436](https://github.com/point-source/flywheel/commit/4fb743643f1524a096a1a1565beac42b2f752ff4)), closes [#42](https://github.com/point-source/flywheel/issues/42) [#42](https://github.com/point-source/flywheel/issues/42) [#43](https://github.com/point-source/flywheel/issues/43)


### Features

* **actions:** composite actions for orchestrator primitives ([2d40dbc](https://github.com/point-source/flywheel/commit/2d40dbcb4fcf04209ad4c22afa96b3357d7557d9))
* **config:** add develop to main-line stream as prerelease channel ([#25](https://github.com/point-source/flywheel/issues/25)) ([fa5d8f2](https://github.com/point-source/flywheel/commit/fa5d8f280544325068f5442632b11baf9e1a7910))
* **e2e:** sync workflow templates + .flywheel.yml fixture into sandbox ([#46](https://github.com/point-source/flywheel/issues/46)) ([ffc035b](https://github.com/point-source/flywheel/commit/ffc035b2a147f827a6840c592da8fc472f000611)), closes [#42](https://github.com/point-source/flywheel/issues/42) [#37](https://github.com/point-source/flywheel/issues/37)
* **push-flow:** respect committed .releaserc.json + bundle @semantic-release/exec ([#42](https://github.com/point-source/flywheel/issues/42)) ([c6f068e](https://github.com/point-source/flywheel/commit/c6f068ef31d47123acf1b8ab4ebaea254c7aa00a))
* **scripts:** adopter setup DX cleanups ([#27](https://github.com/point-source/flywheel/issues/27)) ([05629cb](https://github.com/point-source/flywheel/commit/05629cb187137bfb77596a96943f7e817d2e98a2))
* **scripts:** auto-delete merged branches and document branch lifecycle ([#36](https://github.com/point-source/flywheel/issues/36)) ([d14f382](https://github.com/point-source/flywheel/commit/d14f3824f279d4ff54f050427327f4e9e3cc2be0))
* **scripts:** bash helpers for commits, versioning, and PR bodies ([5d21e91](https://github.com/point-source/flywheel/commit/5d21e9180883fb40ae40e7be8d1811cd964eae17))
* **scripts:** doctor merge_group check + init --force/required-checks prompt + soften legacy keys ([#40](https://github.com/point-source/flywheel/issues/40)) ([4d53cdc](https://github.com/point-source/flywheel/commit/4d53cdc059c7d88511feca812f1e876f63c1d383))
* store GitHub App ID as Actions variable, not secret ([#52](https://github.com/point-source/flywheel/issues/52)) ([6cc59a7](https://github.com/point-source/flywheel/commit/6cc59a782997c9196a14e411c33c5468437236a2))
* **workflows:** orchestrator entrypoint dispatcher ([b7d317b](https://github.com/point-source/flywheel/commit/b7d317bba4ff1496c36e46c65e299bdcb205d5f9))
* **workflows:** pr-lifecycle reusable workflow ([3788623](https://github.com/point-source/flywheel/commit/37886234a98226ec2c63359026392d32fdca8644))
* **workflows:** promote workflow for develop -> staging -> main ([5f18f1f](https://github.com/point-source/flywheel/commit/5f18f1ff1e37c95f30a8265c76e68591142c2619))
* **workflows:** release workflow for tagging and GitHub Release ([c375bc6](https://github.com/point-source/flywheel/commit/c375bc622b5ce1ce4bb7d3238605ce2541c39c8b))


### BREAKING CHANGES

* PRs whose title, body, or any commit message contains
any of the six recognized skip-ci variants (the bracket forms for
skip-ci, ci-skip, no-ci, skip-actions, actions-skip, plus the asterisk-
wrapped NO_CI sentinel) now fail the flywheel/conventional-commit check
and are unmergeable when that check is required (the new default).
Adopters who relied on these markers must use a job-level if: condition
instead — see docs/adopter-setup.md "Skipping CI on Flywheel-emitted
commits."

Tests: 19 new in tests/skip-ci.test.ts (unit) and tests/pr-flow.test.ts
(integration). All 190 unit tests pass.

Co-authored-by: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
* Adopter repos must rename two GitHub repo secrets:
  APP_ID            -> FLYWHEEL_GH_APP_ID
  APP_PRIVATE_KEY   -> FLYWHEEL_GH_APP_PRIVATE_KEY
Re-running scripts/init.sh creates the new names; old secrets can be
deleted manually afterward. Action input names (app-id, app-private-key)
are unchanged.

Co-authored-by: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
* in pending → `feat!: promote ...` title.
    * existing open PR is updated (single PR), not duplicated.
    * terminal branch in stream → no promotion PR (multi-branch and single-branch).
    * unmanaged branch → no-op, zero API calls.

Multi-stream verification is covered across release-rc.test.ts (per-stream
tagFormat scoping), push-flow.test.ts (secondary stream gets prefixed format),
and promotion.test.ts (single-branch stream behaviour, intra-stream promotion
chain). 98 tests pass overall.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* feat: dogfood flywheel on swarmflow itself

Phase 5 of the Flywheel build.

- .flywheel.yml — replaces the rewrite/flywheel placeholder with the production
  config: single stream `main-line`, single branch `main`. auto_merge includes
  feat / fix / fix! / chore / refactor / perf / style / test / docs / ci / build,
  but deliberately omits feat! — major bumps of the action itself need human
  review.
- docs/maintainer-setup.md — documents required secrets (GH_PAT scope), the four
  branch protection rulesets from spec §Branch protection (main protection,
  merge queue, v* tag namespace, optional branch naming), the bootstrap order
  for self-adoption (PR to main → first release v1.0.0 → manually move v1
  floating tag → follow-up PR flips workflow refs from `./` to
  `flywheel-ci/flywheel@v1`), and the marketplace listing step.
- tests/dogfood-config.test.ts — 3 cases validating the actual `.flywheel.yml`
  in this repo: loads cleanly, single-branch notice fires (not an error), and
  feat! is absent from main's auto_merge list.

Workflows still use `uses: ./` (local action ref). They flip to
flywheel-ci/flywheel@v1 in a follow-up PR after the first release lands per the
documented bootstrap order.

101 tests pass overall.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* docs: marketplace listing, adopter quickstart, and v1 tag automation

Phase 6 — final phase. Flywheel is ready for marketplace publication.

- README.md — full marketplace front page. What it is, quick start, event chain
  diagram, design properties, permissions table, inputs/outputs, conventional
  commit type table, validation summary, dev workflow, links to deeper docs.
- docs/adopter-setup.md — step-by-step adopter walkthrough: token scopes,
  minimal `.flywheel.yml` plus a multi-stream variant, copy-pasteable
  flywheel-pr.yml + flywheel-push.yml + example build.yml + publish.yml,
  branch-protection ruleset recommendations, smoke-test verification.
- docs/maintainer-release-process.md — how releases happen automatically (every
  push to main runs through Flywheel itself), the first-release bootstrap order
  (PR → merge → first v1.0.0 → manually create floating v1 → marketplace listing
  → PR flipping refs to flywheel-ci/flywheel@v1), versioning across streams,
  and the rollback procedure.
- .github/workflows/release-major-tag.yml — runs on `release: published`. Parses
  the release tag (accepts both `vX.Y.Z` and `stream-name/vX.Y.Z` formats) and
  force-updates the floating major tag (`v1`, `v2`, …, or `stream/v1`) to point
  at the new release. Standard marketplace pattern from actions/checkout etc.
  Skips cleanly with a notice if the tag isn't in semver form.

Build still passes (101 tests, dist/ in sync). The action is now
distributable: Phase 5's `.flywheel.yml` releases swarmflow on every merge to
main, and this workflow keeps `v1` floating for adopters that pin to
`flywheel-ci/flywheel@v1`.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* docs: add CONTRIBUTING.md for contributors and sandbox testing

Adds a root-level contributor guide covering prerequisites, the
edit-test-build loop, the dist/-is-committed policy, conventional-commit
PR title rules, and two manual end-to-end validation paths (dogfood this
repo or a personal sandbox repo). Also flags that testing_strategy.md
describes the target architecture, not what is currently implemented.
README links to the new guide from the Development section and the
Related docs list.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* docs(adopter-setup): prerequisites, minimal example, troubleshooting

Frontloads what an adopter needs before step 1 (admin repo, Actions
enabled, Conventional Commits familiarity, optional merge queue).
Expands the GitHub App option with a pointer to
actions/create-github-app-token. Adds a single-stream / single-branch
"minimal viable" .flywheel.yml before the three-stage example so the
simplest valid setup is the first one shown. Notes the @v1 floating
tag versus @v1.2.3 pinning trade-off. Adds a Troubleshooting section
covering the most common adopter confusions (title not rewritten, label
mismatch, auto-merge not enabled, missing promotion PR, no-op release,
tag collision, merge-queue stall).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* docs(testing): rewrite testing_strategy.md to match implemented surface

Replace aspirational framing with a factual reflection of the test surface:
Layer 1 already exists with 101 tests covering more ground than the doc
claimed (squash-merge dedup, GraphQL fallback, idempotency, multi-error
collection). Layer 2 is described as the harness being introduced now,
with concrete file paths and the SANDBOX_GH_PAT secret name. Layer 3 is
explicitly marked deferred but retained as a roadmap.

Add docs/sandbox-setup.md with provisioning steps for
flywheel-ci/flywheel-sandbox. Update CONTRIBUTING.md status note to
reflect the new tiering.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* test(pr-flow): cover reverse label flip and full-flow idempotency

Adds the two unit-level scenarios called out in testing_strategy.md:

- needs-review → auto-merge after retitle from feat: to fix: (the reverse
  of the existing forward-direction flip test).
- Full-flow idempotency: a second runPrFlow against the post-first-run
  state of the same fake GitHubClient leaves labels, title, and body
  unchanged, fires no extra updatePR/removeLabel calls, and does not
  disable auto-merge.

Closes the doc's "Open question: workflow retry / idempotency" at the
unit level.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* test(integration): scaffold sandbox client and teardown harness

Adds the helper layer for Layer 2 integration tests:

- vitest.integration.config.ts: separate Vitest config that runs only
  tests/integration/, disables file-level parallelism, and uses 60s
  default timeouts to accommodate real GitHub API latency.
- npm run test:integration: invokes the new config; --passWithNoTests
  so it stays green before the first test suite lands.
- tests/integration/helpers/sandbox-client.ts: lazy-loaded GitHubClient
  bound to flywheel-ci/flywheel-sandbox via SANDBOX_GH_PAT, plus a raw
  Octokit for low-level ops (refs, file commits, REST PR fetches that
  need fields outside the GitHubClient interface). Exports
  hasSandboxPat so test files can skip when running without the secret.
- tests/integration/helpers/test-pr.ts: createTestPR (creates branch,
  commits a marker file, opens a PR), fetchPR (returns the PullRequest
  shape runPrFlow consumes), uniqueBranch helper.
- tests/integration/helpers/teardown.ts: LIFO cleanup register; closes
  PRs and deletes branches in afterEach, swallowing 404/422 so a
  cleanup race never fails a test.
- tests/integration/helpers/sandbox-config.ts: TS mirror of the
  sandbox repo's .flywheel.yml so tests don't depend on a working
  copy at test time.

No test suites land in this commit; passWithNoTests keeps CI green.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* test(integration): add pr-title-rewrite and label-application suites

Two suites run runPrFlow against a real-Octokit GitHubClient bound to
flywheel-ci/flywheel-sandbox:

- pr-title-rewrite: opens a PR with a malformed conventional commit
  title and asserts runPrFlow normalizes it and writes the increment
  annotation; a second case exercises real listPullCommits and asserts
  the rendered body includes the per-type changelog section.
- label-application: covers eligible (fix → auto-merge), ineligible
  (feat → needs-review), and the reverse flip (retitle feat:→fix:
  flips needs-review to auto-merge). The reverse flip is the
  integration-level mirror of the unit test added in the previous
  commit and verifies that the real label set on the PR object
  agrees with the production code path.

Both suites use describe.skipIf(!hasSandboxPat) so they no-op when
SANDBOX_GH_PAT is unavailable (fork PRs, contributors without
provisioning access). afterEach calls runTeardown to close PRs and
delete branches LIFO.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* test(integration): add promotion-pr and auto-merge-enablement suites

- auto-merge-enablement: confirms the real GraphQL enablePullRequestAutoMerge
  mutation succeeds against the sandbox by asserting the runPrFlow return
  shape carries autoMergeEnabled: true. A second case retitles an
  eligible PR to feat: and asserts auto-merge is disabled. Does not poll
  for actual merge — required-checks behavior on integration-test-base
  governs that timing and is out of scope here.
- promotion-pr: builds a synthetic FlywheelConfig stream per test
  (ephemeral source branch → integration-test-base) so each scenario is
  isolated. Covers the create-then-upsert path (asserts same PR number on
  the second run with most-impactful type updated) and the chore-only
  no-op path (asserts kind: "no-bumping" and zero PRs created).

Adds vitest.config.ts to exclude tests/integration from the default
`npm test` run, so unit and integration suites only show up in their
respective scopes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* ci: gate develop and main on integration tests

Adds .github/workflows/integration.yml. Triggers on PRs (same-repo only —
fork PRs are skipped because SANDBOX_GH_PAT is not exposed to them and
every test would skip anyway) and on pushes to develop and main. Reads
SANDBOX_GH_PAT from repo secrets and runs npm run test:integration.

Not yet a required status check; per the plan we wait ~1 week of stable
runs before adding it to branch protection.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* chore: rename flywheel-ci → point-source and swarmflow → flywheel

The flywheel-ci org doesn't exist; the project lives at point-source on
GitHub and the repo is being renamed from swarmflow to flywheel.

Updates every reference accordingly:

- action.yml: author flywheel-ci → point-source.
- spec.md, docs/adopter-setup.md, docs/maintainer-setup.md,
  docs/maintainer-release-process.md: marketplace ref
  flywheel-ci/flywheel@v1 → point-source/flywheel@v1; "swarmflow
  consumes itself" → "flywheel consumes itself".
- docs/sandbox-setup.md, testing_strategy.md, CONTRIBUTING.md: sandbox
  ref flywheel-ci/flywheel-sandbox → point-source/flywheel-sandbox; the
  swarmflow repo → the flywheel repo.
- tests/integration/helpers/sandbox-client.ts: SANDBOX_OWNER constant
  flywheel-ci → point-source.
- tests/integration/helpers/sandbox-config.ts: comment update.
- CONTRIBUTING.md preface: drop the on-disk-vs-published distinction
  since they will both be flywheel after rename.

dist/index.js is unchanged — none of the renamed strings were bundled.
The actual `gh repo rename` and the local working-directory rename are
out of scope for this commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* chore(integration): swap PAT auth for flywheel-build-e2e GitHub App

Replace the SANDBOX_GH_PAT model with a GitHub App-based token mint:

- .github/workflows/integration.yml: add an actions/create-github-app-token
  step that consumes E2E_APP_ID + E2E_APP_PRIVATE_KEY repo secrets, scopes
  the token to point-source/flywheel-sandbox, and exports it as
  SANDBOX_GH_TOKEN for the test step. The fork-PR gate stays.
- tests/integration/helpers/sandbox-client.ts: rename SANDBOX_GH_PAT →
  SANDBOX_GH_TOKEN (auth-method-agnostic — App installation token in CI,
  PAT or App token locally) and hasSandboxPat → hasSandboxToken across
  the four integration test files.
- docs/sandbox-setup.md: replace the fine-grained-PAT section with App
  provisioning steps (install flywheel-build-e2e on flywheel-sandbox
  only, store E2E_APP_ID + E2E_APP_PRIVATE_KEY on point-source/flywheel,
  no human PAT rotation).
- testing_strategy.md, CONTRIBUTING.md: update the auth references to
  match.

Bundle unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* feat(scripts): add adopter onboarding templates

Three .flywheel.yml presets (minimal / three-stage / multi-stream) and two
adopter workflow templates that init.sh will write into target repos.
Workflows mint a fresh App installation token via actions/create-github-app-token
and reference APP_ID + APP_PRIVATE_KEY secrets — no PAT path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* feat(scripts): add branch + tag protection ruleset presets

apply-rulesets.sh reads .flywheel.yml, extracts every managed branch, and
posts two rulesets to the GitHub Rulesets API: a managed-branch ruleset
(require PRs, block deletion / force-push, require linear history; optional
required status checks via --required-checks) and a v* tag-namespace
ruleset (block deletion / force-push; optional GitHub App bypass actor via
--app-id so the bot can mint version tags).

Replaces the multi-panel GitHub UI clicking in adopter-setup.md step 5
with a single command. Depends on gh, jq, yq.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* feat(scripts): add init.sh — one-command Flywheel adopter scaffold

Picks a .flywheel.yml preset (minimal / three-stage / multi-stream),
writes both adopter workflow files using App-token plumbing, prompts for
APP_ID + APP_PRIVATE_KEY repo secrets via gh, and optionally invokes
apply-rulesets.sh. Idempotent — re-running on a configured repo skips
files and secrets that already exist.

Works as a local script (uses scripts/templates/ alongside) or via
curl | bash (fetches templates from the v1 tag); the local path
overrides via FLYWHEEL_TEMPLATES_BASE for testing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* feat(scripts): add doctor.sh — read-only Flywheel setup validator

Checks .flywheel.yml parses, every managed branch exists on the remote,
APP_ID + APP_PRIVATE_KEY repo secrets are set (and warns if a stale GH_PAT
is hanging around), allow_auto_merge is on, both adopter workflow files
exist and reference point-source/flywheel + create-github-app-token, a
branch ruleset covers each managed branch and requires PRs, and a v* tag
namespace ruleset exists.

Replaces step 6's manual smoke-test PR with a deterministic check;
suggests scripts/apply-rulesets.sh as the fix when ruleset checks fail.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* docs: switch all adopter-facing guidance from PAT to App tokens

- adopter-setup.md: new 'Quick start (one command)' section pointing at
  init.sh + doctor.sh; rewrite §1 to require a GitHub App; switch every
  workflow YAML sample to actions/create-github-app-token plumbing; have
  §5 reference apply-rulesets.sh and §6 reference doctor.sh.
- README.md: replace GH_PAT recommendation with App-token-only language;
  surface the curl|bash install in the quick-start.
- spec.md, docs/maintainer-setup.md, CONTRIBUTING.md, testing_strategy.md,
  docs/sandbox-setup.md: drop GH_PAT/PAT alternatives; recommend App
  tokens uniformly.
- action.yml: tighten the 'token' input description to App-installation
  semantics.

Dogfood workflows (.github/workflows/flywheel-{pr,push}.yml,
release-major-tag.yml) still reference GH_PAT — explicitly out of scope
for this PR per plan; tracked for follow-up.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* docs: add roadmap with reusable-workflow + dogfood-App-token items

Captures two open architectural items for later investigation:

1. Reusable workflow for the adopter surface — collapses both adopter
   workflow files to ~6 lines each, but reopens permissions intersection,
   token plumbing, and override-flexibility questions. Was rejected during
   the recent streamlining pass on a partly-incorrect premise; reopen as
   a roadmap item informed by adoption telemetry once init.sh/doctor.sh
   land with users.

2. Dogfood workflows still reference GH_PAT || GITHUB_TOKEN. Blocked on
   provisioning a dedicated GitHub App for point-source/flywheel
   (separate from flywheel-build-e2e). Mechanical migration once the
   APP_ID + APP_PRIVATE_KEY secrets exist.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* ci: migrate dogfood workflows from GH_PAT/GITHUB_TOKEN fallback to App tokens

flywheel-pr.yml, flywheel-push.yml, and release-major-tag.yml now mint a
fresh installation token via actions/create-github-app-token using the
APP_ID + APP_PRIVATE_KEY secrets that were just provisioned for this
repo. Removes the dead GH_PAT fallback (the secret was never set; the
GITHUB_TOKEN branch silently took over). Closes the dogfood-doctor gap
called out in docs/roadmap.md.

Drops the now-resolved migration item from docs/roadmap.md; the
reusable-workflow investigation entry stays.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* fix(build): rename bundle to dist/index.cjs to match CommonJS format

package.json declares "type": "module", which made Node 24 try to load
the esbuild-produced CommonJS bundle (which uses require()) as ESM and
throw "ReferenceError: require is not defined". Renaming the output to
.cjs is explicit about the bundle's module system without disturbing the
ESM source/test surface (where dropping "type": "module" would break
import.meta usage in tests).

Updates scripts/build.mjs (outfile) and action.yml (main) accordingly.

Pre-existing issue surfaced by the dogfood App-token migration making
the Flywheel — Push run reach the bundle execution step.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* test(e2e): scaffold helpers, vitest config, and npm script

Layer 3 foundation: poll-until, sandbox-e2e (push/merge/tag/check ops),
run-baseline (stale-run filter), tag-cleanup (snapshot/diff/delete);
vitest.e2e.config.ts (fileParallelism: false, testTimeout 180s);
test:e2e script; exclude tests/e2e from the unit suite.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* test(e2e): add PR-flow scenarios 01-04

01: fix PR auto-merges (mergedAt poll, 120s timeout, diagnostic dump on
failure for the known mergeStateStatus=BLOCKED flake risk).
02: feat PR labeled needs-review, auto_merge null, observation window.
03: fix! against e2e-staging (excluded from auto_merge) → needs-review.
04: malformed title posts flywheel/conventional-commit failure check.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* test(e2e): add promotion-flow scenarios 05-07

05: a fix merge to e2e-develop opens a develop→staging promotion PR.
06: a chore-only merge to e2e-staging does NOT open a staging→main PR
(non-bumping, target auto_merge=[]).
07: two sequential fix merges upsert the same promotion PR; body lists
both commits.

All three filter workflow runs by databaseId > baseline_id via
run-baseline.snapshotRunIds + waitForRunAfter so long-lived branch state
from prior runs doesn't surface as a false positive (lesson from
pre-reset commit 238aca0).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* test(e2e): add release/tag scenarios 08-09

08: a fix merge to e2e-customer-acme creates a customer-acme/v* tag and
NO bare v* tag; tag-cleanup deletes the new tag in afterEach.
09: pragmatic deviation from the original "semantic-release-dry-run"
roadmap entry (which was self-contradictory — dry-run does not create).
Loads .flywheel.yml from the live sandbox via API and exercises
chooseTagFormat for each stream — main-line → v\${version},
customer-acme → customer-acme/v\${version}, integration → integration/v\${version}.
Catches cross-stream tag collision without mutating sandbox state.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* ci(e2e): add e2e workflow with doctor.sh pre-flight

Triggers on push to develop only (skip on forks). Mints a sandbox-scoped
installation token from flywheel-build-e2e App, runs scripts/doctor.sh
against the sandbox as a pre-flight (fails fast on configuration drift —
missing branches, secret expiry, ruleset removal), then npm run test:e2e.
20-minute job timeout; concurrency group cancel-in-progress: false so
in-flight tests aren't killed by a subsequent develop push.

Not added to branch protection as a required check; per testing strategy
this happens after ~1 week of observed stability.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* docs(testing): mark Layer 3 implemented; add sandbox workflow installation

testing_strategy.md: flip Layer 3 from Deferred to Implemented; replace the
roadmap section with the actual layout, helper inventory, isolation
strategy, scenario 09 deviation rationale, and the scenario 01 flake-risk
callout for auto-merge BLOCKED state. Update CI pipeline table to reflect
e2e on push to develop. Note doctor.sh pre-flight.

docs/sandbox-setup.md: add "Layer 3 workflow installation" section with
the copy-templates / repin-to-develop / apply-rulesets commands. The
sandbox now reuses scripts/templates/flywheel-{pr,push}.yml as the
canonical workflows rather than duplicating YAML in this doc.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* fix(integration): add prerelease to integration-test-base in sandbox mirror

Without a prerelease identifier, integration-test-base's terminal branch
is treated as a production terminal alongside e2e-main, which trips
loadConfig rule 3 (>1 stream with terminal prerelease: false). The actual
sandbox .flywheel.yml carries prerelease: "int" on this branch; mirror it
here so the TS object matches and loadConfig wouldn't reject it if it ever
flowed through validation (e.g., from the e2e-09 live-config check).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* fix(init): tolerate BASH_SOURCE unset under curl|bash invocation

set -u trips on \${BASH_SOURCE[0]} when init.sh is piped via curl|bash —
BASH_SOURCE is empty in that mode and the script aborts with "unbound
variable" before reaching the local-templates fallback or the curl-based
fetch. Default to empty and skip local-templates detection in that path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* chore(scripts): swap yq for python3+PyYAML; bash 3.2 compat in doctor

Standardize on python3+PyYAML for YAML extraction across init.sh,
doctor.sh, and apply-rulesets.sh. Rationale: python3 ships with macOS
12.3+ and most Linux distros; PyYAML is pulled in by yamllint, ansible,
mkdocs, pre-commit, and most things adopters already run, so no extra
install for the typical user. yq (mikefarah) was a separate Go binary
nobody had preinstalled.

doctor.sh: also replace `declare -A` with parallel arrays — assoc arrays
are bash 4+ but macOS still ships bash 3.2, which broke the rulesets
section locally. Verified end-to-end against point-source/flywheel-sandbox.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* ci: add workflow_dispatch to integration and e2e workflows

Lets maintainers trigger Layer 2/3 runs against the sandbox manually
(e.g., after sandbox provisioning changes, before merging a feature
branch that touches sandbox-facing code) without having to open a
speculative PR or push to develop. The job already gates itself on
non-fork repository so secrets remain protected.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* docs: add Issues + Checks App permissions to all permissions lists

Layer 2 integration tests caught two missing permissions in the docs:

- Issues: read/write — required by addLabels/removeLabel for the
  flywheel:auto-merge / flywheel:needs-review labels (PR labels go
  through the Issues API). sandbox-setup.md already listed it; the
  other docs did not.
- Checks: read/write — required by createCheck when an invalid PR
  title triggers the flywheel/conventional-commit check. None of the
  docs listed it. The integration suite's pr-title-rewrite test
  surfaced this as 403 "Resource not accessible by integration"
  with x-accepted-github-permissions: checks=write.

Updated: README.md, docs/adopter-setup.md, docs/maintainer-setup.md,
docs/sandbox-setup.md, scripts/init.sh.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* feat: action mints its own installation token + preflight permission check

Replaces the two-step adopter pattern (actions/create-github-app-token →
flywheel uses the minted token) with a single step: flywheel accepts
app-id + app-private-key directly, mints its own installation token,
captures the granted permissions from the token-mint response, and
validates them against the action's required set BEFORE doing any work.

When permissions are missing or insufficient, the action fails with a
single error that names every gap (e.g. "checks: need write, granted
read") and links to the App's settings page. This catches App
misconfiguration at adoption time instead of surfacing as a cryptic 403
on the first invalid-title PR.

Required permissions enforced:
  contents: write          (semantic-release tag/CHANGELOG push)
  pull_requests: write     (PR creation, body updates, auto-merge)
  issues: write            (flywheel:* labels on PRs)
  checks: write            (flywheel/conventional-commit check)
  metadata: read           (always required)

Workflow templates simplified — adopters no longer need a separate
actions/create-github-app-token step, and the push template uses
${{ steps.flywheel.outputs.token }} for semantic-release. Both dogfood
workflows updated to the same shape.

Adds @octokit/auth-app as the runtime JWT/installation-token dep
(8 new preflight unit tests; 111/111 total passing).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* feat(pr-flow): always-post conventional-commit check + direct-merge fallback

Two product changes that together let flywheel work cleanly for adopters
with no required status checks (e.g. the sandbox), and also let adopters
that DO want a quality gate add flywheel/conventional-commit to their
required checks without having to define their own check.

1. Always post the flywheel/conventional-commit check.
   Previously: only posted on parse failure (conclusion: failure).
   Now: also posted on parse success (conclusion: success). Adopters can
   safely add it to required_status_checks without "Expected — Waiting
   for status" hangs on valid-title PRs.

2. Direct-merge fallback when native auto-merge declines.
   GitHub's enablePullRequestAutoMerge mutation fails with "Pull request
   is in clean status" when nothing's pending — which happens on every
   PR in a repo without required checks. Previously the action gave up
   and emitted a warning. Now it falls back to a direct pulls.merge call
   with the App's installation token; if branch protection rules are
   satisfied (linear history, PR required, etc.), the merge succeeds.
   If both auto-merge AND direct merge fail, the original warning fires.

PrFlowOutcome now carries `merged: boolean` to distinguish "scheduled
for later" (auto-merge enabled) from "merged now" (direct-merge
fallback). Adds GitHubClient.mergePR + fakeGh wiring + 1 new pr-flow
unit test for the both-failed path. 112/112 passing.

Source for the direct-merge pattern: pre-reset commit 87d5643 +
60fe99a's rationale ("auto-merge alone is unreliable in practice...
we keep enabling it but ALSO call pulls.merge directly").

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* fix: normalize missing-space-after-colon titles + align integration tests

The conventional commit parser previously rejected `fix(auth):handle…` (no
space after the colon). Now it accepts the typo so `formatTitle` can rewrite
the title with proper spacing — surfacing flywheel's normalization promise
that adopters were already exercising in the integration suite.

Also rewrites the auto-merge integration tests to match the new product
behavior on no-required-checks branches: an eligible PR is direct-merged
(autoMergeEnabled=false, merged=true), and the disable-path test uses an
ineligible PR pre-labeled flywheel:auto-merge to exercise disableAutoMerge
against real GitHub.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* fix(doctor): fetch remote contents when validating a different repo

When run from one repo against another (e.g. flywheel's e2e workflow
running doctor.sh against flywheel-sandbox), the script was reading the
local cwd's .flywheel.yml and workflow files instead of the target repo's
— so the dogfood config and workflows reported as the sandbox's, producing
spurious failures.

When the target REPO arg differs from the cwd's repo, fetch
.flywheel.yml and the two workflow files from the target via the GitHub
contents API instead.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

# [2.1.0-dev.14](https://github.com/point-source/flywheel/compare/v2.1.0-dev.13...v2.1.0-dev.14) (2026-05-05)


### Bug Fixes

* **e2e:** scope presweep to e2e-prefixed head refs only ([#58](https://github.com/point-source/flywheel/issues/58)) ([21890a6](https://github.com/point-source/flywheel/commit/21890a6571180ff591eb487af6eafeb64f9249be))

# [2.1.0-dev.13](https://github.com/point-source/flywheel/compare/v2.1.0-dev.12...v2.1.0-dev.13) (2026-05-05)


### Bug Fixes

* **e2e:** bump test 07 per-test timeout to 600s ([#56](https://github.com/point-source/flywheel/issues/56)) ([4e4a737](https://github.com/point-source/flywheel/commit/4e4a7379138bc0c5bbbfb548e6247b79c4d9f412))

# [2.1.0-dev.12](https://github.com/point-source/flywheel/compare/v2.1.0-dev.11...v2.1.0-dev.12) (2026-05-05)


### Bug Fixes

* **doctor:** hard-fail listing errors; add --skip-credentials ([#54](https://github.com/point-source/flywheel/issues/54)) ([3963225](https://github.com/point-source/flywheel/commit/3963225462a479762538d594a934dffcdb39c93d)), closes [#52](https://github.com/point-source/flywheel/issues/52) [#26](https://github.com/point-source/flywheel/issues/26)

# [2.1.0-dev.11](https://github.com/point-source/flywheel/compare/v2.1.0-dev.10...v2.1.0-dev.11) (2026-05-05)


### Bug Fixes

* **e2e:** force-update sandbox refs so sync survives concurrent test merges ([#53](https://github.com/point-source/flywheel/issues/53)) ([5fa85a8](https://github.com/point-source/flywheel/commit/5fa85a829af336e98a94bb9ef9afdee6d68eb632))

# [2.1.0-dev.10](https://github.com/point-source/flywheel/compare/v2.1.0-dev.9...v2.1.0-dev.10) (2026-05-05)


### Features

* store GitHub App ID as Actions variable, not secret ([#52](https://github.com/point-source/flywheel/issues/52)) ([b2a1c21](https://github.com/point-source/flywheel/commit/b2a1c210a0e277d1e7a62f6af24c273c103defa2))

# [2.1.0-dev.9](https://github.com/point-source/flywheel/compare/v2.1.0-dev.8...v2.1.0-dev.9) (2026-05-05)


### Bug Fixes

* stop emitting skip-ci in release and back-merge commits ([#50](https://github.com/point-source/flywheel/issues/50)) ([cbbfd77](https://github.com/point-source/flywheel/commit/cbbfd7702f854eb64a5d71e92a29588bc0ac928a))

# [2.1.0-dev.8](https://github.com/point-source/flywheel/compare/v2.1.0-dev.7...v2.1.0-dev.8) (2026-05-05)


### Bug Fixes

* **init:** persist FLYWHEEL_GH_APP_ID across re-runs to keep ruleset bypass ([#48](https://github.com/point-source/flywheel/issues/48)) ([a75dac6](https://github.com/point-source/flywheel/commit/a75dac6fb6a9c446bd498d4d871cd350882d97d0))


### Features

* **e2e:** sync workflow templates + .flywheel.yml fixture into sandbox ([#46](https://github.com/point-source/flywheel/issues/46)) ([f566e5d](https://github.com/point-source/flywheel/commit/f566e5d0d337454199a8e129adc39e6d00aaccb8)), closes [#42](https://github.com/point-source/flywheel/issues/42) [#37](https://github.com/point-source/flywheel/issues/37)

# [2.1.0-dev.7](https://github.com/point-source/flywheel/compare/v2.1.0-dev.6...v2.1.0-dev.7) (2026-05-05)


### Bug Fixes

* **workflow:** bundle @semantic-release/exec in dogfood push workflow ([#44](https://github.com/point-source/flywheel/issues/44)) ([79e1858](https://github.com/point-source/flywheel/commit/79e1858ec1f86e43756dcdaa6a64df6bf85bff81)), closes [#42](https://github.com/point-source/flywheel/issues/42) [#42](https://github.com/point-source/flywheel/issues/42) [#43](https://github.com/point-source/flywheel/issues/43)


### Features

* **push-flow:** respect committed .releaserc.json + bundle @semantic-release/exec ([#42](https://github.com/point-source/flywheel/issues/42)) ([ac0618a](https://github.com/point-source/flywheel/commit/ac0618a65530bfd9cf10058c79bb99a469828f79))

# [2.1.0-dev.6](https://github.com/point-source/flywheel/compare/v2.1.0-dev.5...v2.1.0-dev.6) (2026-05-05)


### Features

* **scripts:** doctor merge_group check + init --force/required-checks prompt + soften legacy keys ([#40](https://github.com/point-source/flywheel/issues/40)) ([cc1c1a7](https://github.com/point-source/flywheel/commit/cc1c1a738a8168b13dfadc7ebe495c57cb4b2fb3))

# [2.1.0-dev.5](https://github.com/point-source/flywheel/compare/v2.1.0-dev.4...v2.1.0-dev.5) (2026-05-05)


### Bug Fixes

* **init:** propagate App ID to apply-rulesets.sh ([#38](https://github.com/point-source/flywheel/issues/38)) ([f44ac10](https://github.com/point-source/flywheel/commit/f44ac100cf4df3392219fbe7d12665e383f10bea))

# [2.1.0-dev.4](https://github.com/point-source/flywheel/compare/v2.1.0-dev.3...v2.1.0-dev.4) (2026-05-04)


### Features

* **scripts:** auto-delete merged branches and document branch lifecycle ([#36](https://github.com/point-source/flywheel/issues/36)) ([7797e41](https://github.com/point-source/flywheel/commit/7797e41a77d7c2558650def898b446c6e5fe835a))

# [2.1.0-dev.3](https://github.com/point-source/flywheel/compare/v2.1.0-dev.2...v2.1.0-dev.3) (2026-05-04)


### Bug Fixes

* **config:** pre-v2.1.0 cleanup — close [#28](https://github.com/point-source/flywheel/issues/28), [#29](https://github.com/point-source/flywheel/issues/29), [#30](https://github.com/point-source/flywheel/issues/30), [#33](https://github.com/point-source/flywheel/issues/33) ([#34](https://github.com/point-source/flywheel/issues/34)) ([3a3ceb0](https://github.com/point-source/flywheel/commit/3a3ceb07a62cdbe84de5d4f8ffc1aa0ae3c2e928))

# [2.1.0-dev.2](https://github.com/point-source/flywheel/compare/v2.1.0-dev.1...v2.1.0-dev.2) (2026-05-04)


### Bug Fixes

* **github:** rename $method GraphQL var; bump actions/checkout to v6 ([#32](https://github.com/point-source/flywheel/issues/32)) ([83947ce](https://github.com/point-source/flywheel/commit/83947ce615ad98db921cad656f494607764cf12a))

# [2.1.0-dev.1](https://github.com/point-source/flywheel/compare/v2.0.0...v2.1.0-dev.1) (2026-05-04)


### Bug Fixes

* **scripts:** address review findings on PR [#27](https://github.com/point-source/flywheel/issues/27) ([#31](https://github.com/point-source/flywheel/issues/31)) ([34a8b07](https://github.com/point-source/flywheel/commit/34a8b076f5105f62e31c4f5e07f09aa65d0a5d5d))


### Features

* **config:** add develop to main-line stream as prerelease channel ([#25](https://github.com/point-source/flywheel/issues/25)) ([b19d1d7](https://github.com/point-source/flywheel/commit/b19d1d700ad20121549f409a5fa33190dc6053c8))
* **scripts:** adopter setup DX cleanups ([#27](https://github.com/point-source/flywheel/issues/27)) ([90f7438](https://github.com/point-source/flywheel/commit/90f74382c9f99529aef98c61a319c96c7c2f6c09))

# [2.0.0](https://github.com/point-source/flywheel/compare/v1.0.0...v2.0.0) (2026-05-01)


* feat!: release v2.0.0 ([#24](https://github.com/point-source/flywheel/issues/24)) ([38481fb](https://github.com/point-source/flywheel/commit/38481fbe3b3c840093892831d423109a1f530590))


### BREAKING CHANGES

* Adopter repos must rename two GitHub repo secrets:
  APP_ID            -> FLYWHEEL_GH_APP_ID
  APP_PRIVATE_KEY   -> FLYWHEEL_GH_APP_PRIVATE_KEY
Re-running scripts/init.sh creates the new names; old secrets can be
deleted manually afterward. Action input names (app-id, app-private-key)
are unchanged.

Co-authored-by: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

# 1.0.0 (2026-04-30)


* feat!: initial v1.0.0 release of the Flywheel action ([#14](https://github.com/point-source/flywheel/issues/14)) ([cf2a435](https://github.com/point-source/flywheel/commit/cf2a435ac7f410c07e69049748a358bef29ff75d)), closes [#4](https://github.com/point-source/flywheel/issues/4) [#6](https://github.com/point-source/flywheel/issues/6) [#1](https://github.com/point-source/flywheel/issues/1) [#8](https://github.com/point-source/flywheel/issues/8) [#7](https://github.com/point-source/flywheel/issues/7) [#2](https://github.com/point-source/flywheel/issues/2) [#7](https://github.com/point-source/flywheel/issues/7) [#3](https://github.com/point-source/flywheel/issues/3) [#13](https://github.com/point-source/flywheel/issues/13) [#NN](https://github.com/point-source/flywheel/issues/NN) [#5](https://github.com/point-source/flywheel/issues/5) [#4](https://github.com/point-source/flywheel/issues/4)


### Bug Fixes

* **compute-version:** use reachable tag for base version lookup ([c36b732](https://github.com/point-source/flywheel/commit/c36b7328eec8f9578f65f1287234204606abcd74))
* **detect-merge-queue:** authenticate gh api and surface failures ([46da99c](https://github.com/point-source/flywheel/commit/46da99cd5a5be450595bdaed72d6799abfedf2c6))
* **e2e:** copy fresh templates into sandbox in the pin step ([4074da7](https://github.com/point-source/flywheel/commit/4074da759b7ed9a9d1def38b0b261fd38ce0f526))
* **e2e:** exercise auto-merge with fix:, not feat: ([75792ac](https://github.com/point-source/flywheel/commit/75792ac236701cda52a831ca00345edb6b15e67f))
* **e2e:** mint App token scoped to the sandbox repo ([9750ef4](https://github.com/point-source/flywheel/commit/9750ef477644886cbb5b89314428298705ac31d7))
* **e2e:** pin develop and staging entrypoints alongside main ([625e038](https://github.com/point-source/flywheel/commit/625e0385909e97005c37e7dbaf364bb8877775b4))
* **e2e:** widen pre-cleanup tag glob to match teardown ([f406105](https://github.com/point-source/flywheel/commit/f406105a4d49543df8b5503fdd272dfab7a0a278))
* post-filter on headBranch when polling for runs ([07f2c24](https://github.com/point-source/flywheel/commit/07f2c2442d40f2b9fcb007f535e662e51edf060e))
* **pr-lifecycle:** re-render PR body with quality outcome ([2a6ffc7](https://github.com/point-source/flywheel/commit/2a6ffc72d708cc03fbf65a5c2f63876bccea34aa))
* **promote:** allow publish on chore-only pushes per spec ([5f4c62b](https://github.com/point-source/flywheel/commit/5f4c62b0d1b6180b29cc95630d9fd6344bf44b0a))
* **release:** tag and publish before pushing the changelog commit ([841f63b](https://github.com/point-source/flywheel/commit/841f63b04579b286a6c08a291ad9e3eefdb12eb1))
* **render-pr-body:** pick highest-bump commit for the PR title ([fe1d068](https://github.com/point-source/flywheel/commit/fe1d06879464f03ae0b9849b1b63f57fd302a6b9))
* side-load swarmflow at workflow SHA for cross-repo composite use ([1bf074e](https://github.com/point-source/flywheel/commit/1bf074e63433f80d2a3145155a13d9623584c6e6))
* **template:** dispatch publish with App token, not GITHUB_TOKEN ([92b86f2](https://github.com/point-source/flywheel/commit/92b86f2522dbeaa3be8460c0bfadffca20486a79))
* **template:** leave quality workflow unset by default ([5b8db85](https://github.com/point-source/flywheel/commit/5b8db85985ee30dd3ff0b8456755d8ec6b045663))
* **templates:** grant explicit permissions for orchestrator chain ([28632ca](https://github.com/point-source/flywheel/commit/28632ca977fe0b82903546ece6abf127d8426680))
* **templates:** grant union of pipeline permissions to caller ([ef5f00e](https://github.com/point-source/flywheel/commit/ef5f00e2ce736de34f48430ec94f3b75f55eaeca))
* thread swarmflow_repo/swarmflow_ref through workflow_call chain ([1a68689](https://github.com/point-source/flywheel/commit/1a686890d5fd071557badb1c7d1ee2a37c188d39))
* use canonical lowercase swarmflow owner in adopter templates ([e14063e](https://github.com/point-source/flywheel/commit/e14063eac00543a19fd2067f0342e56ecdf09660))


### Features

* **actions:** composite actions for orchestrator primitives ([2d40dbc](https://github.com/point-source/flywheel/commit/2d40dbcb4fcf04209ad4c22afa96b3357d7557d9))
* **scripts:** bash helpers for commits, versioning, and PR bodies ([5d21e91](https://github.com/point-source/flywheel/commit/5d21e9180883fb40ae40e7be8d1811cd964eae17))
* **workflows:** orchestrator entrypoint dispatcher ([b7d317b](https://github.com/point-source/flywheel/commit/b7d317bba4ff1496c36e46c65e299bdcb205d5f9))
* **workflows:** pr-lifecycle reusable workflow ([3788623](https://github.com/point-source/flywheel/commit/37886234a98226ec2c63359026392d32fdca8644))
* **workflows:** promote workflow for develop -> staging -> main ([5f18f1f](https://github.com/point-source/flywheel/commit/5f18f1ff1e37c95f30a8265c76e68591142c2619))
* **workflows:** release workflow for tagging and GitHub Release ([c375bc6](https://github.com/point-source/flywheel/commit/c375bc622b5ce1ce4bb7d3238605ce2541c39c8b))


### BREAKING CHANGES

* in pending → `feat!: promote ...` title.
    * existing open PR is updated (single PR), not duplicated.
    * terminal branch in stream → no promotion PR (multi-branch and single-branch).
    * unmanaged branch → no-op, zero API calls.

Multi-stream verification is covered across release-rc.test.ts (per-stream
tagFormat scoping), push-flow.test.ts (secondary stream gets prefixed format),
and promotion.test.ts (single-branch stream behaviour, intra-stream promotion
chain). 98 tests pass overall.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* feat: dogfood flywheel on swarmflow itself

Phase 5 of the Flywheel build.

- .flywheel.yml — replaces the rewrite/flywheel placeholder with the production
  config: single stream `main-line`, single branch `main`. auto_merge includes
  feat / fix / fix! / chore / refactor / perf / style / test / docs / ci / build,
  but deliberately omits feat! — major bumps of the action itself need human
  review.
- docs/maintainer-setup.md — documents required secrets (GH_PAT scope), the four
  branch protection rulesets from spec §Branch protection (main protection,
  merge queue, v* tag namespace, optional branch naming), the bootstrap order
  for self-adoption (PR to main → first release v1.0.0 → manually move v1
  floating tag → follow-up PR flips workflow refs from `./` to
  `flywheel-ci/flywheel@v1`), and the marketplace listing step.
- tests/dogfood-config.test.ts — 3 cases validating the actual `.flywheel.yml`
  in this repo: loads cleanly, single-branch notice fires (not an error), and
  feat! is absent from main's auto_merge list.

Workflows still use `uses: ./` (local action ref). They flip to
flywheel-ci/flywheel@v1 in a follow-up PR after the first release lands per the
documented bootstrap order.

101 tests pass overall.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* docs: marketplace listing, adopter quickstart, and v1 tag automation

Phase 6 — final phase. Flywheel is ready for marketplace publication.

- README.md — full marketplace front page. What it is, quick start, event chain
  diagram, design properties, permissions table, inputs/outputs, conventional
  commit type table, validation summary, dev workflow, links to deeper docs.
- docs/adopter-setup.md — step-by-step adopter walkthrough: token scopes,
  minimal `.flywheel.yml` plus a multi-stream variant, copy-pasteable
  flywheel-pr.yml + flywheel-push.yml + example build.yml + publish.yml,
  branch-protection ruleset recommendations, smoke-test verification.
- docs/maintainer-release-process.md — how releases happen automatically (every
  push to main runs through Flywheel itself), the first-release bootstrap order
  (PR → merge → first v1.0.0 → manually create floating v1 → marketplace listing
  → PR flipping refs to flywheel-ci/flywheel@v1), versioning across streams,
  and the rollback procedure.
- .github/workflows/release-major-tag.yml — runs on `release: published`. Parses
  the release tag (accepts both `vX.Y.Z` and `stream-name/vX.Y.Z` formats) and
  force-updates the floating major tag (`v1`, `v2`, …, or `stream/v1`) to point
  at the new release. Standard marketplace pattern from actions/checkout etc.
  Skips cleanly with a notice if the tag isn't in semver form.

Build still passes (101 tests, dist/ in sync). The action is now
distributable: Phase 5's `.flywheel.yml` releases swarmflow on every merge to
main, and this workflow keeps `v1` floating for adopters that pin to
`flywheel-ci/flywheel@v1`.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* docs: add CONTRIBUTING.md for contributors and sandbox testing

Adds a root-level contributor guide covering prerequisites, the
edit-test-build loop, the dist/-is-committed policy, conventional-commit
PR title rules, and two manual end-to-end validation paths (dogfood this
repo or a personal sandbox repo). Also flags that testing_strategy.md
describes the target architecture, not what is currently implemented.
README links to the new guide from the Development section and the
Related docs list.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* docs(adopter-setup): prerequisites, minimal example, troubleshooting

Frontloads what an adopter needs before step 1 (admin repo, Actions
enabled, Conventional Commits familiarity, optional merge queue).
Expands the GitHub App option with a pointer to
actions/create-github-app-token. Adds a single-stream / single-branch
"minimal viable" .flywheel.yml before the three-stage example so the
simplest valid setup is the first one shown. Notes the @v1 floating
tag versus @v1.2.3 pinning trade-off. Adds a Troubleshooting section
covering the most common adopter confusions (title not rewritten, label
mismatch, auto-merge not enabled, missing promotion PR, no-op release,
tag collision, merge-queue stall).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* docs(testing): rewrite testing_strategy.md to match implemented surface

Replace aspirational framing with a factual reflection of the test surface:
Layer 1 already exists with 101 tests covering more ground than the doc
claimed (squash-merge dedup, GraphQL fallback, idempotency, multi-error
collection). Layer 2 is described as the harness being introduced now,
with concrete file paths and the SANDBOX_GH_PAT secret name. Layer 3 is
explicitly marked deferred but retained as a roadmap.

Add docs/sandbox-setup.md with provisioning steps for
flywheel-ci/flywheel-sandbox. Update CONTRIBUTING.md status note to
reflect the new tiering.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* test(pr-flow): cover reverse label flip and full-flow idempotency

Adds the two unit-level scenarios called out in testing_strategy.md:

- needs-review → auto-merge after retitle from feat: to fix: (the reverse
  of the existing forward-direction flip test).
- Full-flow idempotency: a second runPrFlow against the post-first-run
  state of the same fake GitHubClient leaves labels, title, and body
  unchanged, fires no extra updatePR/removeLabel calls, and does not
  disable auto-merge.

Closes the doc's "Open question: workflow retry / idempotency" at the
unit level.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* test(integration): scaffold sandbox client and teardown harness

Adds the helper layer for Layer 2 integration tests:

- vitest.integration.config.ts: separate Vitest config that runs only
  tests/integration/, disables file-level parallelism, and uses 60s
  default timeouts to accommodate real GitHub API latency.
- npm run test:integration: invokes the new config; --passWithNoTests
  so it stays green before the first test suite lands.
- tests/integration/helpers/sandbox-client.ts: lazy-loaded GitHubClient
  bound to flywheel-ci/flywheel-sandbox via SANDBOX_GH_PAT, plus a raw
  Octokit for low-level ops (refs, file commits, REST PR fetches that
  need fields outside the GitHubClient interface). Exports
  hasSandboxPat so test files can skip when running without the secret.
- tests/integration/helpers/test-pr.ts: createTestPR (creates branch,
  commits a marker file, opens a PR), fetchPR (returns the PullRequest
  shape runPrFlow consumes), uniqueBranch helper.
- tests/integration/helpers/teardown.ts: LIFO cleanup register; closes
  PRs and deletes branches in afterEach, swallowing 404/422 so a
  cleanup race never fails a test.
- tests/integration/helpers/sandbox-config.ts: TS mirror of the
  sandbox repo's .flywheel.yml so tests don't depend on a working
  copy at test time.

No test suites land in this commit; passWithNoTests keeps CI green.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* test(integration): add pr-title-rewrite and label-application suites

Two suites run runPrFlow against a real-Octokit GitHubClient bound to
flywheel-ci/flywheel-sandbox:

- pr-title-rewrite: opens a PR with a malformed conventional commit
  title and asserts runPrFlow normalizes it and writes the increment
  annotation; a second case exercises real listPullCommits and asserts
  the rendered body includes the per-type changelog section.
- label-application: covers eligible (fix → auto-merge), ineligible
  (feat → needs-review), and the reverse flip (retitle feat:→fix:
  flips needs-review to auto-merge). The reverse flip is the
  integration-level mirror of the unit test added in the previous
  commit and verifies that the real label set on the PR object
  agrees with the production code path.

Both suites use describe.skipIf(!hasSandboxPat) so they no-op when
SANDBOX_GH_PAT is unavailable (fork PRs, contributors without
provisioning access). afterEach calls runTeardown to close PRs and
delete branches LIFO.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* test(integration): add promotion-pr and auto-merge-enablement suites

- auto-merge-enablement: confirms the real GraphQL enablePullRequestAutoMerge
  mutation succeeds against the sandbox by asserting the runPrFlow return
  shape carries autoMergeEnabled: true. A second case retitles an
  eligible PR to feat: and asserts auto-merge is disabled. Does not poll
  for actual merge — required-checks behavior on integration-test-base
  governs that timing and is out of scope here.
- promotion-pr: builds a synthetic FlywheelConfig stream per test
  (ephemeral source branch → integration-test-base) so each scenario is
  isolated. Covers the create-then-upsert path (asserts same PR number on
  the second run with most-impactful type updated) and the chore-only
  no-op path (asserts kind: "no-bumping" and zero PRs created).

Adds vitest.config.ts to exclude tests/integration from the default
`npm test` run, so unit and integration suites only show up in their
respective scopes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* ci: gate develop and main on integration tests

Adds .github/workflows/integration.yml. Triggers on PRs (same-repo only —
fork PRs are skipped because SANDBOX_GH_PAT is not exposed to them and
every test would skip anyway) and on pushes to develop and main. Reads
SANDBOX_GH_PAT from repo secrets and runs npm run test:integration.

Not yet a required status check; per the plan we wait ~1 week of stable
runs before adding it to branch protection.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* chore: rename flywheel-ci → point-source and swarmflow → flywheel

The flywheel-ci org doesn't exist; the project lives at point-source on
GitHub and the repo is being renamed from swarmflow to flywheel.

Updates every reference accordingly:

- action.yml: author flywheel-ci → point-source.
- spec.md, docs/adopter-setup.md, docs/maintainer-setup.md,
  docs/maintainer-release-process.md: marketplace ref
  flywheel-ci/flywheel@v1 → point-source/flywheel@v1; "swarmflow
  consumes itself" → "flywheel consumes itself".
- docs/sandbox-setup.md, testing_strategy.md, CONTRIBUTING.md: sandbox
  ref flywheel-ci/flywheel-sandbox → point-source/flywheel-sandbox; the
  swarmflow repo → the flywheel repo.
- tests/integration/helpers/sandbox-client.ts: SANDBOX_OWNER constant
  flywheel-ci → point-source.
- tests/integration/helpers/sandbox-config.ts: comment update.
- CONTRIBUTING.md preface: drop the on-disk-vs-published distinction
  since they will both be flywheel after rename.

dist/index.js is unchanged — none of the renamed strings were bundled.
The actual `gh repo rename` and the local working-directory rename are
out of scope for this commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* chore(integration): swap PAT auth for flywheel-build-e2e GitHub App

Replace the SANDBOX_GH_PAT model with a GitHub App-based token mint:

- .github/workflows/integration.yml: add an actions/create-github-app-token
  step that consumes E2E_APP_ID + E2E_APP_PRIVATE_KEY repo secrets, scopes
  the token to point-source/flywheel-sandbox, and exports it as
  SANDBOX_GH_TOKEN for the test step. The fork-PR gate stays.
- tests/integration/helpers/sandbox-client.ts: rename SANDBOX_GH_PAT →
  SANDBOX_GH_TOKEN (auth-method-agnostic — App installation token in CI,
  PAT or App token locally) and hasSandboxPat → hasSandboxToken across
  the four integration test files.
- docs/sandbox-setup.md: replace the fine-grained-PAT section with App
  provisioning steps (install flywheel-build-e2e on flywheel-sandbox
  only, store E2E_APP_ID + E2E_APP_PRIVATE_KEY on point-source/flywheel,
  no human PAT rotation).
- testing_strategy.md, CONTRIBUTING.md: update the auth references to
  match.

Bundle unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* feat(scripts): add adopter onboarding templates

Three .flywheel.yml presets (minimal / three-stage / multi-stream) and two
adopter workflow templates that init.sh will write into target repos.
Workflows mint a fresh App installation token via actions/create-github-app-token
and reference APP_ID + APP_PRIVATE_KEY secrets — no PAT path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* feat(scripts): add branch + tag protection ruleset presets

apply-rulesets.sh reads .flywheel.yml, extracts every managed branch, and
posts two rulesets to the GitHub Rulesets API: a managed-branch ruleset
(require PRs, block deletion / force-push, require linear history; optional
required status checks via --required-checks) and a v* tag-namespace
ruleset (block deletion / force-push; optional GitHub App bypass actor via
--app-id so the bot can mint version tags).

Replaces the multi-panel GitHub UI clicking in adopter-setup.md step 5
with a single command. Depends on gh, jq, yq.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* feat(scripts): add init.sh — one-command Flywheel adopter scaffold

Picks a .flywheel.yml preset (minimal / three-stage / multi-stream),
writes both adopter workflow files using App-token plumbing, prompts for
APP_ID + APP_PRIVATE_KEY repo secrets via gh, and optionally invokes
apply-rulesets.sh. Idempotent — re-running on a configured repo skips
files and secrets that already exist.

Works as a local script (uses scripts/templates/ alongside) or via
curl | bash (fetches templates from the v1 tag); the local path
overrides via FLYWHEEL_TEMPLATES_BASE for testing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* feat(scripts): add doctor.sh — read-only Flywheel setup validator

Checks .flywheel.yml parses, every managed branch exists on the remote,
APP_ID + APP_PRIVATE_KEY repo secrets are set (and warns if a stale GH_PAT
is hanging around), allow_auto_merge is on, both adopter workflow files
exist and reference point-source/flywheel + create-github-app-token, a
branch ruleset covers each managed branch and requires PRs, and a v* tag
namespace ruleset exists.

Replaces step 6's manual smoke-test PR with a deterministic check;
suggests scripts/apply-rulesets.sh as the fix when ruleset checks fail.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* docs: switch all adopter-facing guidance from PAT to App tokens

- adopter-setup.md: new 'Quick start (one command)' section pointing at
  init.sh + doctor.sh; rewrite §1 to require a GitHub App; switch every
  workflow YAML sample to actions/create-github-app-token plumbing; have
  §5 reference apply-rulesets.sh and §6 reference doctor.sh.
- README.md: replace GH_PAT recommendation with App-token-only language;
  surface the curl|bash install in the quick-start.
- spec.md, docs/maintainer-setup.md, CONTRIBUTING.md, testing_strategy.md,
  docs/sandbox-setup.md: drop GH_PAT/PAT alternatives; recommend App
  tokens uniformly.
- action.yml: tighten the 'token' input description to App-installation
  semantics.

Dogfood workflows (.github/workflows/flywheel-{pr,push}.yml,
release-major-tag.yml) still reference GH_PAT — explicitly out of scope
for this PR per plan; tracked for follow-up.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* docs: add roadmap with reusable-workflow + dogfood-App-token items

Captures two open architectural items for later investigation:

1. Reusable workflow for the adopter surface — collapses both adopter
   workflow files to ~6 lines each, but reopens permissions intersection,
   token plumbing, and override-flexibility questions. Was rejected during
   the recent streamlining pass on a partly-incorrect premise; reopen as
   a roadmap item informed by adoption telemetry once init.sh/doctor.sh
   land with users.

2. Dogfood workflows still reference GH_PAT || GITHUB_TOKEN. Blocked on
   provisioning a dedicated GitHub App for point-source/flywheel
   (separate from flywheel-build-e2e). Mechanical migration once the
   APP_ID + APP_PRIVATE_KEY secrets exist.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* ci: migrate dogfood workflows from GH_PAT/GITHUB_TOKEN fallback to App tokens

flywheel-pr.yml, flywheel-push.yml, and release-major-tag.yml now mint a
fresh installation token via actions/create-github-app-token using the
APP_ID + APP_PRIVATE_KEY secrets that were just provisioned for this
repo. Removes the dead GH_PAT fallback (the secret was never set; the
GITHUB_TOKEN branch silently took over). Closes the dogfood-doctor gap
called out in docs/roadmap.md.

Drops the now-resolved migration item from docs/roadmap.md; the
reusable-workflow investigation entry stays.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* fix(build): rename bundle to dist/index.cjs to match CommonJS format

package.json declares "type": "module", which made Node 24 try to load
the esbuild-produced CommonJS bundle (which uses require()) as ESM and
throw "ReferenceError: require is not defined". Renaming the output to
.cjs is explicit about the bundle's module system without disturbing the
ESM source/test surface (where dropping "type": "module" would break
import.meta usage in tests).

Updates scripts/build.mjs (outfile) and action.yml (main) accordingly.

Pre-existing issue surfaced by the dogfood App-token migration making
the Flywheel — Push run reach the bundle execution step.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* test(e2e): scaffold helpers, vitest config, and npm script

Layer 3 foundation: poll-until, sandbox-e2e (push/merge/tag/check ops),
run-baseline (stale-run filter), tag-cleanup (snapshot/diff/delete);
vitest.e2e.config.ts (fileParallelism: false, testTimeout 180s);
test:e2e script; exclude tests/e2e from the unit suite.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* test(e2e): add PR-flow scenarios 01-04

01: fix PR auto-merges (mergedAt poll, 120s timeout, diagnostic dump on
failure for the known mergeStateStatus=BLOCKED flake risk).
02: feat PR labeled needs-review, auto_merge null, observation window.
03: fix! against e2e-staging (excluded from auto_merge) → needs-review.
04: malformed title posts flywheel/conventional-commit failure check.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* test(e2e): add promotion-flow scenarios 05-07

05: a fix merge to e2e-develop opens a develop→staging promotion PR.
06: a chore-only merge to e2e-staging does NOT open a staging→main PR
(non-bumping, target auto_merge=[]).
07: two sequential fix merges upsert the same promotion PR; body lists
both commits.

All three filter workflow runs by databaseId > baseline_id via
run-baseline.snapshotRunIds + waitForRunAfter so long-lived branch state
from prior runs doesn't surface as a false positive (lesson from
pre-reset commit 238aca0).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* test(e2e): add release/tag scenarios 08-09

08: a fix merge to e2e-customer-acme creates a customer-acme/v* tag and
NO bare v* tag; tag-cleanup deletes the new tag in afterEach.
09: pragmatic deviation from the original "semantic-release-dry-run"
roadmap entry (which was self-contradictory — dry-run does not create).
Loads .flywheel.yml from the live sandbox via API and exercises
chooseTagFormat for each stream — main-line → v\${version},
customer-acme → customer-acme/v\${version}, integration → integration/v\${version}.
Catches cross-stream tag collision without mutating sandbox state.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* ci(e2e): add e2e workflow with doctor.sh pre-flight

Triggers on push to develop only (skip on forks). Mints a sandbox-scoped
installation token from flywheel-build-e2e App, runs scripts/doctor.sh
against the sandbox as a pre-flight (fails fast on configuration drift —
missing branches, secret expiry, ruleset removal), then npm run test:e2e.
20-minute job timeout; concurrency group cancel-in-progress: false so
in-flight tests aren't killed by a subsequent develop push.

Not added to branch protection as a required check; per testing strategy
this happens after ~1 week of observed stability.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* docs(testing): mark Layer 3 implemented; add sandbox workflow installation

testing_strategy.md: flip Layer 3 from Deferred to Implemented; replace the
roadmap section with the actual layout, helper inventory, isolation
strategy, scenario 09 deviation rationale, and the scenario 01 flake-risk
callout for auto-merge BLOCKED state. Update CI pipeline table to reflect
e2e on push to develop. Note doctor.sh pre-flight.

docs/sandbox-setup.md: add "Layer 3 workflow installation" section with
the copy-templates / repin-to-develop / apply-rulesets commands. The
sandbox now reuses scripts/templates/flywheel-{pr,push}.yml as the
canonical workflows rather than duplicating YAML in this doc.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* fix(integration): add prerelease to integration-test-base in sandbox mirror

Without a prerelease identifier, integration-test-base's terminal branch
is treated as a production terminal alongside e2e-main, which trips
loadConfig rule 3 (>1 stream with terminal prerelease: false). The actual
sandbox .flywheel.yml carries prerelease: "int" on this branch; mirror it
here so the TS object matches and loadConfig wouldn't reject it if it ever
flowed through validation (e.g., from the e2e-09 live-config check).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* fix(init): tolerate BASH_SOURCE unset under curl|bash invocation

set -u trips on \${BASH_SOURCE[0]} when init.sh is piped via curl|bash —
BASH_SOURCE is empty in that mode and the script aborts with "unbound
variable" before reaching the local-templates fallback or the curl-based
fetch. Default to empty and skip local-templates detection in that path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* chore(scripts): swap yq for python3+PyYAML; bash 3.2 compat in doctor

Standardize on python3+PyYAML for YAML extraction across init.sh,
doctor.sh, and apply-rulesets.sh. Rationale: python3 ships with macOS
12.3+ and most Linux distros; PyYAML is pulled in by yamllint, ansible,
mkdocs, pre-commit, and most things adopters already run, so no extra
install for the typical user. yq (mikefarah) was a separate Go binary
nobody had preinstalled.

doctor.sh: also replace `declare -A` with parallel arrays — assoc arrays
are bash 4+ but macOS still ships bash 3.2, which broke the rulesets
section locally. Verified end-to-end against point-source/flywheel-sandbox.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* ci: add workflow_dispatch to integration and e2e workflows

Lets maintainers trigger Layer 2/3 runs against the sandbox manually
(e.g., after sandbox provisioning changes, before merging a feature
branch that touches sandbox-facing code) without having to open a
speculative PR or push to develop. The job already gates itself on
non-fork repository so secrets remain protected.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* docs: add Issues + Checks App permissions to all permissions lists

Layer 2 integration tests caught two missing permissions in the docs:

- Issues: read/write — required by addLabels/removeLabel for the
  flywheel:auto-merge / flywheel:needs-review labels (PR labels go
  through the Issues API). sandbox-setup.md already listed it; the
  other docs did not.
- Checks: read/write — required by createCheck when an invalid PR
  title triggers the flywheel/conventional-commit check. None of the
  docs listed it. The integration suite's pr-title-rewrite test
  surfaced this as 403 "Resource not accessible by integration"
  with x-accepted-github-permissions: checks=write.

Updated: README.md, docs/adopter-setup.md, docs/maintainer-setup.md,
docs/sandbox-setup.md, scripts/init.sh.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* feat: action mints its own installation token + preflight permission check

Replaces the two-step adopter pattern (actions/create-github-app-token →
flywheel uses the minted token) with a single step: flywheel accepts
app-id + app-private-key directly, mints its own installation token,
captures the granted permissions from the token-mint response, and
validates them against the action's required set BEFORE doing any work.

When permissions are missing or insufficient, the action fails with a
single error that names every gap (e.g. "checks: need write, granted
read") and links to the App's settings page. This catches App
misconfiguration at adoption time instead of surfacing as a cryptic 403
on the first invalid-title PR.

Required permissions enforced:
  contents: write          (semantic-release tag/CHANGELOG push)
  pull_requests: write     (PR creation, body updates, auto-merge)
  issues: write            (flywheel:* labels on PRs)
  checks: write            (flywheel/conventional-commit check)
  metadata: read           (always required)

Workflow templates simplified — adopters no longer need a separate
actions/create-github-app-token step, and the push template uses
${{ steps.flywheel.outputs.token }} for semantic-release. Both dogfood
workflows updated to the same shape.

Adds @octokit/auth-app as the runtime JWT/installation-token dep
(8 new preflight unit tests; 111/111 total passing).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* feat(pr-flow): always-post conventional-commit check + direct-merge fallback

Two product changes that together let flywheel work cleanly for adopters
with no required status checks (e.g. the sandbox), and also let adopters
that DO want a quality gate add flywheel/conventional-commit to their
required checks without having to define their own check.

1. Always post the flywheel/conventional-commit check.
   Previously: only posted on parse failure (conclusion: failure).
   Now: also posted on parse success (conclusion: success). Adopters can
   safely add it to required_status_checks without "Expected — Waiting
   for status" hangs on valid-title PRs.

2. Direct-merge fallback when native auto-merge declines.
   GitHub's enablePullRequestAutoMerge mutation fails with "Pull request
   is in clean status" when nothing's pending — which happens on every
   PR in a repo without required checks. Previously the action gave up
   and emitted a warning. Now it falls back to a direct pulls.merge call
   with the App's installation token; if branch protection rules are
   satisfied (linear history, PR required, etc.), the merge succeeds.
   If both auto-merge AND direct merge fail, the original warning fires.

PrFlowOutcome now carries `merged: boolean` to distinguish "scheduled
for later" (auto-merge enabled) from "merged now" (direct-merge
fallback). Adds GitHubClient.mergePR + fakeGh wiring + 1 new pr-flow
unit test for the both-failed path. 112/112 passing.

Source for the direct-merge pattern: pre-reset commit 87d5643 +
60fe99a's rationale ("auto-merge alone is unreliable in practice...
we keep enabling it but ALSO call pulls.merge directly").

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* fix: normalize missing-space-after-colon titles + align integration tests

The conventional commit parser previously rejected `fix(auth):handle…` (no
space after the colon). Now it accepts the typo so `formatTitle` can rewrite
the title with proper spacing — surfacing flywheel's normalization promise
that adopters were already exercising in the integration suite.

Also rewrites the auto-merge integration tests to match the new product
behavior on no-required-checks branches: an eligible PR is direct-merged
(autoMergeEnabled=false, merged=true), and the disable-path test uses an
ineligible PR pre-labeled flywheel:auto-merge to exercise disableAutoMerge
against real GitHub.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

* fix(doctor): fetch remote contents when validating a different repo

When run from one repo against another (e.g. flywheel's e2e workflow
running doctor.sh against flywheel-sandbox), the script was reading the
local cwd's .flywheel.yml and workflow files instead of the target repo's
— so the dogfood config and workflows reported as the sandbox's, producing
spurious failures.

When the target REPO arg differs from the cwd's repo, fetch
.flywheel.yml and the two workflow files from the target via the GitHub
contents API instead.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
