# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This repo is a Flywheel adopter. The contribution rules — PR title format, target branch, branch naming, things-not-to-do — live in [`CONTRIBUTING.md`](./CONTRIBUTING.md) and apply to you the same as a human contributor. Read it before opening a PR.

Three non-negotiables you'll hit immediately:

1. **Work in a sibling worktree off `origin/develop`.** This repo is routinely worked on by multiple agents in parallel, and the main working tree is shared — a `git checkout` there stomps on the other agent's WIP and produces confusing `git status` output across both sessions. Before any edits, create the worktree:

   ```bash
   git fetch origin develop
   git worktree add --no-track ../flywheel-<task-slug> -b <type>/<task-slug> origin/develop
   ```

   The `--no-track` flag is required: branching from a remote-tracking ref otherwise sets `origin/develop` as the new branch's upstream (git prints `set up to track 'origin/develop'`), and a stray `git push`/`git pull` could then move commits onto `develop`. A worktree branch must have no upstream until it is pushed with `-u`. Then edit, build, and commit inside `../flywheel-<task-slug>`. Sibling-directory worktrees (not `.claude/worktrees/`) are the convention here — `git worktree list` shows existing examples like `flywheel-133`. In the Claude Code harness, follow `git worktree add` with `EnterWorktree(path: "../flywheel-<task-slug>")` to switch the session into it; in other harnesses use `git -C <path> …` for git commands (cd-ing in compound commands triggers permission prompts). Clean up after merge with `git worktree remove ../flywheel-<task-slug>`. Apply this even when no other agent is visible — one extra `git worktree add` is cheaper than two agents fighting over one working tree.

2. **Target `develop`**, not `main`. The `develop → main` promotion is bot-managed by `flywheel-push.yml`; PRs into `main` get rejected on protected-branch rules.
3. **PR titles must be Conventional Commits.** Flywheel rewrites malformed titles automatically, but the rewrite + re-run round-trip costs CI minutes that add up across many concurrent PRs.

## Where to start

- **Product behavior + design rationale**: [`docs/design/spec.md`](./docs/design/spec.md) is authoritative — doc-vs-doc disagreements resolve to spec.md.
- **Contribution rules, build/test commands, dogfood loop**: [`CONTRIBUTING.md`](./CONTRIBUTING.md).
- **User-facing onboarding** (what an adopter reads): [`docs/adopter/setup.md`](./docs/adopter/setup.md).

## Architecture in one paragraph

Flywheel is a single TypeScript GitHub Action (`src/main.ts`) that dispatches by event type to one of two flows: `src/pr-flow.ts` (rewrites PR titles, applies `flywheel:auto-merge` / `flywheel:needs-review`, enables native auto-merge) or `src/push-flow.ts` (generates `.releaserc.json`, gates the `semantic-release` step in `flywheel-push.yml`, computes back-merge targets). It is stateless — the repository's branches, tags, PRs, and labels are the state machine; nothing is held between runs. `.flywheel.yml` is the single source of truth for branch topology, stream definitions, and auto-merge rules. `src/config.ts` validates it; `src/release-rc.ts` derives the semantic-release config from it at runtime (adopters never edit `.releaserc.json` themselves).

## The pre-PR gate: `npm run check`

**`npm run check` is the single command to run before opening a PR.** After `npm install`, it runs every PR-gating check — typecheck, unit tests, the `core/dist/` bundle verification, and the governance/prose lint (`scripts/governance-lint.sh`, the same script `governance-lint.yml` runs) — in fail-fast order, stopping at the first failure and naming the gate that failed (typecheck / test / verify-dist / governance-lint). It *composes* the existing checks — it calls the same scripts CI does rather than re-spelling them — so a local pass and a CI pass cannot diverge. If `npm run check` is green, the PR's gating jobs (`verify-dist.yml`, `governance-lint.yml`) will be too.

**Vale is a prerequisite** (a separate binary, not an npm dependency) — install it to run the prose lint: <https://github.com/vale-cli/vale/releases>. When Vale is absent the command reports the governance check as *missing* and fails rather than silently passing — a skipped check never reports success.

`npm run check` deliberately **excludes the integration and e2e suites**: they exercise a shared, rate-limited sandbox (§spec:sandbox-test-budget), so pulling them into the per-PR gate would defeat "run it before every PR." Run them on purpose via `npm run test:integration` / `npm run test:e2e` — see `CONTRIBUTING.md` for the sandbox setup they require.

The individual gates are also runnable on their own while iterating:

```bash
npm install
npm run typecheck        # strict TS
npm test                 # vitest unit tests
npm run test:watch       # iterate
npm run build            # esbuild → core/dist/index.cjs
npm run verify-dist      # rebuild + fail if core/dist/ drifts
npm run governance-lint  # markdownlint + Vale prose + SPEC/ROADMAP/README structure
```

Run a single test file: `npx vitest run tests/<name>.test.ts`. Run by description: `npx vitest run -t "<substring of test name>"`.

## The `core/dist/` rule (load-bearing)

`core/dist/index.cjs` is committed and GitHub Actions executes it directly — there is no install step at action runtime. The `Verify dist` workflow rebuilds on every PR and fails if the committed `core/dist/` doesn't match a fresh build. `npm run check` runs this verification (via `npm run verify-dist`), so a green `check` confirms your bundle is rebuilt and staged — but if you bypass the gate, **always `npm run build` and stage `core/dist/` before pushing**, or `Verify dist` fails and the PR stalls. This applies even when your only edits are in `src/` — the bundle must reflect them.

## Adding a `.flywheel.yml` validation case

Drop a YAML in `test-fixtures/` named for the scenario, then add an `it(...)` block in `tests/config.test.ts` that loads it and asserts the expected validation outcome. Existing fixtures isolate one failure mode each — follow the same pattern.

## `.flywheel.yml` snippets in docs must parse

Every full YAML example shown to adopters (`README.md`, `docs/**/*.md`, `scripts/templates/flywheel.*.yml`) is a recipe they copy verbatim — if the documented "minimal" config doesn't validate, adopters can't get started (see #165). `tests/docs-examples.test.ts` extracts every ```` ```yaml ```` block with a top-level `flywheel:` key plus `streams:` and runs it through `loadConfig`; the unit-test suite fails if any of them produce parse errors. When you add or edit a doc example, run `npx vitest run tests/docs-examples.test.ts` before pushing. Partial snippets (e.g. a standalone `release_files:` block) are excluded by the extractor's filter — keep them partial, or add a `streams:` block to opt into validation.
