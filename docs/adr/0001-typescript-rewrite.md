# ADR 0001: TypeScript greenfield rewrite

**Status:** Accepted — 2026-04-27

## Context

The original swarmflow implementation, started early 2026, was structured as:

- Reusable workflows under `.github/workflows/` (`orchestrator.yml`, `pr-lifecycle.yml`, `promote.yml`, `release.yml`) called by adopters via `workflow_call`
- Internal logic factored into composite actions under `.github/actions/` (~9 of them: `app-token`, `load-config`, `parse-commits`, `compute-version`, `render-pr-body`, `upsert-pr`, `detect-merge-queue`, `auto-merge`, `wait-run`), all bash
- A sandbox-driven e2e harness under `.github/workflows/e2e.yml` testing against `point-source/swarmflow-e2e-sandbox`

**It never worked end-to-end.** Across ~13 e2e iterations, the pipeline hit a structural GitHub limitation that no amount of incremental fix could resolve cleanly: when a reusable workflow uses a local composite action via `uses: ./.github/actions/X`, the `./.github/actions/X` path is resolved against the **caller's** checkout, not the repo where the reusable workflow lives. For an adopter calling `point-source/swarmflow/.github/workflows/pr-lifecycle.yml@v1`, `./.github/actions/parse-commits` looks inside the adopter's repo — where it doesn't exist.

