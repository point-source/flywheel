# Flywheel — testing strategy

## Overview

Flywheel has three testing layers, all implemented. Layer 1 (unit) verifies
the bulk of decision logic. Layer 2 (integration) exercises `pr-conductor`
against the real GitHub API on a dedicated sandbox repo. Layer 3 (end-to-end)
drives the full Actions event chain on that same sandbox.

| Layer | What it tests | Speed | Status | Runs on |
|---|---|---|---|---|
| Unit | Pure logic, no I/O | Milliseconds | **Implemented** | Every file save; required check on PR / push |
| Integration | `pr-conductor` against real GitHub API | Seconds | **Implemented** | PR open/sync; push to `develop`/`main` (skipped on forks) |
| End-to-end | Full Actions event chain on sandbox | Minutes | **Implemented** | Push to `develop` (skipped on forks) |

Sandbox repo (`point-source/flywheel-sandbox`) provisioning — including the
Layer 3 workflow installation step — is documented in
[`docs/sandbox-setup.md`](docs/sandbox-setup.md). Layers 2 and 3 require it.

---

## Layer 1 — Unit tests

Pure TypeScript, no network, no file I/O beyond reading bundled fixtures. All
GitHub API interactions are routed through the `GitHubClient` interface
(`src/github.ts:45-66`) and substituted in tests by `tests/helpers/fakeGh.ts`,
which records every call for assertion.

### Tooling

Vitest 3.x. `npm test` runs the suite once; `npm run test:watch` runs in watch
mode. No special infrastructure required.

### What's covered

| File | Tests | Coverage |
|---|---|---|
| `tests/conventional.test.ts` | 57 | `parseTitle`, `detectBreakingInBody`, `computeIncrement`, combinatorial `mostImpactfulType` precedence (the bulk are `it.each`-generated pairwise precedence cases); accepts missing-space-after-colon as a typo to be normalized downstream |
| `tests/config.test.ts` | 11 | All 6 `.flywheel.yml` validation rules; multi-error collection; malformed YAML; missing top-level mapping; `merge_strategy: merge` rejection |
| `tests/dogfood-config.test.ts` | 3 | Validates the repo's own `.flywheel.yml`; asserts `feat!` is excluded from `main`'s `auto_merge` |
| `tests/release-rc.test.ts` | 8 | `.releaserc.json` shape; `chooseTagFormat` primary-vs-secondary; plugin merging without dropping defaults; declaration order |
| `tests/pr-flow.test.ts` | 11 | PR title/body rewrite; label application; both label-flip directions; auto-merge → direct-merge fallback (success and both-fail paths); idempotency; unmanaged base ref; invalid-title check |
| `tests/promotion.test.ts` | 12 | Promotion PR create/upsert; `computePendingCommits` squash-merge dedup; rebase-merge dedup; `(#NN)` suffix stripping; terminal/single-branch no-op |
| `tests/push-flow.test.ts` | 3 | `.releaserc.json` write to workspace; managed-vs-unmanaged branch routing |
| `tests/preflight.test.ts` | 8 | App permission preflight: missing/insufficient permissions detected; helpful error message formatting |

### Load-bearing tests

Three areas are called out because they protect against failures that are
either hard to recover from or easy to regress silently.

#### `computePendingCommits` squash and rebase merge dedup

`tests/promotion.test.ts:42-118`. The promotion PR generator must not
re-promote commits that have already been squashed or rebased onto the target.
Two flavors are tested:

- **Squash**: source has commits A/B/C, the prior promotion PR squash-merged
  onto target as a single commit titled `feat: promote develop → staging
  (#NN)`. After a new commit D lands on source, only D is pending.
- **Rebase**: source titles propagate verbatim to target after rebase. Tests
  assert title-equality match dedups correctly.
- **`(#NN)` suffix**: GitHub appends the PR number on squash. The matcher
  strips it before comparing.

If this logic regresses, every promotion PR re-includes already-promoted work
and the changelog becomes a duplicate-laden mess.

#### Auto-merge → direct-merge fallback

