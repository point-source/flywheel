# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This repo is a Flywheel adopter. The contribution rules — PR title format, target branch, branch naming, things-not-to-do — live in [`CONTRIBUTING.md`](./CONTRIBUTING.md) and apply to you the same as a human contributor. Read it before opening a PR.

Two non-negotiables you'll hit immediately:

1. **Target `develop`**, not `main`. The `develop → main` promotion is bot-managed by `flywheel-push.yml`; PRs into `main` get rejected on protected-branch rules.
2. **PR titles must be Conventional Commits.** Flywheel rewrites malformed titles automatically, but the rewrite + re-run round-trip costs CI minutes that add up across many concurrent PRs.

## Where to start

- **Product behavior + design rationale**: [`spec.md`](./spec.md) is authoritative — doc-vs-doc disagreements resolve to spec.md.
- **Contribution rules, build/test commands, dogfood loop**: [`CONTRIBUTING.md`](./CONTRIBUTING.md).
- **User-facing onboarding** (what an adopter reads): [`docs/adopter-setup.md`](./docs/adopter-setup.md).

## Architecture in one paragraph

Flywheel is a single TypeScript GitHub Action (`src/main.ts`) that dispatches by event type to one of two flows: `src/pr-flow.ts` (rewrites PR titles, applies `flywheel:auto-merge` / `flywheel:needs-review`, enables native auto-merge) or `src/push-flow.ts` (generates `.releaserc.json`, gates the `semantic-release` step in `flywheel-push.yml`, computes back-merge targets). It is stateless — the repository's branches, tags, PRs, and labels are the state machine; nothing is held between runs. `.flywheel.yml` is the single source of truth for branch topology, stream definitions, and auto-merge rules. `src/config.ts` validates it; `src/release-rc.ts` derives the semantic-release config from it at runtime (adopters never edit `.releaserc.json` themselves).

## Build / test essentials

```bash
npm install
npm run typecheck      # strict TS
npm test               # vitest unit tests
npm run test:watch     # iterate
npm run build          # esbuild → dist/index.cjs
npm run verify-dist    # rebuild + fail if dist/ drifts (CI runs this on every PR)
```

Run a single test file: `npx vitest run tests/<name>.test.ts`. Run by description: `npx vitest run -t "<substring of test name>"`. Integration and e2e suites use separate configs and are wired as `npm run test:integration` / `npm run test:e2e` — see `CONTRIBUTING.md` for the sandbox setup they require.

## The `dist/` rule (load-bearing)

`dist/index.cjs` is committed and GitHub Actions executes it directly — there is no install step at action runtime. The `Verify dist` workflow rebuilds on every PR and fails if the committed `dist/` doesn't match a fresh build. **Always `npm run build` and stage `dist/index.cjs` before pushing**, or `Verify dist` fails and the PR stalls. This applies even when your only edits are in `src/` — the bundle must reflect them.

## Adding a `.flywheel.yml` validation case

Drop a YAML in `test-fixtures/` named for the scenario, then add an `it(...)` block in `tests/config.test.ts` that loads it and asserts the expected validation outcome. Existing fixtures isolate one failure mode each — follow the same pattern.