The failing run that surfaced this conclusively: run `25020132216` in the sandbox repo, where pr-lifecycle's first composite reference errored with `Can't find 'action.yml'... under '.swarmflow/.github/actions/app-token'`.

`github.workflow_ref` is **not** a workaround. It always resolves to the entry workflow (the adopter's `on-pr.yml`), regardless of nesting depth, so a reusable workflow cannot introspect its own ref to side-load its own repo.

## Workarounds attempted (and partially rejected)

| Attempt | Outcome |
|---|---|
| Side-load checkout into `.swarmflow/`, reference composites via `./.swarmflow/.github/actions/X` | Works mechanically, but required ~9 separate composite references per workflow, each resolving against the side-loaded path |
| Thread `swarmflow_repo`/`swarmflow_ref` inputs through `workflow_call` chain | Necessary because `uses:` cannot take expressions, but bloated adopter templates with 2 extra lines they had to keep in sync with `@v1` |
| Use `uses: owner/repo/.github/actions/X@<ref>` cross-repo with `<ref>` hardcoded to `v1` | Fails because the reusable workflow at SHA X cannot test composites at SHA X without `<ref>` being an expression — and `uses:` cannot take expressions |

The **input threading** is correct in concept but was applied PER COMPOSITE in the bash version, which is what made the workflows hard to maintain. The threading itself is the only viable escape hatch for self-testing arbitrary SHAs.

## Decision

Greenfield rewrite in TypeScript, distributed as a single ncc-bundled action at the repo root (`action.yml`). The action takes a `command` input that selects one of `pr-lifecycle | promote | release | render-pr-body`. Reusable workflows become thin wrappers (~25 lines each) that:

1. Check out the caller's repo (for git-history-dependent operations)
2. Check out swarmflow at `inputs.swarmflow_repo`/`inputs.swarmflow_ref` into `path: .swarmflow`
3. `uses: ./.swarmflow` with `command: <X>` and the relevant inputs forwarded

There is **one** swarmflow checkout per workflow and **one** `uses: ./.swarmflow` invocation per workflow. The bundled JS action handles all logic.

The `swarmflow_repo`/`swarmflow_ref` inputs are kept as **internal** workflow inputs with sensible defaults (`point-source/swarmflow` and `v1`). Adopter templates do not pass them. **E2e** overrides them via the entrypoint to test specific SHAs of swarmflow itself before merge.

This is **not** a forkability mechanism. Forks already edit swarmflow's source and can rewrite the hardcoded `point-source/swarmflow` value directly in their copy. The override exists solely because pre-merge e2e validation needs to test arbitrary SHAs, and `uses:` cannot take expressions.

### Deprecation TODO

Revisit the `swarmflow_repo`/`swarmflow_ref` override ~6 months after `v1.0` is stable. If the project proves low-velocity and well-tested by then, the override can be removed: workflows hardcode `@v1`, e2e becomes a post-merge-only smoke test against the just-published version. The trade-off is acceptable for a stable project; risky during the rewrite when fast PR-time validation is essential.

## Why TypeScript specifically

- ~80% of GitHub Marketplace actions are TypeScript or JavaScript. The paved path.
- `@actions/core` (input/output/logging) and `@actions/github` (Octokit factory + GraphQL) are first-party libraries from GitHub/Microsoft, with rich type definitions for the entire GitHub API surface.
- `@vercel/ncc` bundles the entire action into a single `dist/index.js` file. Consumers pin `@v1` and execute the bundle directly via `runs.using: node20` — no install step at runtime, no cold-start cost.
- Vitest unit tests with mocked Octokit (via `undici`'s `MockAgent` at the transport layer) eliminate the 8-minute e2e roundtrip for ~90% of validation. The same logic that took 13 sandbox iterations to surface a bug now fails a unit test in milliseconds.
- The conventional-commit parser and changelog formatter modules from `release-please` (which spec.md §41 mandates as the version/changelog engine) are imported as a library, exactly as the spec calls for.

### Alternatives considered

| Language | Why not |
|---|---|
| Go | Smaller ecosystem for actions; fewer reference projects; `goreleaser-action` is a positive precedent but the pattern is rarer |
| Python | Cold-start install cost at runtime; less ecosystem support for actions specifically |
| Bash + bats unit tests | Doesn't solve the cross-repo composite resolution problem; bash unit tests have low adoption and poor mocking ergonomics |
| TypeScript with no compiled bundle (Node + transpile at runtime) | Forces consumers to install dependencies; not standard for actions |

## Why greenfield, not migration

The bash implementation never produced a green e2e. Most of the recent commit churn (commits `92b86f2` through `1a68689`, ~13 commits) was architectural workarounds for the cross-repo composite problem, not validation of pipeline logic. We have low confidence the bash semantics are correct.

What we **did** preserve from the bash work is encoded as **defensive unit tests** in the rewrite, mined from commit history:

| # | Learning | Source commit |
|---|---|---|
| 1 | Reachability-aware tag lookup (`git describe --exclude '*-*'`, not globally highest) | `c36b732` |
| 2 | Pre-release counters globally scoped (no `-dev.N` reuse across branches) | (carried in current `compute-version`) |
| 3 | Chore-only push: no tag, but build dispatched if `publish_on_*=true` | `5f4c62b` |
| 4 | Highest-bump commit selects PR title (else squash under-bumps version on push) | `fe1d068` |
| 5 | PR body re-render after quality checks (else freezes on "pending") | `2a6ffc7` |
| 6 | Conditional quality line in PR body (only when quality workflow configured) | `2a6ffc7` |
| 7 | GitHub Actions `?branch=` API unreliable; post-filter on headBranch | `07f2c24` |
| 8 | Merge queue detection requires auth + safe fallback to false on error | `46da99c` |
| 9 | Workflow_call permission validation is eager; entrypoints need union block | `ef5f00e`, `28632ca` |
| 10 | Owner names case-sensitive on GitHub API (canonical lowercase) | `e14063e` |
| 11 | Tag + GitHub Release before CHANGELOG.md commit (recovery semantics) | `841f63b` |
| 12 | Per-composite cross-repo references regress (the rewrite's reason for existence) | `1bf074e`, `1a68689` |

Each becomes a named test in the new suite. Commit history remains accessible via `git log` for anyone wanting full context.

## Consequences

- **Adopter templates return to spec-shape (~12 lines)**: `swarmflow_repo`/`swarmflow_ref` are internal workflow inputs with defaults; adopters never see them.
- **Cross-repo composite resolution shrinks** from ~9 plumbed references per workflow to 1 (one checkout, one `uses: ./.swarmflow`).
- **`dist/index.js` (1–3 MB) is committed** to the repo. Reviewers do not read the bundle; they trust the CI freshness check. `.gitattributes` marks `dist/index.js linguist-generated=true` so PR diffs collapse it.
- **Bash contributors must onboard to TypeScript.** `docs/CONTRIBUTING.md` includes a "how to add a new command" walkthrough that maps composite-action vocabulary to module vocabulary.
- **First green e2e is later** than it would be with incremental migration, but Phase 1.5's vertical-slice e2e validates the architecture before any module work, and unit tests cover ~80% of logic from Phase 2a onward.
- **Spec.md §41 is honored**: `release-please` is imported as a library (its `parser` and `changelog` modules), not invoked as a CLI orchestrator.
- **Spec.md §779's "Quality check interface" open question is closed**: `workflow_dispatch` with `pr_number` and `sha` inputs. The starter template (`templates/pipeline-quality.yml.example`) already used this contract; the spec now formalizes it.

## What survived from the bash era

- `spec.md` — source of truth, one minor edit (§779 closed)
- `docs/CONFIG.md`, `docs/RULESETS.md`, `docs/ONBOARDING.md`, `docs/E2E.md` — light edits to remove side-load language
- `.github/workflows/e2e.yml` — adapted in place; harness shape preserved
- `point-source/swarmflow-e2e-sandbox` — no GitHub-side changes; the `e2e-baseline` tag stays valid

## What was removed in the rewrite merge

- `.github/actions/` — all 9 bash composites
- `scripts/lib.sh`, `scripts/commit-parse.sh`, `scripts/version-bump.sh`, `scripts/pre-release-counter.sh`, `scripts/pr-body.sh`
- `tests/` (bats unit tests — replaced by Vitest)
- `.github/workflows/smoke.yml` (covered by CI)
- Per-composite `swarmflow_repo`/`swarmflow_ref` threading — kept only as one input pair per workflow

---

**This document must not be deleted** when the bash composites are removed. It is the answer for the next contributor who wonders why workflows reference a bundled JS action instead of YAML composites — and why the `swarmflow_repo`/`swarmflow_ref` override exists despite looking like dead weight in the canonical install.
