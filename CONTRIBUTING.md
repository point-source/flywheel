# Contributing to Flywheel

Thanks for hacking on Flywheel. This guide covers everything you need to make a change, validate it locally, and submit a PR with confidence.

> The GitHub repo, the published action, and the product are all named **Flywheel** (`point-source/flywheel`).

## Prerequisites

- **Node 24+** — `runs.using: node24` in `action.yml` and CI uses `actions/setup-node@v4` with `node-version: "24"`.
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
.flywheel.yml           dogfood config (single stream, single branch: main)
spec.md                 authoritative spec
testing_strategy.md     target three-layer test architecture (see Status note below)
```

## Edit-test-build loop

```bash
npm run test:watch       # fast feedback while editing
npm run typecheck        # strict TS check
npm run build            # esbuild bundle → dist/index.cjs
npm run verify-dist      # rebuild + fail if dist/ drifts (same check CI runs)
```

**`dist/index.cjs` is committed.** GitHub Actions executes the bundle directly; there is no install step at action runtime. The `Verify dist` workflow (`.github/workflows/verify-dist.yml`) runs `npm run build` on every PR and fails if the resulting `dist/` doesn't match what you committed. Always `npm run build` and stage `dist/index.cjs` before opening a PR.

## Adding a `.flywheel.yml` validation case

Validation rules live in `src/config.ts` and are tested via `tests/config.test.ts` against fixtures in `test-fixtures/`. Pattern:

1. Drop a new YAML file in `test-fixtures/` named for the scenario (e.g. `flywheel.my-case.yml`).
2. Add an `it(...)` block in `tests/config.test.ts` that loads the fixture and asserts on the validation result.
3. Run `npm run test:watch` to iterate.

See the existing fixtures for examples — each one isolates a single failure mode.

## PR title conventions

Flywheel rewrites every PR title against the Conventional Commits grammar. Use:

```
<type>[(<scope>)][!]: <description>
```

Examples that work: `fix(promotion): handle empty diff`, `feat: support semantic_release_plugins`, `feat!: drop API v1`, `chore: bump deps`.

This repo's `.flywheel.yml` auto-merges `feat`, `fix`, `fix!`, `chore`, `refactor`, `perf`, `style`, `test`, `docs`, `ci`, `build`. It deliberately **excludes `feat!`** — major bumps require human review.

## Manual end-to-end validation

Unit tests cover the logic; manual validation covers the wiring (Octokit calls, action runtime, semantic-release invocation). Pick whichever option fits your change.

### Option A — Dogfood this repo (recommended for most changes)

The repo is itself a Flywheel adopter. Open a PR against `main` and your change runs through the live `flywheel-pr.yml` and `flywheel-push.yml` workflows.

1. Create a branch and push a small change.
2. `gh pr create --title "chore: smoke test my change"` (or use the GitHub UI).
3. Watch the PR's checks:
   - **`Flywheel — PR`** should rewrite your title (it's already a clean conventional commit, so the diff may be cosmetic) and apply `flywheel:auto-merge` or `flywheel:needs-review`.
   - **`Verify dist`** should pass — if it doesn't, you forgot to `npm run build` and commit `dist/index.cjs`.
4. After merge, watch the push to `main`: `Flywheel — Push` runs `npx semantic-release@24` and (if your commit qualifies) cuts a tag and GitHub Release.

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
     merge_strategy: squash
     initial_version: 0.1.0
   ```
3. Copy `flywheel-pr.yml` / `flywheel-push.yml` from [`docs/adopter-setup.md`](./docs/adopter-setup.md), but replace
   ```yaml
   uses: point-source/flywheel@v2
   ```
   with a reference to your fork on the branch you're testing:
   ```yaml
   uses: <your-handle>/flywheel@<your-branch>
   ```
   Push your branch (with a freshly built `dist/index.cjs`) so GitHub Actions can resolve the ref.
4. Configure App-token secrets (`FLYWHEEL_GH_APP_ID` + `FLYWHEEL_GH_APP_PRIVATE_KEY`) using either `scripts/init.sh` from your sandbox repo or the manual steps in [`docs/adopter-setup.md`](./docs/adopter-setup.md#1-create-a-github-app).
5. Open a PR with title `chore: smoke test` and confirm the rewrite + label + auto-merge behaviour.
6. Merge it. Confirm the push triggers `semantic-release` and produces a tag + GitHub Release.

## Pre-submission checklist

Before opening a PR:

- [ ] `npm run typecheck` is clean
- [ ] `npm test` is clean
- [ ] `npm run verify-dist` is clean (i.e. you ran `npm run build` and committed `dist/index.cjs`)
- [ ] PR title is a Conventional Commit; breaking change is signalled with `!` if appropriate
- [ ] If you added a validation rule, you added a fixture in `test-fixtures/` and a test in `tests/config.test.ts`

## Status of `testing_strategy.md`

`testing_strategy.md` documents three test layers:

- **Layer 1 (unit)** — implemented. `tests/*.test.ts` covers parsing, validation, increment computation, label decisions, promotion dedup, idempotency, and the GraphQL auto-merge fallback. Run `npm test`.
- **Layer 2 (integration)** — being introduced. Real-Octokit tests under `tests/integration/` running against `point-source/flywheel-sandbox`. CI mints a token from the `flywheel-build-e2e` GitHub App and exports it as `SANDBOX_GH_TOKEN`; provisioning is documented in [`docs/sandbox-setup.md`](./docs/sandbox-setup.md).
- **Layer 3 (E2E)** — deferred. Sandbox branches are pre-positioned so Layer 3 can be added without re-provisioning.

Until Layer 2 lands fully, the dogfood and personal-sandbox loops above are still the primary end-to-end validation path.

## Other docs

- [`spec.md`](./spec.md) — authoritative spec; the source of truth when a doc disagrees.
- [`docs/adopter-setup.md`](./docs/adopter-setup.md) — user-facing setup walkthrough; contributors writing schema or workflow changes should keep this aligned.
- [`docs/maintainer-setup.md`](./docs/maintainer-setup.md) and [`docs/maintainer-release-process.md`](./docs/maintainer-release-process.md) — operating Flywheel itself (rulesets, release cuts, the `v1` floating tag). Maintainer-only.
