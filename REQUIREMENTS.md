# flywheel — Requirements

<!-- Problem-space document. Each ## section carries a `§req:` slug suffix. -->
<!-- Run /symphonize:discover to populate through a structured interview. -->
<!-- This document covers three independent problem areas: -->
<!--   - Immutable-release support (§req:problem-statement and the standard -->
<!--     section slugs below) -->
<!--   - Sandbox CI sustainability and release safety -->
<!--     (§req:sandbox-ci-budget, §req:release-safety-gate, and the `§req:ci-*` -->
<!--     and `§req:*-criteria` slugs that follow) -->
<!--   - Release CI budget — CI minutes wasted on duplicate fan-outs from -->
<!--     bot-authored release and back-merge commits -->
<!--     (§req:release-ci-budget, §req:release-ci-budget-criteria, with -->
<!--     additions threaded into the shared `§req:ci-*` sections) -->
<!--   - Workflow run names — runs indistinguishable in the Actions list when -->
<!--     many workflows fire on one commit -->
<!--     (§req:workflow-run-names, §req:workflow-run-names-criteria) -->
<!--   - Composite action resolution — the v2 composite's nested `./core` -->
<!--     dispatcher resolves against the adopter's workspace, not the action's -->
<!--     own checkout, so every external adopter fails -->
<!--     (§req:composite-action-path, §req:composite-action-path-criteria) -->
<!--   - setup-node v5 upgrade — every actions/setup-node pin is on the stale -->
<!--     @v4 major; bump them uniformly to @v5 -->
<!--     (§req:setup-node-v5, §req:setup-node-v5-criteria, -->
<!--     §req:setup-node-v5-stories, §req:setup-node-v5-constraints) -->
<!--   - init.sh credentials prompt — the "where should credentials live?" -->
<!--     prompt never says what "credentials" are and asks redundantly when -->
<!--     they already exist (#235) -->
<!--     (§req:init-credentials-prompt, §req:init-credentials-prompt-criteria, -->
<!--     §req:init-credentials-prompt-stories, -->
<!--     §req:init-credentials-prompt-constraints) -->

## Problem statement §req:problem-statement

GitHub's **immutable releases** became generally available in October 2025.
When a repository or organization enables it, a release's git tag and
attached assets are frozen the instant the release is published — they can
no longer be added, modified, or deleted — and an attestation is generated
as a supply-chain record.

flywheel creates *and publishes* a GitHub Release in one atomic step: a push
to a release branch runs `semantic-release`, whose `@semantic-release/github`
plugin creates the tag and publishes the release together. The
`release: published` event that this fires is also what triggers an
adopter's *separate* build workflow. An adopter whose build attaches a
compiled artifact to the release therefore uploads it **after** the release
is already published — exactly the operation immutable releases reject. The
adopter's release pipeline breaks the moment they, or an org-wide security
policy, turn immutable releases on.

No adopter is blocked today — this is anticipatory. The feature is GA,
adoption is expected, and flywheel should be ready before an adopter enables
it and discovers their build can no longer attach its artifact. The only
workaround GitHub documents is **draft → attach → publish**: create the
release unpublished, attach assets while it is still a mutable draft, then
publish. flywheel's single-step publish leaves no window for that.

flywheel also cannot solve this by detection. Whether an adopter's build
attaches an artifact is decided in a build workflow that lives in the
adopter's repository and that flywheel never reads — flywheel runs as an
action and has no visibility into a sibling workflow. The behavior shall be
*declared*, not inferred.

An adopter's release branches do not all attach artifacts: a repo may
publish a binary on `main` but attach nothing to its `develop` prereleases,
or attach a snapshot to `develop` and a different artifact (or none) to
`main`. A repo-wide opt-in would force every release branch into the draft
flow, even branches whose releases carry no artifacts — and once a release
is a draft, GitHub stops firing `release: published` for it, so the adopter
shall add and maintain a publish-trigger workflow for branches that would
otherwise need none. The scope of the opt-in shall match the scope at which
the decision actually varies, which is per release branch.

Separately, flywheel's own releases on `point-source/flywheel` should be
publishable as immutable releases, so flywheel dogfoods the supply-chain
guarantee it expects adopters to depend on.

## Success criteria §req:success-criteria

- An adopter with immutable releases enabled, who has opted in *on the
  branches whose releases attach artifacts*, can complete a release
  end-to-end on those branches: the artifact is attached and the release is
  published as an immutable release, with no failed upload step.
- On the **same repository**, branches that did **not** opt in continue to
  publish immediately, on the same event and timing as before — the
  adopter does not need a publish-trigger workflow for those branches.
- An adopter who has not opted in on any branch observes no change
  whatsoever — every release publishes immediately, exactly as before.
- flywheel's own releases on `point-source/flywheel` publish successfully
  with immutable releases enabled on that repository.
- Multiple releases cut in quick succession, while earlier ones are still
  unpublished drafts, each receive the correct next version — concurrent
  unpublished drafts never corrupt version computation. This holds whether
  the concurrent releases come from one branch or from a mix of draft and
  immediate-publish branches. (semantic-release derives the next version
  from git tags, not from release objects; the tag shall still be created
  and pushed on every run even when the release object is left unpublished.)
- The behavior is selected by an explicit per-branch setting visible in
  flywheel's configuration alongside the branch's other release attributes —
  never inferred from the presence of assets or from whether immutability is
  enabled.

## User stories §req:user-stories

- As an adopter under a security policy that mandates immutable releases, I
  want flywheel to create my releases unpublished so my build workflow can
  attach its compiled artifact and then publish, so my release pipeline keeps
  working after immutability is turned on.
- As an adopter who attaches no artifacts, I want releases to keep publishing
  immediately, so enabling immutability elsewhere never changes or slows my
  release.
- As an adopter whose `main` releases attach an artifact but whose `develop`
  prereleases do not, I want to opt `main` into the draft flow without
  pulling `develop` into it, so I only write and maintain a publish-trigger
  workflow for the branch that actually needs one.
- As an adopter who attaches a snapshot to `develop` prereleases and a
  different artifact to `main`, I want both branches independently opted in
  to the draft flow, so each branch's build can attach its own asset.
- As an adopter, I want to turn this on per release branch with an explicit
  setting that sits alongside the branch's other release attributes, so the
  release behavior is obvious to anyone reading the repo's flywheel
  configuration and not hidden behind detection logic.
- As an adopter whose build attaches an artifact, I want a clear handoff —
  flywheel creates the unpublished release, my build attaches the artifact
  and performs the publish — so ownership of each step is unambiguous.
- As an adopter merging several changes in quick succession, I want each
  release to compute the correct version even though earlier releases are
  still unpublished drafts, so a burst of merges never produces duplicate or
  skipped versions.
- As a flywheel maintainer, I want flywheel's own releases to be immutable,
  so flywheel demonstrates the supply-chain guarantee it offers adopters.

## Quality attributes §req:quality-attributes

- **Backward compatibility.** Adopters who do not opt in are entirely
  unaffected — same trigger event, same timing, same published-immediately
  behavior.
- **Minimum-necessary scope.** Opting in a branch into the draft flow
  imposes new build-side responsibilities on that branch (a publish-trigger
  workflow, a publish-as-final-step). Opting in branches that do not need
  this imposes work the adopter does not benefit from. The configuration
  surface shall let an adopter scope the opt-in to exactly the branches that
  attach artifacts, and no more.
- **Statelessness preserved.** flywheel does not track or wait on a release
  after creating it unpublished. Creating the unpublished release is the end
  of flywheel's involvement; the adopter's build owns attaching the artifact
  and performing the publish.
- **Correctness under concurrency.** Version computation depends only on git
  tags, so overlapping unpublished draft releases are safe.
- **Supply-chain integrity.** A published immutable release shall still carry
  the attestation GitHub generates; flywheel shall do nothing that prevents it.
- **No new privilege.** Supporting this requires no additional GitHub App
  scopes or permissions beyond what flywheel already holds.

## Constraints §req:constraints

- The opt-in is **per release branch**, set alongside that branch's other
  release attributes in `.flywheel.yml`. GitHub's immutable-releases setting
  is a repository/organization-level control over whether a *published*
  release's tag and assets are frozen; flywheel's opt-in is a separate
  decision about *who performs the publish step*, and the natural scope at
  which that decision varies is the release branch. The two settings are
  orthogonal: any combination of repo-wide immutability and per-branch draft
  produces a coherent, GitHub-honorable release shape.
- The opt-in is valid on any branch that produces a release — both
  `release: prerelease` and `release: production` branches — because
  adopters legitimately attach artifacts to prereleases (snapshots,
  nightlies) as well as productions.
- flywheel cannot inspect an adopter's build workflow. Whether a build
  attaches an artifact is unknowable to flywheel and shall be declared
  explicitly in flywheel's configuration, never detected or inferred.
- GitHub immutable releases freeze a release's tag and assets at publish
  time; any artifact shall be attached while the release is still an
  unpublished draft.
- The `release: published` event does not fire for unpublished releases. An
  adopter's build that shall attach an artifact triggers on release creation
  instead, and performs the publish itself as its final step.
- flywheel's release path runs on `semantic-release`; whatever delivers the
  unpublished-release behavior shall work within that pipeline and shall not
  disturb tag creation, on which version computation depends.

## Priorities §req:priorities

Required, in decreasing order of user impact:

1. The explicit per-branch opt-in and the unpublished-release flow for
   adopters who attach release artifacts. This is the failure that breaks an
   adopter's pipeline the day they enable immutable releases, and the
   per-branch scope is what keeps the fix from forcing a publish-trigger
   workflow onto branches that don't need one.
2. No change for branches that have not opted in — neither for adopters who
   have opted in elsewhere in the same repo, nor for adopters who have not
   opted in at all.
3. Correct version computation when concurrent unpublished drafts coexist,
   including when drafts and immediate-publish releases coexist on the same
   repository.
4. flywheel publishing its own releases as immutable. flywheel attaches no
   release assets, so this needs only the immediate-publish path confirmed
   immutable-safe plus the repository setting enabled — far smaller than the
   adopter-facing feature, but it is how flywheel dogfoods the guarantee.

**Nice-to-have:**

- Updated adopter documentation and scaffolded templates showing the
  release-creation trigger and the publish-as-final-step pattern for builds
  that attach artifacts.

## Sandbox CI budget §req:sandbox-ci-budget

flywheel's CI exercises the real GitHub API against a single sandbox
repository (`point-source/flywheel-sandbox`). The integration suite (every
PR, every push to `develop` and `main`) and the e2e suite (every push to
`develop`) both mint installation tokens from one GitHub App
(`flywheel-build-e2e`) on one installation, so they share a single
~5000-requests/hour primary-rate-limit bucket on that installation.

The e2e suite is polling-heavy — by current estimate 300–500 API calls
per run versus ~40 for integration. On a `develop` merge both suites run
inside the same rate-limit window. Several times a week this exhausts
the bucket and one or both suites fail with primary rate-limit errors
that have nothing to do with the code under test.

The pain falls on flywheel maintainers, not adopters. The visible failure
modes are three: a maintainer learns to treat red CI as flake-not-signal
and merges anyway; a maintainer cannot promote `develop` because the same
suites gate the promotion; or a cancelled run leaves the sandbox in a
partial state that the existing presweep only partially cleans up.

## Release safety gate §req:release-safety-gate

flywheel is a runtime action: a broken release tagged at `@v1` is
consumed by every adopter pinned to that major on their next CI run.
There is no rollback for adopters pinned to a moving major; the only
recovery is to publish a corrective patch as fast as possible. A broken
release reaching `main` is the worst failure flywheel can produce.

Today the protection against that failure is incidental. e2e runs on
every push to `develop`, and `develop` is the source of releases — so
most release SHAs have happened to be e2e-tested. But nothing in the
release pipeline *verifies* that. The release fires on the next valid
`develop → main` promotion regardless of e2e's color on the SHA being
released.

The implicit gate fails whenever §req:sandbox-ci-budget bites: a
maintainer who merges to `develop` with red e2e (treating it as flake)
has produced a release-eligible SHA that was never confirmed green. The
two problems are independent failure modes that the same per-push e2e
cadence has so far masked from each other.

The gate has two halves — block a red release, publish a green one — and
only the block half is verified. The publish-on-green half has been
failing silently in production: flywheel creates each production release
as an unpublished draft and relies on a publish step to flip it public
once e2e is green, but that step never locates the draft, errors, and
exits without publishing. Every production release since the draft
mechanism arrived at v1.4.0 (v1.4.0, v1.5.0, v1.6.0) is stranded as an
unpublished draft; nothing has reached adopters since v1.3.0. To an
adopter a green gate that never publishes is indistinguishable from no
release — a moving `@vN` never advances, an exact pin never appears — and
because the drafts pile up with no error surfaced, the gap is found only
when adopters are noticed to be versions behind. The outcome needed is
the full round trip: a release that passes e2e reliably becomes a
published release adopters receive, and a draft stays unpublished only
when it legitimately failed verification (a red e2e run, or no release on
the tag). Restoring the already-stranded v1.4.0–v1.6.0 drafts is out of
scope; this governs releases going forward.

Fixing the draft lookup exposed a second failure in the same publish
path. The publish step carries an optional retargeting defense — a green
release shall not be published if its tag was moved to a different commit
between the e2e run and the publish — and that defense rejects every
release it is asked to protect. It compares the value the release records
as its target against the e2e-tested commit, but the recorded target is
the name of the branch the release was cut from, never a commit
identifier; a branch name can never equal a commit, so the check fails
for every legitimate green release. The defense is still wanted — a tag
moved off the tested commit shall still be caught — but it shall establish
that the tag being published resolves to the exact e2e-tested commit
without assuming the release records its target as a commit identifier.
The failure stayed invisible because the publish path's automated check
fed it a target shaped like a commit, the one shape a real release never
produces; the check exercised a case that cannot occur in production
while the case that always occurs went untested.

## Release CI budget §req:release-ci-budget

Every flywheel release produces three pushes in rapid succession on the
managed branches: the human merge from the prerelease branch into the
release branch, the `chore(release):` commit that semantic-release
pushes onto the release branch, and the back-merge of that release
commit into each upstream prerelease branch. Each push triggers the
adopter's full set of quality workflows — integration tests, build
verification, lint, type-check — because those workflows are gated on
`push: branches: [...]` by the adopter's own design.

The merge push is the one the workflows exist to verify; its result
decides whether the release commit gets created at all. The release
commit and back-merge commits, by contrast, are derived artifacts that
semantic-release produces from a SHA the merge push already certified
green. They touch only `CHANGELOG.md`, `package.json` version, and
(for back-merges) the equivalents replayed onto the upstream branch.
Re-running the same quality workflows against them cannot produce a
different verdict — the inputs the workflows test have not changed.

The cost is paid in two to three full CI fan-outs per release where one
was sufficient. On a flywheel adopter using GitHub-hosted runners, the
overhead is CI minutes that scale linearly with release cadence. On
adopters running more expensive suites — sandboxed integration harnesses,
paid e2e platforms, third-party API budgets — the overhead draws against
quotas that are bounded for reasons outside flywheel's control.

flywheel-push.yml acknowledges this in a comment block on the back-merge
step (lines 88–96): adopters who want to skip CI work on bot-produced
commits are directed to add job-level `if:` filters to their quality
workflows, which report the check as a successful no-op rather than
omitting it. Workflow-level `[skip ci]` or `paths-ignore` is rejected
in that comment because either would leave required checks `Pending` on
any tracking PR. The pattern exists as documented prose; it is not
offered as a primitive an adopter can drop in. Today's path is for each
adopter to read the comment, derive the identification logic themselves
(which authors, which commit-message patterns, which branch contexts to
match, how a back-merge commit differs from a release commit), and
hand-write the filter into every quality workflow they maintain.

`point-source/flywheel` is itself one such adopter and has not applied
the pattern to its own quality workflows. The 1.4.0 release produced
the expected duplicate runs on `integration.yml`, `verify-dist.yml`,
and `governance-lint.yml`, and the integration runs spent the doubled
budget against the sandbox installation that §req:sandbox-ci-budget
already constrains.

The user is the adopter who maintains the quality workflows: the
flywheel maintainer dogfooding the action, and any adopter who installs
flywheel and discovers their CI minutes per release are higher than
they need to be. The user is unblocked — every release still ships —
but is spending money on every release for a verification that cannot
change the outcome.

## Sandbox CI budget success criteria §req:sandbox-ci-budget-criteria

- A typical week of development on `point-source/flywheel` produces zero
  rate-limit-induced failures on the sandbox installation.
- Documentation-only PRs (no `src/` or workflow changes) consume zero
  API requests against the sandbox installation while still reporting
  every required check as a successful result.
- A failing or rate-limited e2e run does not block an unrelated PR's
  integration check from running during the same rate-limit window.
- Per-scenario polling cost is bounded and configurable in one place, so
  a maintainer can reason about per-run API cost from a single file.

## Release safety gate success criteria §req:release-safety-gate-criteria

- No release publishes to `main` and no `@vN` tag advances without a
  green e2e run against the exact SHA being released.
- If e2e is red on a candidate, the release is blocked. The candidate is
  either superseded by a subsequent green push or remediated explicitly
  by the maintainer — flywheel does not retry, auto-publish, or paper
  over a failure.
- The gate is observable: a maintainer reading the repository can
  identify the candidate, the check that shall pass, and the publish step
  that a green result unlocks.
- Adopters pinned to `@v1` observe no behavior change for green releases
  (same trigger, same timing) and no new opt-in is required to consume
  flywheel after the gate ships.
- A green-gated release is published and visible to adopters on the same
  run that turned green — the draft-to-public transition completes on
  every green gate, not incidentally. A draft stays unpublished only for a
  legitimate reason: a red e2e run, or no release attached to the tag.
- When the publish step cannot complete, it fails loudly enough that a
  maintainer reading CI can tell a green release did not reach adopters,
  rather than discovering stranded drafts versions later.
- The publish path is exercised against the behavior a real release
  produces, so a regression that would strand releases is caught before
  it ships rather than in production.
- The retargeting defense never rejects a legitimate green release. A
  release whose tag still points at the e2e-tested commit publishes; the
  defense blocks only a release whose tag has been moved to a different
  commit since e2e ran. The defense does not depend on the release
  recording its target as a commit identifier.
- The publish path's automated verification covers the target shape a
  real release produces — a branch name, not a commit identifier — so a
  guard that would reject every real release cannot pass review again.
  This verification stays in the fast local test suite and adds no load
  to the e2e suite.

## Release CI budget success criteria §req:release-ci-budget-criteria

- An adopter who has opted in observes one CI fan-out per release cycle
  on each of their quality workflows — the fan-out from the human merge
  that initiated the release — and zero further fan-outs from the
  bot-authored release commit or any back-merge commits semantic-release
  produces. The opt-in is per workflow and per job; an adopter can
  short-circuit integration but keep type-check running on every push if
  that is their preference.
- An adopter who has not opted in observes exactly today's behavior:
  every push triggers every quality workflow, no change in timing, no
  change in the set of check names that report.
- Every required check on every push (including the release and
  back-merge pushes) continues to report a result. A skipped run
  reports the check as a successful no-op; it does not omit the check.
  Tracking PRs that depend on the required-check rule clear instead of
  stalling on `Pending`.
- An adopter can adopt the opt-in without writing or maintaining
  commit-identification logic. flywheel exposes the identification as
  part of its action surface, sufficient on its own as a job-level
  `if:` clause; scaffolded templates are an ergonomic default for
  adopters who let `init` write their quality workflows.
- The identification is correct across the cases flywheel itself
  produces: the `chore(release):` commit pushed by semantic-release,
  the back-merge merge commit pushed into each upstream branch, and a
  push whose tip is simultaneously both (a back-merge whose head
  commit is itself a release on a multi-stream repo).
- `point-source/flywheel` dogfoods the mechanism: its own quality
  workflows opt in, and a subsequent v1.x.y release on this repository
  produces one fan-out per workflow rather than two or three.

## CI user stories §req:ci-user-stories

- As a flywheel maintainer making multiple PRs per week, I want CI to
  never fail for non-code reasons, so I do not learn to treat red CI as
  flake and lose the signal it gives me.
- As a flywheel maintainer cutting a release, I want a structural
  guarantee that the SHA being released passed e2e against a real
  GitHub repository, so I cannot accidentally ship a broken `@v1` to
  every adopter.
- As an adopter pinned to `@v1`, I want flywheel's release cadence and
  timing unchanged for green builds, so improvements to flywheel's
  internal verification never become my problem.
- As a flywheel adopter whose CI minutes or external-service quotas are
  finite, I want the release commit and back-merge commits flywheel
  itself produces to not re-run my quality workflows, so my CI cost per
  release is one fan-out — the same fan-out the human merge already
  paid for.
- As a flywheel adopter whose quality workflows are required checks on
  PRs, I want the opt-in for release/back-merge skipping to report the
  check as a successful no-op rather than omit it, so tracking PRs
  whose required-check rules expect that name continue to clear.
- As a flywheel adopter, I want to opt in without inventing my own
  rule for "is this a flywheel-produced commit," so a future change to
  flywheel's commit-authorship or commit-message format does not
  silently break my filter.
- As a flywheel maintainer, I want flywheel's own quality workflows to
  use the recommended pattern, so an adopter reading this repository
  sees a working example and each v1.x.y release does not double-spend
  the sandbox installation's already-constrained budget.

## CI quality attributes §req:ci-quality-attributes

- **Stateless gate.** Whatever holds a release back until e2e is green
  shall not require flywheel to hold state between runs. The repository's
  branches, tags, check runs, and release objects are the state machine,
  mirroring the principle applied to `release_as_draft`
  (§req:quality-attributes).
- **Adopter invisibility.** Adopters consuming `@v1` get no new opt-in,
  no new workflow template, and no change in release timing for green
  builds.
- **Single sandbox.** Provisioning additional sandbox repositories is
  out of scope. The rate-limit budget on the existing installation is
  fixed; mitigations shall work within it.
- **Parallel-agent safe.** This repository is routinely worked on by
  multiple agents in parallel. CI mitigations shall not introduce a
  single-writer bottleneck that serializes that work.
- **Workflow-author-controlled skipping.** The release/back-merge
  skip opt-in lives in the quality workflow the adopter maintains,
  not in flywheel's action invocation. flywheel exposes the
  identification primitive; the workflow author decides which jobs
  short-circuit. Adopters who want strict CI on every push, even
  on derived release commits, remain in that mode by default.

## CI constraints §req:ci-constraints

- The integration and e2e suites currently share one App installation on
  the sandbox. Splitting the installation is mechanically possible (the
  App can be installed twice, or a parallel App with identical scopes
  installed alongside) but expands the maintenance surface of the
  sandbox setup.
- Required-check rules on the repository expect specific named checks to
  report a result. Workflows that skip on doc-only changes shall continue
  to report the check name as a successful no-op, not omit it. The same
  constraint applies to any workflow that skips on flywheel-produced
  release or back-merge commits: skip at job level (reporting the check
  name with a successful conclusion), never at workflow level via
  `[skip ci]` or `paths-ignore`.
- semantic-release derives versions from git tags, not from check runs.
  Whatever gates a release on e2e shall not interrupt the
  tag-create-and-push step that version computation depends on.
- The identification of "this is a flywheel-produced release or
  back-merge commit" shall not require an adopter to mirror flywheel's
  internal authorship or message conventions in their own workflow.
  An adopter who pins to `@v1` and never reads flywheel's source shall
  still get a correct opt-in; the rule lives on flywheel's side of the
  interface.

## CI priorities §req:ci-priorities

Required, in decreasing order of user impact:

1. The release safety gate (§req:release-safety-gate). A broken `@v1`
   release is the worst failure flywheel can produce, and the implicit
   gate is no longer reliable while the budget problem persists.
2. Cheap, reversible mitigations to the budget problem
   (§req:sandbox-ci-budget) — polling tuning, path-gating doc-only PRs —
   that reduce per-run API cost without changing release semantics.
3. The release CI budget opt-in (§req:release-ci-budget) — the action
   primitive plus dogfood application on `point-source/flywheel`. Lower
   priority than the safety gate (broken `@v1` is worse than wasteful
   minutes) and the rate-limit mitigations (red CI poisons the safety
   gate's signal), but the user-impact case is direct: every adopter
   pays the cost on every release, and the documented workaround
   requires per-adopter implementation effort that today's adopters do
   not undertake.
4. Structural separation of the integration and e2e installations on
   the same sandbox, if 1 and 2 prove insufficient.

**Nice-to-have:** Per-run API-call counter visible in CI logs so drift
in per-scenario cost surfaces before it exhausts the bucket.

## Workflow run names §req:workflow-run-names

When several workflows are triggered by the same commit, every run in the
GitHub Actions list shows the same title — the raw commit message — because
none of flywheel's workflow files set a run name and GitHub's fallback is
the triggering commit's message. This is routine on `develop` and `main`,
where a single release-bot commit such as `chore(release): 1.5.0` fans out
to all of flywheel's top-level workflows at once. The list then reads as
eight identical rows:

```text
chore(release): 1.5.0   develop   8 minutes ago
chore(release): 1.5.0   develop   8 minutes ago
chore(release): 1.5.0   develop   8 minutes ago
...
```

The rows are not duplicates — they are distinct workflows (Governance Lint,
Verify dist, Integration tests, Flywheel — Push, Release gate, and the
rest) — but nothing in the title distinguishes them. A reader who wants to
find one workflow's run, or see at a glance whether a particular workflow
passed, has to read across to the workflow column or open each run's detail
page.

The user is the flywheel maintainer — and any adopter — reading the Actions
list. The pain is frequent (every release, and any commit that triggers
more than one workflow) but low-severity: the information is reachable, just
one or more clicks away. Nobody is blocked. It is recurring developer-
experience friction that taxes the maintainer every time they scan CI,
which on this repository is many times a day across parallel agent work.

GitHub provides exactly one lever for this: the
[`run-name`](https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions#run-name)
field on a workflow. Absent it, the commit-message fallback is the only
behaviour available, so the rows stay identical. The fix is to give each
workflow a run name led by the workflow's own human-readable name.

## Workflow run name success criteria §req:workflow-run-names-criteria

- For a commit that triggers several workflows (e.g. a `chore(release):`
  push on `develop`), the Actions list shows a distinct, readable title for
  each run, and each title begins with that workflow's human-readable name —
  a reader identifies which run is which without opening any run or reading
  across to the workflow column.
- Each run title still carries the triggering change's context — the commit
  message, or the pull-request title for PR-triggered runs — so a reader can
  tie a run back to the change that caused it. The minimal form is
  `<Workflow name> — <commit message or PR title>`.
- Every workflow file under `.github/workflows/` carries a run name,
  including the reusable `push.yml` and `pr.yml`. A reusable workflow
  invoked via `workflow_call` appears nested under its caller and does not
  produce its own row in the Actions list, so its run name is for source-
  level consistency — every workflow file follows the same convention — not
  for list disambiguation. This is a deliberate consistency choice, not an
  expectation that the reusable workflows gain separate list entries.
- The change is display-only: it alters no workflow's triggers, jobs,
  permissions, or reported check names. A commit that triggered a given set
  of workflows before triggers the same set after, with the same checks
  reporting — only the titles in the Actions list change.

## Workflow run name user stories §req:workflow-run-names-stories

- As a flywheel maintainer scanning the Actions list after a release-bot
  push, I want each workflow on that commit to show its own name, so I can
  tell Governance Lint from Verify dist from Integration tests without
  clicking into every run.
- As a maintainer triaging a failed run, I want the run title to name both
  the workflow and the change that triggered it, so I can find the right run
  in a list of otherwise-identical rows.
- As a flywheel maintainer or adopter reading the repository's workflow
  files, I want every workflow to set a run name in the same way, so the
  convention is obvious and a workflow added later follows it.

## Workflow run name quality attributes and constraints §req:workflow-run-names-constraints

- **Display-only.** The run name changes nothing about what a workflow does
  — same triggers, same jobs, same permissions, same check names. It only
  changes the title GitHub shows for a run.
- **Sensible title across trigger types.** flywheel's workflows fire on a
  mix of events — push, pull_request, release, schedule, workflow_dispatch.
  A run name shall resolve to a useful title for whichever event actually
  triggered a given run: a push has a head-commit message, a PR has a title,
  and some events carry neither, so the expression shall degrade gracefully
  rather than render blank or error. The exact expression per event type is
  a design decision for SPEC, not a requirement here.
- **Priority.** This is low-severity, high-frequency polish — a nice-to-have
  that is nonetheless cheap and self-contained. It does not block any
  release or adopter, and it should not be sequenced ahead of the CI-budget
  and release-safety work above.

## Composite action resolution §req:composite-action-path

flywheel ships as a single composite GitHub Action that an adopter consumes
with one line: `uses: point-source/flywheel@<ref>`. When that line runs,
GitHub fetches flywheel's repository at `<ref>` into the runner's action
cache (`/home/runner/work/_actions/point-source/flywheel/<ref>/`) and runs
the composite's steps. The composite's first step checks the *adopter's*
repository out into the runner's workspace (`GITHUB_WORKSPACE`); a later step
dispatches flywheel's own logic.

That dispatch step is written as `uses: ./core`, a local-action reference.
flywheel's source comments assert that inside a composite action `./core`
resolves against the action's own checkout — so the dispatcher would always
match the `scripts/` and semantic-release plugin set shipped at the same ref.
**That assertion is wrong.** GitHub resolves a `uses: ./…` reference inside a
composite against the *workspace*, not the action's checkout. By the time the
dispatch step runs, the workspace holds the adopter's repository, which
contains no `core/`. Every external adopter therefore fails immediately with:

```text
Can't find 'action.yml', 'action.yaml' or 'Dockerfile' under
'/home/runner/work/<adopter-repo>/<adopter-repo>/core'
```

This is new in the v2.0.0 composite form (#204); the pre-v2 action did not
have this shape. It is not a partial or rare failure — it breaks **all**
external adopters on the **first** dispatch step of **every** event, so the
entire v2 major is unusable to anyone outside flywheel's own repository until
it is fixed.

flywheel's own CI hid the defect two ways. The dogfood workflow invokes
flywheel as `uses: ./` (the whole repository as a local action); because
`actions/checkout` first lays flywheel's own source — including `core/` —
into the workspace, `./core` happens to resolve and the dogfood passes. Only
the e2e suite exercises the real adopter path: `sync-e2e-fixtures.mjs`
rewrites `uses: ./` to `uses: point-source/flywheel@<sha>` in the sandbox's
workflows, reproducing exactly how an adopter pins flywheel — and there
`./core` cannot be found. The v2.0.0 release gate's e2e run failed all ten
scenarios on this, and the gate correctly refused to publish v2.0.0. The
protection worked: no adopter received the broken major. But the defect
reached a built (if unpublished) release because the cheap, every-PR suites
never modelled an adopter consuming flywheel from the action cache rather
than from a workspace that already contains flywheel's source.

The users are two: the external adopter, for whom flywheel v2 simply does not
run; and the flywheel maintainer, who cannot ship a usable v2 and who learned
of the break only from the most expensive suite in the pipeline. The problem
is mandatory (an adopter cannot work around it — the action fails before any
of their configuration is read), universal across adopters, and self-
inflicted on a brand-new major. It is distinct from the
§req:release-safety-gate failures: there the gate's *publish* half was broken;
here the gate's *block* half worked exactly as designed and the defect is in
the action's own self-reference.

Whatever fixes the dispatch step shall not dissolve the reason `./core`
exists. flywheel deliberately keeps the dispatcher, the bundled `scripts/`,
and the semantic-release configuration on a single pinned ref so an adopter
pins one version and never reconciles a second
(§spec:action-version-lockstep). A fix that asked adopters to pin or check out
anything beyond `point-source/flywheel@<ref>` would trade one adoption
barrier for another.

## Composite action resolution success criteria §req:composite-action-path-criteria

- An external adopter who pins `point-source/flywheel@<ref>` and triggers
  flywheel on a `pull_request` or `push` event runs the dispatcher to
  completion — no "Can't find action.yml" error — regardless of what the
  adopter's repository contains. flywheel's own logic resolves from flywheel's
  checkout in the action cache, not from the adopter's workspace.
- An external adopter can complete a **full** managed release cycle on a
  release branch: dispatch, semantic-release, @-mention sanitization,
  merge-driver registration, and back-merge into upstream branches all run,
  each step locating flywheel's bundled assets from flywheel's own checkout.
  The fix is not done when only the dispatcher's first step is reachable —
  every step that references flywheel-shipped files works for an adopter,
  since several of those steps (sanitize, register-merge-drivers, back-merge)
  were only ever exercised by the dogfood, never against a real adopter.
- The single-ref guarantee is intact: an adopter still pins exactly one ref,
  and the dispatcher, `scripts/`, and semantic-release config all come from
  it. No adopter has to pin, check out, or track a second flywheel version
  (§spec:action-version-lockstep preserved).
- A test in the cheap suite — unit or per-PR CI, not the rate-limited e2e
  sandbox — fails when the composite is consumed the way an external adopter
  consumes it (flywheel resolved from an action checkout while the workspace
  does not contain flywheel's source) and passes once resolution is correct.
  This class of bug is caught before a release is built, not only by the e2e
  gate. The check adds no load to the sandbox installation the e2e suite
  already strains (§req:sandbox-ci-budget).
- The dogfood continues to work unchanged: flywheel's own `flywheel-push.yml`
  and the other workflows that invoke flywheel on this repository keep
  passing.
- Adopters pinned to a v1 ref are unaffected — this is purely the v2
  composite path.
- Scope is fix-forward: the requirement is met when the next release works
  end-to-end for an external adopter. The already-built, unpublished v2.0.0
  draft and its tag are left as they are; restoring or republishing that
  specific artifact is out of scope, consistent with how
  §req:release-safety-gate treats already-stranded drafts.

## Composite action resolution user stories §req:composite-action-path-stories

- As an external adopter pinning `point-source/flywheel@v2`, I want the action
  to run instead of failing on "Can't find action.yml," so I can actually
  adopt the current major.
- As an adopter whose release branch runs the full flywheel flow, I want
  semantic-release, mention-sanitization, merge-driver registration, and
  back-merge to complete and not fail later for the same self-reference reason
  the dispatcher did, so a release I start finishes.
- As an adopter, I want to keep pinning a single `point-source/flywheel@<ref>`
  and nothing else, so adopting the fix does not introduce a second version
  for me to track.
- As a flywheel maintainer, I want a cheap test that catches "the action can't
  find its own files when consumed as an adopter consumes it," so I never ship
  a broken major again only to discover it from the expensive e2e gate — or
  from an adopter.
- As a flywheel maintainer, I want the dogfood and existing v1 adopters to
  keep working through the fix, so correcting v2 costs no regression
  elsewhere.

## Composite action resolution constraints and quality attributes §req:composite-action-path-constraints

- **Lockstep is mandatory; mechanism is open.** Preserving the single-ref /
  no-second-version-surface guarantee (§spec:action-version-lockstep) is a
  hard requirement. *How* the dispatcher is invoked — keeping a nested action,
  invoking the bundled JS directly via the action's own path, or another
  structure — is a design decision for /symphonize:plan, not a requirement
  here. Either way the adopter-visible contract is unchanged: one ref pins
  everything.
- **Work within GitHub's real resolution semantics.** The fix relies on how
  GitHub Actions actually resolves paths: `uses: ./…` inside a composite
  resolves against the workspace, whereas `${{ github.action_path }}` resolves
  against the action's own checkout on the runner. The source comments
  asserting that `./core` resolves against the action's checkout are incorrect
  and shall be corrected so the assumption is not reintroduced.
- **Backward compatible.** The dogfood path (`uses: ./` with flywheel's source
  in the workspace) and adopters pinned to v1 see no behavior change. Only the
  external-adopter v2 path changes — from failing to working.
- **No new privilege.** The fix requires no additional GitHub App scopes or
  permissions.
- **Statelessness preserved.** The fix changes only how flywheel locates its
  own bundled code; it holds no state between runs.
- **Cheap coverage only.** The regression test lives in the fast local/CI
  suite and shall not draw on the e2e sandbox's rate-limited installation
  (§req:sandbox-ci-budget). e2e remains a backstop, not the first line of
  defense for this class of bug.
- **Priority.** This is the gating defect for the entire v2 major: until it is
  fixed, no external adopter can run flywheel v2 at all. It outranks the
  lower-severity polish items in this document (e.g. §req:workflow-run-names)
  and is bounded and self-contained — a single action's self-reference plus a
  cheap regression test.

## setup-node v5 upgrade §req:setup-node-v5

Every `actions/setup-node` reference in the repository pins the `@v4` major,
a now-superseded version. `actions/setup-node@v5` is generally available, and
flywheel already keeps `actions/checkout` on the current major (`@v6`)
repo-wide — setup-node is the one action left a major behind. There are seven
references: the dispatcher Node-setup step in `action.yml` (added alongside the
composite-action work, §req:composite-action-path, and deliberately pinned to
`@v4` to keep that fix tightly scoped), four CI workflows (`integration.yml`,
`release-gate.yml`, `verify-dist.yml`, `e2e.yml`), the contributor note in
`CONTRIBUTING.md`, and the example workflow in `docs/adopter/setup.md` that
adopters copy verbatim.

The user is the flywheel maintainer carrying the upgrade, and — through the
adopter-facing example — the adopter starting a new project from flywheel's
documented workflow. Nobody is blocked and nothing breaks today: the cost is a
small, growing maintenance debt. A stale action major is what Dependabot and
security advisories eventually flag, and the copy-paste example in the adopter
docs currently seeds new adopters on an already-superseded version, contrary to
flywheel's intent that its documented recipes be the current, correct starting
point.

A `setup-node` major bump is its own dependency upgrade with its own potential
behavior changes — a different default Node version, deprecations, and cache
behavior. Folding it into the composite-path bug fix (§req:composite-action-path)
would have expanded that fix's blast radius across five files, so the bump was
deliberately deferred to this separate, reviewable change. The upgrade is
expected to be low-risk precisely because flywheel does not lean on the
behaviors v5 changes: every setup-node usage explicitly pins `node-version: 24`,
and none use the action's `cache` input — so v5's changed default Node version
and any cache-behavior change fall outside flywheel's blast radius. That
expectation is the thing to confirm rather than assume, which is why the bump is
done deliberately and verified, not waved through on the edit alone.

## setup-node v5 success criteria §req:setup-node-v5-criteria

- A repository-wide search for `setup-node@v4` returns nothing: all seven
  references — the `action.yml` dispatcher step, the four CI workflows, the
  `CONTRIBUTING.md` note, and the `docs/adopter/setup.md` example — name the
  `@v5` major.
- The new pins use the same major-float style as the rest of the repo
  (`@v5`, matching `actions/checkout@v6`), so a reader sees one consistent
  pinning convention rather than a mix of styles.
- Local CI is green under v5: typecheck, unit tests, and `verify-dist` all
  pass. `verify-dist` in particular confirms the committed `dist/` bundle still
  builds against node 24 after the bump.
- The integration suite passes under v5, confirming a bumped workflow still
  provisions node 24 and runs `npm ci` plus the suite exactly as before. (The
  heavier e2e run is not required for this change — per §req:sandbox-ci-budget
  it is reserved against the rate-limited sandbox installation.)
- The composite dispatcher still provisions node 24 under v5: the `action.yml`
  setup-node step continues to set the runtime the bundle targets (esbuild
  node24), so an external adopter running flywheel gets the same Node runtime
  as before the bump.
- No observable change for adopters consuming flywheel: the same `node-version`
  is pinned everywhere, with no reliance on v5's changed default Node version or
  cache defaults, so the upgrade is invisible to anyone who runs the action.
- The adopter-facing example in `docs/adopter/setup.md` — copied verbatim by new
  adopters — shows `@v5`, so a fresh project starts on the current major.

## setup-node v5 user stories §req:setup-node-v5-stories

- As a flywheel maintainer, I want every `setup-node` pin on the current `@v5`
  major, so the repo is not carrying a stale action version that Dependabot or
  a security advisory will eventually flag, and so all my workflows share one
  consistent pin.
- As a maintainer reviewing this change, I want it as its own deliberate PR —
  not folded into the composite-path fix (§req:composite-action-path) — so the
  bump's potential behavior changes (default Node version, cache, deprecations)
  get their own review and the bug fix stayed tightly scoped.
- As an adopter copying flywheel's documented example workflow, I want it to
  show the current `setup-node` major, so I do not start a new project on an
  already-superseded version.
- As an adopter consuming flywheel as an action, I want the dispatcher to keep
  provisioning node 24 exactly as before, so the upgrade changes nothing about
  how my releases run.

## setup-node v5 quality attributes and constraints §req:setup-node-v5-constraints

- **Uniformity.** All seven setup-node references move to `@v5` together; the
  repository does not end up with a mix of `@v4` and `@v5`.
- **Explicit Node version preserved.** Every usage keeps `node-version: "24"`
  set explicitly, so v5's change to the default Node version cannot alter which
  runtime is provisioned.
- **No caching dependence.** No setup-node usage relies on the `cache` input,
  so v5 cache-behavior changes are out of the blast radius. Adopting caching
  would be a separate decision, not part of this bump.
- **Maintenance-only for adopters.** The change alters no workflow's triggers,
  jobs, permissions, or reported check names; adopters consuming flywheel see
  identical release behavior.
- **Major-float pinning.** Follow the repo's existing convention (`@v5`), not a
  commit-SHA pin. SHA-hardening every action would be a separate, repo-wide
  supply-chain decision out of scope here.
- **Verify before merge, don't assume.** The reason for doing this deliberately
  is to catch any v5 behavior change, so the bump is not "done" on the edit
  alone — local CI plus the integration suite must be confirmed green under v5.
- **Priority.** Low-severity, self-contained maintenance. Nothing is blocked
  and nothing breaks today, so it should not be sequenced ahead of the
  CI-budget, release-safety, or composite-action-path work in this document.
  It is nonetheless cheap and removes a small, growing debt — a stale major
  that advisories will flag and that adopters currently see in copy-paste docs.

## init.sh credentials prompt §req:init-credentials-prompt

When an adopter runs `scripts/init.sh` to onboard a repository and the
owner is a GitHub organization, the script asks **"Where should the
credentials live?"** and offers a repo-only vs. org-wide choice. Two
groups of adopters are tripped up by it:

- **First-time adopters don't know what "credentials" means.** The word
  is never defined at the prompt. The thing being placed is the GitHub
  App's identity — the `FLYWHEEL_GH_APP_ID` (a repo/org **Variable**, the
  public numeric App ID) and the `FLYWHEEL_GH_APP_PRIVATE_KEY` (a
  **Secret**, the PEM private key). These are App-level credentials shared
  by the automation, not a personal access token or a per-user secret.
  Without that framing the adopter is asked to make a placement decision
  about something they can't name, and can't tell what will actually be
  written or where to look for it afterward (Settings → Secrets and
  variables → Actions).

- **Re-runners and second-repo onboarders are asked as if nothing
  exists.** `init.sh` already looks for the App ID and private key at both
  repo and org level, but it only skips the prompt when **both** are
  found. When exactly one is already present — e.g. the private key lives
  org-wide from onboarding a sibling repo but the App ID is missing here —
  the script still asks "where should the credentials live?" from a blank
  slate, giving no sign that half the answer already exists, and inviting
  a choice that splits the two values across different scopes.

The cost is onboarding friction at the single most consequential step of
setup: get the App credentials wrong or in the wrong scope and no Flywheel
workflow can mint a token, so nothing the adopter does afterward works.
The confusion is hit by every org adopter on their first run (frequent at
the moment of adoption) and again on every re-run or additional repo
(`init.sh` is explicitly re-runnable). The remedy is to make the prompt
**explicit about what the credentials are** and **honest about what
already exists** — the same clarity should hold across `init.sh`'s other
credential prompts and the adopter setup doc so the three never disagree.

## init.sh credentials prompt success criteria §req:init-credentials-prompt-criteria

Two independent, surface-observable outcomes:

- **Clarity for newcomers.** A first-time adopter reading the credentials
  prompt in their terminal can correctly state, without leaving the
  prompt, that the two things being set are the GitHub App's ID
  (`FLYWHEEL_GH_APP_ID`, stored as a Variable) and its private key
  (`FLYWHEEL_GH_APP_PRIVATE_KEY`, stored as a Secret), and where the
  chosen scope will store them. Verifiable by reading the prompt text on a
  fresh org-owned repo.
- **No redundant asks.** When either credential already exists at repo or
  org level, a re-run of `init.sh` states which credential is already set
  and where (repo vs. org), and the interactive flow only asks about what
  is actually missing rather than re-prompting from a blank slate.
  Verifiable by pre-setting one of the two values and re-running.

## init.sh credentials prompt user stories §req:init-credentials-prompt-stories

- As an adopter onboarding my first org repo, I want the prompt to tell me
  the two credentials are my GitHub App's ID and private key (and that
  they go in Actions Variables/Secrets), so I can confidently choose where
  they live and find them afterward — meets §req:init-credentials-prompt-criteria
  (clarity for newcomers).
- As an adopter onboarding a second repo into an org that already has the
  App private key set org-wide, I want `init.sh` to tell me that key is
  already present and only ask me for what's missing, so I don't
  accidentally create a second copy or split the App ID and key across
  different scopes — meets §req:init-credentials-prompt-criteria (no
  redundant asks).
- As an adopter re-running `init.sh` after a partial first attempt, I want
  the credential prompts and the adopter setup doc to describe the same
  two values the same way, so the terminal and the documentation never
  contradict each other about what I'm setting.

## init.sh credentials prompt constraints and quality attributes §req:init-credentials-prompt-constraints

- **Explicit over implicit.** The exact value is whether the adopter
  *confidently knows what the credentials are*, not whether the literal
  word "credentials" is used. The prompt must name the two values and what
  each is for; wording is otherwise free.
- **Consistent framing across surfaces.** The clarification extends beyond
  the single "where should they live?" prompt to `init.sh`'s other
  credential prompts (create / paste-existing / skip and the
  manual-setup instructions) and to `docs/adopter/setup.md`, so all of
  them agree on what the credentials are and where they're stored.
- **No extra CI/API cost.** Improving detection must not add notable
  GitHub API calls or slow the run; this repo is sensitive to CI/API
  budget (see §req:sandbox-ci-budget). Detection already probes repo and
  org level — the improvement reuses what is already known, it does not
  add new probing rounds.
- **Existing behavior preserved.** `--scope`, `--skip-secrets`, and
  non-interactive runs keep working exactly as today; only the interactive
  wording and the use of already-detected state improve. The change writes
  the same Variable/Secret names to the same scopes as before.

## init.sh credentials prompt priorities §req:init-credentials-prompt-priorities

Both success criteria are must-haves and were judged equally important —
the newcomer's confusion and the re-runner's redundant prompt are the two
halves of the same onboarding-friction problem. Naming the credentials
(clarity) is the cheaper, higher-confidence half and should land first;
surfacing partial pre-existing state (no redundant asks) is the
higher-impact half for org adopters running `init.sh` repeatedly. Doc
alignment is a must-have for consistency but rides along with the prompt
wording rather than gating it. This is self-contained onboarding polish:
nothing is blocked on it and no workflow breaks today, so it sits below
the release-safety and CI-budget work in this document on severity, but it
removes friction at adoption — the moment an adopter is most likely to
abandon setup.
