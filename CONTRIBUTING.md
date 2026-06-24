# Contributing to Flywheel

Thanks for hacking on Flywheel. This guide covers everything you need to make a change, validate it locally, and submit a PR with confidence.

> The GitHub repo, the published action, and the product are all named **Flywheel** (`point-source/flywheel`).

## Prerequisites

- **Node 24+** — `runs.using: node24` in `action.yml` and CI uses `actions/setup-node@v5` with `node-version: "24"`.
- **npm** — the repo is npm-only (no yarn / pnpm lockfiles).
- **`gh` CLI** (optional) — handy for the dogfood loop below.

## Setup

```bash
npm install
npm run typecheck
npm test
```

That should be clean on a fresh checkout.

## Repo layout

```
src/                    TypeScript source (target ~400-500 lines total)
  main.ts               GitHub Actions entrypoint; dispatches by event
  config.ts             .flywheel.yml schema + validation
  conventional.ts       PR title / commit message parsing
  pr-flow.ts            pull_request event handler
  push-flow.ts          push event handler (release flow)
  promotion.ts          push event handler (promotion PR upsert)
  release-rc.ts         .releaserc.json generator
  github.ts             Octokit wrappers
  types.ts              shared types

tests/                  vitest unit tests (mirror src/)
test-fixtures/          .flywheel.yml fixtures, one per scenario
scripts/build.mjs       esbuild → dist/index.cjs
dist/index.cjs           committed bundle GitHub executes (see below)
.github/workflows/      this repo's own Flywheel + verify-dist workflows
.flywheel.yml           dogfood config (single stream, two branches: develop → main)
docs/design/spec.md             authoritative spec
docs/design/requirements.md     requirements the spec serves
docs/design/testing-strategy.md target three-layer test architecture (see Status note below)
```

## Edit-test-build loop

While iterating, run the individual checks for fast feedback:

```bash
npm run test:watch       # fast feedback while editing
npm run typecheck        # strict TS check
npm run build            # esbuild bundle → core/dist/index.cjs
npm run verify-dist      # rebuild + fail if core/dist/ drifts (same check CI runs)
```