`tests/pr-flow.test.ts:129-168`. The `enableAutoMerge` GraphQL mutation can
fail (most commonly: the PR is in clean state because the repo has no
required status checks). The flow must fall through to a direct REST merge
(`pulls.merge`) so adopters without required checks aren't stuck — and if
the direct merge also fails, the label is still applied, a warning is
logged, and the PR is queryable. Two scenarios cover the success path
(auto-merge declines → direct merge succeeds → `merged: true`) and the
both-fail path (label applied, `merged: false`, warning logged).

#### Idempotency

`tests/pr-flow.test.ts:179-207` (body-rewrite idempotency) and the
full-flow idempotency test added alongside this strategy doc. GitHub Actions
retries events; running the same handler twice on the same input must produce
the same final state with no duplicate labels, no extra `updatePR` calls, and
no errors.

### Coverage by functional area

| Area | Tested | Where |
|---|---|---|
| Conventional commit parsing | ✅ | `conventional.test.ts` |
| Breaking change in title (`!`) and body (`BREAKING CHANGE:`) | ✅ | `conventional.test.ts` |
| Increment type (major/minor/patch/none) | ✅ | `conventional.test.ts` |
| Most-impactful type aggregation (full pairwise precedence) | ✅ | `conventional.test.ts` |
| `.flywheel.yml` validation (rules 1–6 + extras) | ✅ | `config.test.ts` |
| `.releaserc.json` generation, multi-stream tag isolation | ✅ | `release-rc.test.ts`, `push-flow.test.ts` |
| PR title rewrite, body increment annotation | ✅ | `pr-flow.test.ts` |
| Label application + flip in both directions | ✅ | `pr-flow.test.ts` |
| Native auto-merge enablement + direct-merge fallback | ✅ | `pr-flow.test.ts` |
| App permission preflight (action-side validation) | ✅ | `preflight.test.ts` |
| Invalid-title check creation | ✅ | `pr-flow.test.ts` |
| Promotion PR create / upsert / chore-only no-op | ✅ | `promotion.test.ts` |
| Promotion dedup (squash + rebase + `(#NN)`) | ✅ | `promotion.test.ts` |
| Idempotent re-run on the same event | ✅ | `pr-flow.test.ts` |
| `semantic-release` invocation itself | ❌ | not flywheel's surface; tested via Layer 3 once available |

---

## Layer 2 — Integration tests

Exercises `pr-conductor`'s production code paths against the real GitHub API
on `point-source/flywheel-sandbox`. These are not Actions-workflow tests —
they invoke the same exported functions production uses (`runPrFlow`,
`runPromotion`) with a real-Octokit-backed `GitHubClient` instead of the
fake.

### Tooling

Vitest, no parallelism (one PR pool — file-level isolation enforced via
`vitest.integration.config.ts`). Auth is supplied via `SANDBOX_GH_TOKEN`,
which CI mints from the `flywheel-build-e2e` GitHub App per run; for
local runs, mint an installation token from the same App (or your own
sandbox App) — see [`docs/sandbox-setup.md`](docs/sandbox-setup.md). Tests
skip automatically when the env var is missing (fork PRs, contributors
without provisioning access).

### Sandbox repo configuration

The sandbox repo is provisioned per [`docs/sandbox-setup.md`](docs/sandbox-setup.md).
It carries this `.flywheel.yml`:

```yaml
flywheel:
  streams:
    - name: main-line
      branches:
        - name: e2e-develop
          prerelease: dev
          auto_merge: [fix, fix!, chore, style, test, docs]
        - name: e2e-staging
          prerelease: rc
          auto_merge: [fix, chore]
        - name: e2e-main
          auto_merge: []

    - name: customer-acme
      branches:
        - name: e2e-customer-acme
          auto_merge: [fix, fix!, chore]

    - name: integration
      branches:
        - name: integration-test-base
          auto_merge: [fix, chore, perf, style, test]

  merge_strategy: squash
```

Long-lived branches: `e2e-main`, `e2e-staging`, `e2e-develop`,
`e2e-customer-acme`, `integration-test-base`. The `e2e-*` branches are
reserved for Layer 3; Layer 2 only targets `integration-test-base`.

