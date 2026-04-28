# Flywheel — testing strategy

## Overview

Flywheel has three testing layers. Layer 1 (unit) is implemented and is where
the bulk of decision logic is verified. Layer 2 (integration) is being
introduced now to exercise `pr-conductor` against the real GitHub API on a
dedicated sandbox repo. Layer 3 (end-to-end) is deferred — its scenarios are
preserved below as a roadmap.

| Layer | What it tests | Speed | Status | Runs on |
|---|---|---|---|---|
| Unit | Pure logic, no I/O | Milliseconds | **Implemented** | Every file save; required check on PR / push |
| Integration | `pr-conductor` against real GitHub API | Seconds | **In progress** | PR open/sync; push to `develop` (skipped on forks) |
| End-to-end | Full Actions event chain on sandbox | Minutes | **Deferred** | (planned) merge to `develop` |

Sandbox repo (`point-source/flywheel-sandbox`) provisioning is documented in
[`docs/sandbox-setup.md`](docs/sandbox-setup.md). Layer 2 tests require it.

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
| `tests/conventional.test.ts` | 56 | `parseTitle`, `detectBreakingInBody`, `computeIncrement`, combinatorial `mostImpactfulType` precedence (the bulk are `it.each`-generated pairwise precedence cases) |
| `tests/config.test.ts` | 11 | All 6 `.flywheel.yml` validation rules; multi-error collection; malformed YAML; missing top-level mapping; `merge_strategy: merge` rejection |
| `tests/dogfood-config.test.ts` | 3 | Validates the repo's own `.flywheel.yml`; asserts `feat!` is excluded from `main`'s `auto_merge` |
| `tests/release-rc.test.ts` | 8 | `.releaserc.json` shape; `chooseTagFormat` primary-vs-secondary; plugin merging without dropping defaults; declaration order |
| `tests/pr-flow.test.ts` | 8 | PR title/body rewrite; label application; both label-flip directions; GraphQL refusal fallback; idempotency; unmanaged base ref; invalid-title check |
| `tests/promotion.test.ts` | 12 | Promotion PR create/upsert; `computePendingCommits` squash-merge dedup; rebase-merge dedup; `(#NN)` suffix stripping; terminal/single-branch no-op |
| `tests/push-flow.test.ts` | 3 | `.releaserc.json` write to workspace; managed-vs-unmanaged branch routing |

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

#### GraphQL `enableAutoMerge` refusal fallback

`tests/pr-flow.test.ts:129-145`. The `enableAutoMerge` GraphQL mutation can
fail (repo doesn't have auto-merge enabled, branch protection misconfigured,
etc.). The flow must log a warning and proceed — never throw — so the label is
still applied and the PR is queryable.

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
| Native auto-merge enablement + refusal fallback | ✅ | `pr-flow.test.ts` |
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
  initial_version: 0.1.0
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

## Layer 3 — End-to-end tests (deferred)

**Status: not implemented.** This section is preserved as a roadmap. The
sandbox repo's `e2e-main`, `e2e-staging`, `e2e-develop`, and
`e2e-customer-acme` branches are pre-positioned so this layer can be added
later without re-provisioning.

E2E tests would push real commits, open real PRs, and poll GitHub state until
the workflow chain reaches the expected end state. Slow (30–90s per scenario);
intended to run only on merge to `develop`.

### Planned scenarios

```
tests/e2e/
  scenarios/
    01-fix-auto-merges.test.ts                   # fix PR labeled and merged
    02-feat-needs-review.test.ts                 # feat PR labeled needs-review, no auto_merge
    03-breaking-fix-needs-review.test.ts
    04-invalid-title-blocks-merge.test.ts
    05-promotion-pr-created-on-merge.test.ts
    06-chore-no-promotion.test.ts
    07-promotion-pr-accumulates.test.ts
    08-multi-stream-tag-isolation.test.ts        # main-line v${version} vs customer-acme/v${version}
    09-semantic-release-dry-run.test.ts          # tag created in expected format
  helpers/
    poll-until.ts                                # generic polling assertion
    sandbox.ts                                   # branch/PR ops
```

The polling helper signature:

```typescript
export async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (result: T) => boolean,
  options = { intervalMs: 3000, timeoutMs: 90000 }
): Promise<T>
```

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
| Merge to `develop` | All of the above + (planned) E2E suite |
| Merge to `main` | All of the above + semantic-release |

Integration and (future) E2E jobs are skipped on PRs from forks (no sandbox
App-token access). Maintainers re-run them via `workflow_dispatch` after review.

---

## Open questions / deferred

- **Merge queue E2E testing:** Verifying merge queue serialization across
  several simultaneous PRs is feasible but adds significant time and
  complexity to the E2E suite. Deferred until the core scenarios are stable.
- **`semantic-release` `EINVALIDNEXTVERSION`:** Constructing a git history
  that produces conflicting versions across streams is awkward to set up
  reliably. Covered today by `release-rc.test.ts` at the unit level
  (tag-format collision rejected at config-load time); deferred at E2E.
