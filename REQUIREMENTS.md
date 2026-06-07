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