### Test isolation

Each test creates a uniquely-named branch (`test/<scenario>-<unix-millis>`)
and a PR against `integration-test-base`. `afterEach` closes the PR and
deletes the branch regardless of pass/fail. `vitest.integration.config.ts`
forces `fileParallelism: false` and a 60 second default timeout.

### Layout

```
tests/integration/
  helpers/
    sandbox-client.ts     # real-Octokit GitHubClient bound to point-source/flywheel-sandbox
    test-pr.ts            # createTestPR, closeTestPR, unique branch naming
    teardown.ts           # afterEach cleanup contract
  pr-conductor/
    pr-title-rewrite.test.ts
    label-application.test.ts
    auto-merge-enablement.test.ts
    promotion-pr.test.ts
```

### Scenarios

#### PR title and body rewrite

```typescript
it('rewrites PR title to normalized conventional commit format', async () => {
  const pr = await createTestPR({
    branch: 'test/fix-title-rewrite',
    title: 'fix(auth):handle token refresh',  // missing space after colon
  })

  await runPrFlow({ pr: await fetchPR(pr.number), config, gh: sandboxGh, log })

  const updated = await fetchPR(pr.number)
  expect(updated.title).toBe('fix(auth): handle token refresh')
  expect(updated.body).toContain('**Increment type:** patch')
})
```

#### Label application

```typescript
it('applies flywheel:auto-merge to fix PR and flywheel:needs-review to feat PR', async () => {
  const fix = await createTestPR({ title: 'fix: correct null check', branch: 'test/fix-label' })
  await runPrFlow({ pr: await fetchPR(fix.number), config, gh: sandboxGh, log })
  expect((await fetchPR(fix.number)).labels).toContain('flywheel:auto-merge')

  const feat = await createTestPR({ title: 'feat: new dashboard widget', branch: 'test/feat-label' })
  await runPrFlow({ pr: await fetchPR(feat.number), config, gh: sandboxGh, log })
  expect((await fetchPR(feat.number)).labels).toContain('flywheel:needs-review')
})

it('flips needs-review to auto-merge after retitle from feat: to fix:', async () => {
  const pr = await createTestPR({ title: 'feat: new widget', branch: 'test/retitle' })
  await runPrFlow({ pr: await fetchPR(pr.number), config, gh: sandboxGh, log })
  expect((await fetchPR(pr.number)).labels).toContain('flywheel:needs-review')

  await sandboxGh.updatePR(pr.number, { title: 'fix: actually a fix' })
  await runPrFlow({ pr: await fetchPR(pr.number), config, gh: sandboxGh, log })
  const after = await fetchPR(pr.number)
  expect(after.labels).toContain('flywheel:auto-merge')
  expect(after.labels).not.toContain('flywheel:needs-review')
})
```

#### Native auto-merge enablement

```typescript
it('enables native auto-merge on the PR object for an eligible fix', async () => {
  const pr = await createTestPR({ title: 'fix: small fix', branch: 'test/auto-merge-enable' })
  await runPrFlow({ pr: await fetchPR(pr.number), config, gh: sandboxGh, log })

  // Fetch via REST to get the auto_merge field (not exposed in our PullRequest type).
  const raw = await octokit.rest.pulls.get({ owner, repo, pull_number: pr.number })
  expect(raw.data.auto_merge).not.toBeNull()
})
```

#### Promotion PR creation and upsert

```typescript
it('upserts a promotion PR rather than creating duplicates', async () => {
  // Sandbox seeds: integration-test-base has a paired source branch with a fix commit.
  await runPromotion({ branchRef: 'integration-test-base-source', config, gh: sandboxGh, log })
  const [first] = await sandboxGh.listOpenPRs({
    head: 'integration-test-base-source',
    base: 'integration-test-base',
  })

  // A second commit lands on source.
  await pushTestCommit('integration-test-base-source', 'feat: new feature')
  await runPromotion({ branchRef: 'integration-test-base-source', config, gh: sandboxGh, log })

  const [second] = await sandboxGh.listOpenPRs({
    head: 'integration-test-base-source',
    base: 'integration-test-base',
  })
  expect(second.number).toBe(first.number)         // same PR
  expect(second.title).toMatch(/^feat/)             // most-impactful type updated
})
```