Then, before opening a PR, run the single gate — see [Pre-submission checklist](#pre-submission-checklist).

**`core/dist/index.cjs` is committed.** GitHub Actions executes the bundle directly; there is no install step at action runtime. The `Verify dist` workflow (`.github/workflows/verify-dist.yml`) runs `npm run build` on every PR and fails if the resulting `core/dist/` doesn't match what you committed. `npm run check` (below) runs this check for you; always `npm run build` and stage `core/dist/` before opening a PR.

## Adding a `.flywheel.yml` validation case

Validation rules live in `src/config.ts` and are tested via `tests/config.test.ts` against fixtures in `test-fixtures/`. Pattern:

1. Drop a new YAML file in `test-fixtures/` named for the scenario (e.g. `flywheel.my-case.yml`).
2. Add an `it(...)` block in `tests/config.test.ts` that loads the fixture and asserts on the validation result.
3. Run `npm run test:watch` to iterate.

See the existing fixtures for examples — each one isolates a single failure mode.

## The `classify` action and its stable surface

Every release pushes up to three commits onto managed branches — the human merge, the `chore(release): X.Y.Z` version commit, and the back-merge into upstream branches — and each push re-triggers quality workflows that already passed on the merge. The release and back-merge commits carry no new source, so re-running tests against them cannot change the verdict; it just burns CI minutes (and, for adopters on metered runners or sandbox API budgets, real quota).

The `classify` composite action (`classify/action.yml`, backed by `scripts/classify-commit.sh`) lets a quality workflow skip that redundant work. It reads only `github.event` — no checkout, no token, no API calls — and emits two boolean outputs:

- **`derived_release_commit`** — `true` for a flywheel-produced commit that carries no test signal: the `chore(release):` version commit (authored by `semantic-release-bot`) or the `chore: back-merge …` merge commit (authored by `github-actions[bot]`). A fast-forward back-merge lands the `chore(release)` commit directly on the upstream branch, so it surfaces there too.
- **`promotion_pr`** — `true` when the run is for the long-lived develop→main promotion PR (PR title contains `: promote `).

Adopters gate on these in a job- or step-level `if:` (see `scripts/templates/quality.yml`); a skipped step/job reports `success` to required-status-check rules, so the gate stays honest. Flywheel dogfoods it in `integration.yml`, `verify-dist.yml`, and `governance-lint.yml`.

**Stable surface — do not change these without a major version bump.** The classify action, the scaffolded `quality.yml` template, and adopters pinned to `@v1` all depend on these strings:

| Signal | Pattern | Authored by |
|--------|---------|-------------|
| Release commit | message starts with `chore(release): ` | `semantic-release-bot` |
| Back-merge commit | message starts with `chore: back-merge ` | `github-actions[bot]` |
| Promotion PR | PR title contains `: promote ` | (n/a) |

The release-commit author depends on the `@semantic-release/git` default committer (`semantic-release-bot`); flywheel-push.yml configures no git identity of its own. If you ever set an explicit release-commit identity, update `scripts/classify-commit.sh` and this table in the same change — they are the single record of that coupling. Each prefix is trusted only from the bot that emits it, so a hand-authored commit using one of these prefixes is classified non-derived and its CI runs (the safe direction). Renaming a prefix, changing a bot identity, or altering the promotion-PR title format is a breaking change for adopters' quality workflows; bump the major. The behavior is specified in `SPEC.md` §spec:release-ci-budget and exercised by `tests/classify-commit.test.ts`.

## PR conventions

These rules apply to **everyone opening PRs against this repo** — human contributors and AI agents (Claude Code, Cursor, Copilot, Codex) alike. The same rule set is described generically in [docs/adopter/setup.md §6](./docs/adopter/setup.md#6-brief-your-contributors-human-and-ai); what follows is the dogfood version with this repo's actual values filled in. `CLAUDE.md` at the repo root is a thin pointer to this section, so keep it in sync if you restructure.

**Target branch.** Open all PRs against `develop` — the prerelease channel and first branch in the only stream. Do **not** PR directly into `main`; the `develop → main` promotion is upserted automatically by `flywheel-push.yml`.

**PR title format.** Must be a [Conventional Commit](https://www.conventionalcommits.org/):

```
<type>[(<scope>)][!]: <description>
```

Recognized types: `feat`, `fix`, `chore`, `refactor`, `perf`, `style`, `test`, `docs`, `build`, `ci`, `revert`. Append `!` for breaking changes. Examples that work: `fix(promotion): handle empty diff`, `feat: add stream validation`, `feat!: drop API v1`, `chore: bump deps`. Flywheel will rewrite a malformed title, but getting it right first time avoids a re-run.

**One logical change per PR.** Flywheel derives the version bump from the title, so squashing two unrelated `feat`s into one PR loses one of them in the release notes.

**Branch naming.** Use `<type>/<short-kebab-description>` (e.g. `feat/stream-validation`, `fix/empty-diff-promotion`, `chore/address-open-issues`).

**Closing linked issues.** If this PR fixes a tracked issue, include a `Closes #N` trailer in the PR body (or `Fixes #N` / `Resolves #N` — all three are recognised, case-insensitive). The PR template at `.github/pull_request_template.md` prompts for one. Flywheel preserves these trailers when it rewrites the body, and the `develop → main` promotion PR aggregates them into its own body so the issues auto-close when the release lands on `main`. The trailing `(#N)` GitHub appends to a squash-merge title is **not** a closing reference — without an explicit keyword, the issue stays open. AI agents authoring PRs: when the work resolves an issue, always include the trailer; do not rely on the title parenthetical.

**Auto-merge eligibility.** Both `develop` and `main` auto-merge `feat`, `fix`, `fix!`, `chore`, `refactor`, `perf`, `style`, `test`, `docs`, `ci`, `build`. They deliberately **exclude `feat!`** — major bumps require human review on this repo.

**Open PRs only when ready to merge.** A branch is your private work-in-progress; a PR is a request to merge. There is no "draft" intermediate state in this workflow. Iterate on the branch (push, run checks locally, etc.); when the work is ready, push and open the PR. Once open, Flywheel will rewrite the title, label it, and — if eligible — auto-merge as soon as required checks pass.

**One PR per branch; the branch dies on merge.** After your PR merges (or after any PR carrying your commits merges — e.g. a maintainer squashed them into a cleanup PR) the branch is done. Cut a new branch off the latest `develop` for your next change. The repo currently has `delete_branch_on_merge` disabled while issue #60 (targeted auto-delete that preserves stream branches) is open, so you must delete merged branches yourself (`git branch -D <name>` locally; `git push origin --delete <name>` for the remote). Reusing a merged branch causes phantom rebase conflicts because the squashed upstream commit has a different patch-id than your originals.

**Automating the local cleanup.** Two one-time setup steps make the local-side hands-off:

1. Turn on prune-on-fetch globally so deleted remotes drop out of `git branch -vv` automatically:
   ```bash
   git config --global fetch.prune true
   ```
   After this, every `git fetch` (and `git pull`) marks branches whose upstream was deleted with `[gone]`.

2. After fetching, delete any local branch whose upstream is gone:
   ```bash
   git branch -vv | awk '/: gone]/ {print $1}' | xargs -r git branch -d
   ```
   Use `-d` (safe — refuses unmerged branches) rather than `-D`, so you don't lose work that hadn't actually been pushed/merged. Wrap it in a shell or `git` alias if you do this often. VS Code, JetBrains IDEs, and `gh` extensions also expose equivalent "delete merged/gone branches" UI — pick whichever fits your flow.

**Things you must not do:**
- Do not push to or force-push `develop` or `main` directly; both are protected and only Flywheel's GitHub App is on the bypass list.
- Do not create version tags (`v1.2.3`, `v*-dev.N`, etc.) by hand. Only Flywheel's GitHub App may mint them.
- Do not edit a PR's title or body after Flywheel has rewritten them — push a new commit with the corrected conventional-commit message instead.
- Do not open `develop → main` promotion PRs by hand. If one is missing or stale, the upstream merge probably hasn't landed yet, or the pending commits are all non-bumping types.
- Do not reuse a branch after its commits have landed on `develop` (see "One PR per branch" above).

## Manual end-to-end validation

Unit tests cover the logic; manual validation covers the wiring (Octokit calls, action runtime, semantic-release invocation). Pick whichever option fits your change.

### Option A — Dogfood this repo (recommended for most changes)

The repo is itself a Flywheel adopter. Open a PR against `develop` (the prerelease channel — first branch in the only stream) and your change runs through the live `flywheel-pr.yml` and `flywheel-push.yml` workflows.

1. Create a branch and push a small change.
2. `gh pr create --base develop --title "chore: smoke test my change"` (or use the GitHub UI; `develop` is the default base for this repo).
3. Watch the PR's checks:
   - **`Flywheel — PR`** should rewrite your title (it's already a clean conventional commit, so the diff may be cosmetic) and apply `flywheel:auto-merge` or `flywheel:needs-review`.
   - **`Verify dist`** should pass — if it doesn't, you forgot to `npm run build` and commit `dist/index.cjs`.
4. After merge, watch the push to `develop`: `Flywheel — Push` runs `npx semantic-release@24` and (if your commit qualifies) cuts a `v*-dev.N` prerelease tag and GitHub Release. A promotion PR from `develop` into `main` opens once release-significant commits have accumulated; merging it cuts the real `vX.Y.Z` release on `main`, and the back-merge step replays that release commit + tag back into `develop`.

Caveat: a change to event-handler logic only takes effect once `dist/` reflects it on the branch the workflow checks out. The `flywheel-pr.yml` step `uses: ./` (local checkout), so the bundled `dist/` from your branch is what runs — no extra step needed beyond `npm run build`.

### Option B — Personal sandbox repo (for risky or schema-affecting changes)

When your change could meaningfully break adopters (schema changes, validation shifts, semantic-release config changes), validate against a clean repo first.

1. Create a throwaway repo on GitHub, e.g. `your-handle/flywheel-sandbox`.
2. Add a minimal `.flywheel.yml`:
   ```yaml
   flywheel:
     streams:
       - name: main-line
         branches:
           - name: main
             auto_merge: [fix, chore, docs]
   ```
3. Copy `flywheel-pr.yml` / `flywheel-push.yml` from [`docs/adopter/setup.md`](./docs/adopter/setup.md), but flip the composite action ref to your fork's branch:
   ```yaml
   uses: <your-handle>/flywheel@<your-branch>
   ```
   That single pin governs every flywheel file the sandbox will exercise — your fork's `action.yml`, `core/dist/index.cjs`, and `scripts/`. Push your branch (with a freshly built `core/dist/index.cjs`) so GitHub Actions can resolve the ref.
4. Configure App credentials (`FLYWHEEL_GH_APP_ID` repo Variable + `FLYWHEEL_GH_APP_PRIVATE_KEY` repo Secret) using either `scripts/init.sh` from your sandbox repo or the manual steps in [`docs/adopter/setup.md`](./docs/adopter/setup.md#1-create-a-github-app).
5. Open a PR with title `chore: smoke test` and confirm the rewrite + label + auto-merge behaviour.
6. Merge it. Confirm the push triggers `semantic-release` and produces a tag + GitHub Release.

## Pre-submission checklist

Before opening a PR, run the single pre-PR gate:

```bash
npm run check
```

`npm run check` runs **every** PR-gating check — typecheck, unit tests, the `core/dist/` bundle verification, and the governance/prose lint (`scripts/governance-lint.sh`) — in fail-fast order, stopping at the first failure and naming the gate that failed. It composes the same scripts CI runs (`verify-dist.yml`, `governance-lint.yml`), so a green `check` means those jobs will pass too. This replaces running the code checks by hand: the governance/prose lint is included by default, so you no longer have to know `scripts/governance-lint.sh` exists or invoke it separately.

- **[Vale](https://github.com/vale-cli/vale/releases) is a prerequisite** — a separate binary, not an npm dependency. Install it so the governance gate can run prose linting; without it the command reports the governance check as *missing* and fails rather than silently passing.
- `npm run check` **excludes the integration and e2e suites** — they exercise a shared, rate-limited sandbox (see [`docs/maintainer/sandbox-setup.md`](./docs/maintainer/sandbox-setup.md)), so they are not part of the per-PR gate. Run them deliberately with `npm run test:integration` / `npm run test:e2e`.

Then confirm:

- [ ] `npm run check` is clean (covers typecheck, tests, `core/dist/` verification, and governance/prose lint)
- [ ] PR title is a Conventional Commit; breaking change is signalled with `!` if appropriate
- [ ] If you added a validation rule, you added a fixture in `test-fixtures/` and a test in `tests/config.test.ts`

## Status of `docs/design/testing-strategy.md`

`docs/design/testing-strategy.md` documents three test layers:

- **Layer 1 (unit)** — implemented. `tests/*.test.ts` covers parsing, validation, increment computation, label decisions, promotion dedup, idempotency, and the GraphQL auto-merge fallback. Run `npm test`.
- **Layer 2 (integration)** — being introduced. Real-Octokit tests under `tests/integration/` running against `point-source/flywheel-sandbox`. CI mints a token from the `flywheel-build-e2e` GitHub App and exports it as `SANDBOX_GH_TOKEN`; provisioning is documented in [`docs/maintainer/sandbox-setup.md`](./docs/maintainer/sandbox-setup.md).
- **Layer 3 (E2E)** — deferred. Sandbox branches are pre-positioned so Layer 3 can be added without re-provisioning.

Until Layer 2 lands fully, the dogfood and personal-sandbox loops above are still the primary end-to-end validation path.

## Other docs

- [`docs/design/spec.md`](./docs/design/spec.md) — authoritative spec; the source of truth when a doc disagrees.
- [`docs/design/requirements.md`](./docs/design/requirements.md) — requirements the spec serves; the right place to evaluate alternative designs against.
- [`docs/adopter/setup.md`](./docs/adopter/setup.md) — user-facing setup walkthrough; contributors writing schema or workflow changes should keep this aligned.
- [`docs/maintainer/setup.md`](./docs/maintainer/setup.md) and [`docs/maintainer/release-process.md`](./docs/maintainer/release-process.md) — operating Flywheel itself (rulesets, release cuts, the `v1` floating tag). Maintainer-only.