### CI wiring

`.github/workflows/integration.yml` mints an installation token from the
`flywheel-build-e2e` App via `actions/create-github-app-token`, exports it
as `SANDBOX_GH_TOKEN`, and runs `npm run test:integration` on PR open/sync
and on push to `develop`/`main`. The job is gated on same-repo PRs (App
secrets are not exposed to fork PRs). After the suite is observed stable
for ~1 week, the job becomes a required check for merging to `develop`.

---

## Layer 3 — End-to-end tests

Drives the full Actions event chain on `point-source/flywheel-sandbox`. Each
scenario opens a real PR, merges it (or pushes a real commit), then polls the
sandbox until the published action workflow has labeled, auto-merged, opened
a promotion PR, or cut a tag. Slow (30–120s per scenario); runs only on push
to `develop` (post-merge).

### Sandbox-side prerequisite

The sandbox repo carries its own `flywheel-pr.yml` and `flywheel-push.yml`
workflows pinned to `point-source/flywheel@develop`. Provisioning is in
[`docs/sandbox-setup.md`](docs/sandbox-setup.md#layer-3-workflow-installation).
Because Layer 3 pins to `@develop`, it validates code already merged to
develop — feature-branch changes ride on Layer 2 confidence.

### Tooling

Vitest, no parallelism (`vitest.e2e.config.ts` enforces `fileParallelism: false`,
180s `testTimeout`). Auth: same `SANDBOX_GH_TOKEN` env var as Layer 2 (CI mints
it from the `flywheel-build-e2e` GitHub App). `npm run test:e2e` runs the
suite. Tests skip when the env var is missing.

### Layout

```
tests/e2e/
  helpers/
    poll-until.ts        # generic polling assertion (signature below)
    sandbox-e2e.ts       # pushCommit, mergePR, getRefSha, listTagsMatching,
                         # deleteTag, getCheckRuns, getPRMergeState, getRepoFile
    run-baseline.ts      # snapshotRunIds + waitForRunAfter — filters stale
                         # workflow runs by id > baseline so long-lived branches
                         # don't surface unrelated prior runs
    tag-cleanup.ts       # snapshotTags + cleanupNewTags for semantic-release output
  scenarios/
    01-fix-auto-merges.test.ts
    02-feat-needs-review.test.ts
    03-breaking-fix-needs-review.test.ts
    04-invalid-title-blocks-merge.test.ts
    05-promotion-pr-created-on-merge.test.ts
    06-chore-no-promotion.test.ts
    07-promotion-pr-accumulates.test.ts
    08-multi-stream-tag-isolation.test.ts
    09-tag-format-from-live-config.test.ts
```

Polling helper signature:

```typescript
export async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (result: T) => boolean,
  options?: { intervalMs?: number; timeoutMs?: number; description?: string },
): Promise<T>
```

Defaults: `intervalMs=3000`, `timeoutMs=90_000`. On timeout, throws an Error
including the `description` and the last value in JSON.

### Test isolation

Each test creates a uniquely-named feature branch (`e2e/<scenario>-<unix-millis>`)
off the relevant long-lived branch. Long-lived branches accumulate state
across runs by design — tests assert on **shape** (label present, tag prefix
matches, PR base/head correct), not on specific version numbers. `afterEach`
closes test PRs and deletes test branches via `tests/integration/helpers/teardown.ts`;
tag-creating scenarios snapshot the tag set in `beforeEach` and delete any
new tags in `afterEach`.

Workflow-run polling uses a baseline-id filter (`run-baseline.ts`) — without
it, tests that wait for `flywheel-push.yml` to fire on a long-lived branch
would surface stale runs from prior tests and false-pass. Source of this
pattern: pre-reset commit `238aca0`.

### Scenario 09 — pragmatic deviation

The original roadmap listed `09-semantic-release-dry-run.test.ts` with the
note "tag created in expected format" — self-contradictory (a dry-run does
not create). The shipped `09-tag-format-from-live-config.test.ts` instead
loads the live sandbox `.flywheel.yml` and exercises `chooseTagFormat`
directly for each stream, asserting that `main-line → v${version}`,
`customer-acme → customer-acme/v${version}`, `integration → integration/v${version}`.
This catches the only thing the dry-run could have caught (cross-stream tag
collision) without mutating the sandbox or shelling out to `npx`.

### Scenario design notes (lessons from initial Layer 3 stabilization)

#### Scenario 05/07 — push-workflow batching

The `flywheel-push.yml` workflow uses a per-branch concurrency group
(`group: flywheel-push-${{ github.ref_name }}`). When two PRs merge to
e2e-develop back-to-back, the first run can batch both commits into a
single promotion PR; the second run then correctly logs "no pending
commits". An assertion of "a *new* promotion PR appears for *my* merge"
will read that as failure, even though the product is doing the right
thing.

Scenario 05 verifies the actual product invariant: after the merge, a
develop→staging promotion PR exists whose `updated_at` is at-or-after
our merge time, in any state (open, merged, closed). Whichever push run
carried the commit, the promotion happened.

Scenario 07 verifies upsert by retargeting to staging→main: e2e-main
has `auto_merge: []`, so the first promotion PR stays open between the
two merges and the upsert is observable. (On develop→staging, fix-titled
promotion PRs auto-merge before the second push run can update them.)

#### Scenario 06 — chore-only invariant under shared state

Scenario 06 originally asserted "no new staging→main promotion PR
exists after a chore merge". In a shared sandbox, prior scenarios can
leave fixes pending on staging — the chore push run correctly opens a
promotion PR carrying those fixes, which read as failure. The shipped
test instead verifies the real invariant: any new promotion PR must
contain at least one bumping commit (i.e., the chore alone never
triggered it).

### Direct-merge fallback in `runPrFlow`

A separate concern from test design: native auto-merge can refuse with
"Pull request is in clean status" when the target branch has no required
checks. Rather than the e2e harness papering over this, `runPrFlow` itself
falls through to a direct REST `pulls.merge` (see "Auto-merge →
direct-merge fallback" above). Adopters without required checks get the
auto-merge UX automatically.

---

## Flywheel dogfooding

The repo runs Flywheel on itself. Its `.flywheel.yml` is single-branch
(`main` only) with `feat!` and `fix!` constrained to human review (so major
bumps gate manually). This is the most valuable integration test we have:
every change to `pr-conductor` flows through the same pipeline it implements.
`tests/dogfood-config.test.ts` validates this config in the unit suite so a
broken `.flywheel.yml` fails CI before it reaches an actual run.

---

## CI pipeline

| Trigger | Tests that run |
|---|---|
| File save (local) | Unit tests in watch mode |
| PR open / synchronize | `verify-dist` (typecheck + unit + dist drift) + `integration-tests` |
| Push to `develop` | All of the above + `e2e-tests` |
| Push to `main` | All of the above + semantic-release |

Integration and E2E jobs are skipped on PRs from forks (no sandbox App-token
access). Maintainers re-run them via `workflow_dispatch` after review. The
e2e job runs `scripts/doctor.sh` against the sandbox as a pre-flight so
configuration drift (missing branches, secret expiry, ruleset removal) fails
fast with a clear diagnostic instead of timing out scenario-by-scenario.

---

## Open questions / deferred

- **Merge queue E2E testing:** Verifying merge queue serialization across
  several simultaneous PRs is feasible but adds significant time and
  complexity to the E2E suite. Deferred until the core scenarios are stable.
- **`semantic-release` `EINVALIDNEXTVERSION`:** Constructing a git history
  that produces conflicting versions across streams is awkward to set up
  reliably. Covered today by `release-rc.test.ts` at the unit level
  (tag-format collision rejected at config-load time); deferred at E2E.
