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
<!--   - Pre-flight environment detection — setup probes the environment and -->
<!--     repo up front, classifies each finding by bucket × severity, and shares -->
<!--     one vocabulary across init and doctor -->
<!--     (§req:preflight-detection, §req:preflight-detection-criteria, -->
<!--     §req:preflight-detection-stories, §req:preflight-detection-constraints) -->
<!--   - apply-rulesets PyYAML — the one-shot ruleset setup script aborts on a -->
<!--     missing PyYAML and prescribes a persistent user install for a script -->
<!--     run once; stale "preinstalled on macOS" comment -->
<!--     (§req:apply-rulesets-pyyaml, §req:apply-rulesets-pyyaml-criteria, -->
<!--     §req:apply-rulesets-pyyaml-stories, §req:apply-rulesets-pyyaml-constraints) -->
<!--   - apply-rulesets.sh stdin invocation — the documented `curl … | bash` -->
<!--     one-liner fails (exit 2) because the script can't resolve its bundled -->
<!--     ruleset templates when read from stdin -->
<!--     (§req:apply-rulesets-stdin, §req:apply-rulesets-stdin-criteria, -->
<!--     §req:apply-rulesets-stdin-stories, §req:apply-rulesets-stdin-constraints) -->
<!--   - Setup completion summary — setup ends with a static "Next steps" block -->
<!--     that ignores what the run actually did; replace it with an outcome -->
<!--     summary, a complete/incomplete verdict, and an auto-validation pass, -->
<!--     all in the pre-flight vocabulary (#242) -->
<!--     (§req:setup-completion-summary, §req:setup-completion-summary-criteria, -->
<!--     §req:setup-completion-summary-stories, §req:setup-completion-summary-constraints) -->

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

## Pre-flight environment detection §req:preflight-detection

flywheel's setup script (`scripts/init.sh`) discovers the state of the
adopter's environment and repository piecemeal and *late*: it begins
prompting for choices and writing files — `.flywheel.yml`, the two
workflow files, `.gitattributes`, merge-driver git config — and only
*then*, partway through, does it probe for things like existing App
credentials or the owner's account type. A problem that should have been
caught up front instead surfaces mid-run, after the scaffold has already
been partly laid down, or fails in a later step (a `gh` call that needs a
scope the adopter's token does not have) with an error that names the API
call rather than the missing prerequisite. The adopter is left with a
half-written setup and a diagnosis they have to reverse-engineer.

Some of this is caught — but only *afterward*, by `scripts/doctor.sh`, a
separate read-only validator the adopter runs once setup is done. doctor
speaks its own severity vocabulary (FAIL / WARN / NOTE) that does not
match anything init says, so an adopter wiring up flywheel learns two
different languages for "what is wrong with my setup" and gets the
post-hoc check only after the mistakes are already committed to the repo.

Two classes of problem are entirely undetected today and bite hardest.
First, **the local environment**: whether `gh` is installed,
authenticated, and — critically — carries the *specific* scopes and
permissions the path the adopter chose will need (repo-admin to write the
App-ID variable and private-key secret and to apply rulesets; `admin:org`
when credentials are scoped org-wide; the ability to create a GitHub App
when the adopter asks init to create one). Setup proceeds optimistically
and dies at the first `gh` call that exceeds the token's grant. Second,
**a release system already in the repo**: if the repo already runs
release-please, a separate semantic-release, or hand-rolled
`gh release create` / `git tag` / `npm version` in a push or dispatch
workflow, layering flywheel on top produces two systems racing to tag and
publish releases — a conflict the adopter discovers only when releases
start colliding.

Underneath all of this is a framing the adopter never gets: when setup
reports a problem, is it **theirs to fix on their own machine**
(local-env — a pre-flight concern), **a one-time fix to the repo during
install** (instance — an install-time concern), or **an ongoing
configuration matter that lives on** (config — a long-term concern)?
Without that classification the adopter cannot tell who owns a fix or
whether it will recur, and the same finding reads differently coming out
of init than out of doctor.

The users are the adopter wiring flywheel into a repo — greenfield or
retrofit — and the flywheel maintainer who owns the setup tooling and runs
it (including in CI and via `curl … | bash`). The problem is frequent (every
adoption), mandatory (an adopter cannot avoid setup), and self-inflicted
friction rather than a release-correctness fault: nobody's published
releases break, but every adopter pays in failed-partway-through setups and
two-vocabulary confusion.

This requirement is the **shared spine** for the rest of the setup-onboarding
cluster (#234–242): the credentials prompt and the GitHub-App detection both
need the same environment-probing and classification capability, so it is
built once here — detection and vocabulary — and the sibling issues refine
the prompts and messaging that consume it.

## Pre-flight detection success criteria §req:preflight-detection-criteria

- Detection runs **before** `init.sh` issues any prompt or writes any file.
  An adopter whose environment has a blocking problem learns of it before the
  scaffold is touched — nothing is half-written when setup stops.
- Every finding is labelled on **two independent axes**: a **bucket**
  (local-env / instance / config — whose problem it is and when it is fixed)
  and a **severity** (block / warn / info — how serious it is). An adopter
  reading a finding can tell both, e.g. "`gh` not authenticated" = local-env +
  block, "repo already runs release-please" = instance + block, and
  "`allow_auto_merge` disabled" = config + warn.
- `gh` auth detection reports the **specific scopes/permissions** the chosen
  path needs and names which later step a missing one would block: repo-admin
  for the App-ID variable, the private-key secret, and ruleset application;
  `admin:org` when credentials are scoped org-wide; GitHub-App creation
  permission when the adopter asks init to create the App. A missing scope is
  reported up front, tied to the step it blocks — not as a raw `gh` API error
  mid-run.
- An existing release system **known to interfere with flywheel** — another
  tag/release producer such as release-please, a separate semantic-release, or
  hand-rolled `gh release create` / `git tag` / `npm version` in a push or
  dispatch workflow — is detected and reported as a **block**-severity
  finding. Interactive setup halts on it unless the adopter passes an explicit
  override flag; the override is a deliberate action, never a default.
- The release-system check is **best-effort and minimal**: it covers systems
  that would actually race flywheel's releases, not an exhaustive audit of
  every release tool. It tolerates a false negative (missing an exotic system)
  in preference to a false positive that needlessly blocks a clean repo.
- `doctor.sh` prints the **bucket label** on each finding and keeps its
  existing exit contract unchanged: exit 1 when any block-severity finding is
  present, 0 otherwise. init's pre-flight and doctor speak one vocabulary —
  the same buckets and the same severity names — so an adopter does not learn
  two languages for "what is wrong."
- In **non-interactive** runs (no TTY, e.g. `curl … | bash` or CI), a
  block-severity finding causes setup to **exit non-zero with the reason**,
  rather than printing the finding and proceeding with defaults as init does
  today.
- The **credentials detection** (the `FLYWHEEL_GH_APP_ID` variable and
  `FLYWHEEL_GH_APP_PRIVATE_KEY` secret, at repo and org level) and the
  **GitHub-App existence/installation detection** run as part of the same
  pre-flight pass and are classified on the same two axes — #232 ships the
  complete pre-flight, with the sibling issues (#234–242) refining the prompts
  that consume its findings.
- An adopter running setup on a clean machine and a clean repo sees the
  pre-flight pass with no blockers and setup proceeds exactly as before. The
  pass is additive: it changes nothing about a healthy setup's flow beyond
  adding a passing summary.

## Pre-flight detection user stories §req:preflight-detection-stories

- As an adopter, I want setup to tell me my `gh` CLI isn't authenticated — or
  lacks `admin:org` for the org-wide install I chose — before it writes
  anything, so I fix it once up front instead of discovering it half-way
  through a partially-scaffolded repo.
- As an adopter retrofitting flywheel onto a repo that already runs
  release-please, I want setup to stop and name the conflict before it layers
  flywheel on top, with an explicit override if I know what I'm doing, so I
  don't end up with two systems racing to tag and publish releases.
- As an adopter reading any finding, I want to know whether it's something on
  my own machine (local-env), a one-time fix to the repo (instance), or
  ongoing configuration (config), so I know who owns the fix and whether it
  will come back.
- As an adopter, I want init's pre-flight and doctor's validation to describe
  problems with the same buckets and severity names, so I don't learn two
  different vocabularies for the same kinds of problem.
- As a maintainer running setup in CI or via `curl … | bash`, I want a
  block-severity finding to fail the run loudly with a clear reason, so an
  unattended setup never proceeds on a broken environment.
- As a flywheel maintainer, I want the environment-probing and classification
  built once and reused by the credentials and GitHub-App work, so those
  features don't each reinvent detection or invent a third vocabulary.

## Pre-flight detection quality attributes and constraints §req:preflight-detection-constraints

- **Two-axis classification.** Bucket (local-env / instance / config) and
  severity (block / warn / info) are independent; every finding carries both.
  The bucket answers *whose problem and when it's fixed*; the severity answers
  *how bad*.
- **Detection precedes action.** In init, detection runs before any prompt or
  file write. "Before setup starts" is literal — the pre-flight pass is the
  first thing the adopter sees, and a block stops setup before the scaffold is
  touched.
- **Severity drives control flow.** A block halts: interactively, until the
  adopter resolves it or passes an explicit override where one is offered;
  non-interactively, by exiting non-zero. Warn and info are advisory and never
  halt.
- **Override is explicit, never default.** The override for a blocking
  existing-release-system finding is an opt-in flag the adopter must pass
  deliberately. Setup never silently proceeds past a block.
- **Minimal, best-effort release-system detection.** Scoped to known
  flywheel-interfering release producers; not an exhaustive scanner. Designed
  to tolerate a missed exotic system rather than block a clean repo on a false
  positive.
- **One vocabulary, preserved doctor behavior.** doctor adopts the bucket
  labels and the block/warn/info severity names but stays read-only and keeps
  its exit-1-on-block contract. Unification is of *vocabulary* across init and
  doctor; whether they share code is a design decision for SPEC, not a
  requirement here.
- **Reusable spine.** The detection is structured so the credentials and
  GitHub-App detections (sibling issues #234–242) consume the same
  classification and reporting, per the issue's build-once-reuse intent.
- **Read-only, no new privilege.** Detection probes local tools, `gh` auth
  state, and repo/remote state read-only; it requests no permissions beyond
  what setup already needs — indeed it exists partly to surface when those
  permissions are missing.
- **Backward compatible.** A clean environment and clean repo see no
  behavioral change beyond an added passing pre-flight summary; adopters
  consuming flywheel as an action are unaffected (this is setup-time tooling
  only).
- **Priority.** This is the gating spine of the setup-onboarding cluster and
  precedes the prompt-refinement siblings (#234–242) that consume its output.
  Among the broader areas in this document it is onboarding developer
  experience, not a release-correctness fault, so it does not outrank the
  release-safety (§req:release-safety-gate) or composite-action
  (§req:composite-action-path) work — but it is the lead item of the setup
  cluster and unblocks the rest of it.

## apply-rulesets PyYAML §req:apply-rulesets-pyyaml

`scripts/apply-rulesets.sh` is the one-shot setup step an adopter runs once
per repository — `docs/adopter/setup.md` §5 documents it as a
`curl … | bash -s -- …` one-liner — to apply Flywheel's branch- and
tag-protection rulesets. To enumerate the managed branches it must read
`.flywheel.yml`, which it does with two small Python parses (a managed-branch
list and a production-release-branch list) that depend on **PyYAML**.

When PyYAML is not importable the script aborts with
`error: PyYAML is required. Install with: pip3 install --user pyyaml`. That
instruction tells the adopter to **permanently** mutate their user
site-packages — a lasting change to their machine — to satisfy a script they
run a single time. The reporter's own resolution was to hand-build a throwaway
virtualenv, install PyYAML into it, point the script at it, and delete it
afterward: clear evidence the desired behavior is ephemeral, not persistent.

On current macOS the rude path is the *common* path. The script's header
comment claims `python3 with PyYAML (preinstalled on macOS …)`, but that was
true only of the retired system Python 2. The Xcode Command Line Tools
`python3` (3.9.x) that adopters actually have does **not** ship PyYAML, so a
first-time adopter following the documented setup hits a hard stop on the very
first flywheel action they take — and the stale comment misleads anyone reading
the script about why.

The users are two: the adopter onboarding a repository, for whom this is the
first thing they run and therefore a first-impression adoption barrier; and the
flywheel maintainer, who owns a script whose documented dependencies no longer
match reality. The problem is mandatory (the script will not run without the
parse), frequent on macOS (the default interpreter lacks the package), and
self-inflicted by a stale assumption. It blocks no *existing* adopter mid-flow —
it bites at setup time — but it taxes exactly the moment flywheel most wants to
feel frictionless.

## apply-rulesets PyYAML success criteria §req:apply-rulesets-pyyaml-criteria

- An adopter on stock macOS (Xcode CLT `python3`, no PyYAML) runs
  `apply-rulesets.sh` as documented in `docs/adopter/setup.md` and it completes
  end-to-end **without any manual dependency install** and without prompting
  them to install anything.
- After the script exits — whether it succeeds or fails — the adopter's Python
  environment and user site-packages are exactly as they were before. Nothing
  PyYAML-related is left installed on their machine.
- The same behavior holds on mainstream Linux. Where auto-provisioning genuinely
  cannot work in a given environment, the script fails with a clear,
  copy-pasteable, actionable message — not a cryptic import error.
- The two `.flywheel.yml` reads produce identical results to today: the
  complete list of managed branch refs, and the list of `release: production`
  branch refs, with the same downstream ruleset behavior.
- The script's header comment no longer claims PyYAML is preinstalled on macOS;
  its stated dependencies match what adopters actually have.
- An adopter whose `python3` already has PyYAML importable sees no change and
  does no extra work — the existing fast path is preserved, with no added
  latency or steps.

## apply-rulesets PyYAML user stories §req:apply-rulesets-pyyaml-stories

- As an adopter onboarding a new repository on macOS, I want `apply-rulesets.sh`
  to just work without my installing anything, so my first flywheel step
  succeeds and leaves my machine clean.
- As an adopter who runs this script exactly once, I do not want to permanently
  install a Python package for a single use, so my user site-packages stay
  uncluttered.
- As an adopter on an environment where the script cannot self-provision, I want
  a clear message telling me precisely what to do, so I am not stranded on
  "PyYAML is required."
- As a flywheel maintainer, I want the script's documented dependencies to match
  reality, so adopters are not misled by a stale "preinstalled on macOS" claim.
- As an adopter who already has PyYAML, I want the existing path unchanged, so
  nothing slows down or breaks for me.

## apply-rulesets PyYAML quality attributes and constraints §req:apply-rulesets-pyyaml-constraints

- **No persistent side effects.** The default path leaves nothing installed in
  the adopter's environment after the script exits. This is the core grievance
  in #245 and is a hard requirement.
- **Zero manual steps on the common path.** When PyYAML is missing, the script
  resolves it itself rather than asking the adopter to act.
- **Cross-platform with graceful degradation.** Works on stock macOS and
  mainstream Linux; where self-provisioning is genuinely impossible (e.g.
  `ensurepip` stripped on some Debian/Ubuntu builds and no alternative
  available), it exits with a clear, actionable message instead of a cryptic
  error.
- **One-shot / `curl | bash` friendly.** The script runs without relying on a
  project checkout's tooling or a pre-existing virtualenv, and stays safe to
  re-run.
- **Parse parity.** Branch enumeration from `.flywheel.yml` is byte-for-byte
  equivalent to today; this change touches how the dependency is satisfied, not
  what the parses compute.
- **Mechanism is open.** Whether the fix self-provisions an ephemeral
  environment, uses a tool like `uv` when present, drops the PyYAML dependency
  altogether, or some combination is a design decision for /symphonize:plan. The
  requirement fixes the adopter experience and the no-persistence guarantee, not
  the means.
- **Low blast radius.** The change is confined to the setup script and its
  comment/docs; it does not disturb the ruleset-application logic itself.
- **Priority.** This is an adoption-path papercut — the first thing a new
  adopter runs, and broken on the common macOS configuration — but it blocks no
  existing adopter mid-flow and is cheap and self-contained. It should not be
  sequenced ahead of the functional defects in this document (e.g.
  §req:composite-action-path), but it is low-cost polish that removes a
  first-impression barrier.
## apply-rulesets.sh stdin invocation §req:apply-rulesets-stdin

`docs/adopter/setup.md` §5 documents applying Flywheel's branch and tag
protection without checking out the repository, by piping the script straight
from `raw.githubusercontent.com`:

```bash
curl -fsSL https://raw.githubusercontent.com/point-source/flywheel/main/scripts/apply-rulesets.sh | bash -s -- <owner/repo>
```

Run that way, the script never applies anything — it dies with exit code 2
before the first GitHub API call. `apply-rulesets.sh` reads its four ruleset
templates (`managed-branches.json`, `managed-branches-review.json`,
`release-gate.json`, `tag-namespace.json`) from a `rulesets/` directory it
locates relative to *its own file*: `SCRIPT_DIR="$(cd "$(dirname
"${BASH_SOURCE[0]}")" && pwd)"`. A script read from stdin has no file on disk,
so `BASH_SOURCE[0]` is unset; under the script's `set -u` strict mode the
reference degrades to the caller's current working directory, and the later
`jq … "$SCRIPT_DIR/rulesets/managed-branches.json"` read fails ("Could not open
file … No such file or directory") unless the caller happens to already be
standing inside a Flywheel checkout — exactly the situation the piped form
exists to avoid.

The one redeeming property is that the failure is clean: the script dies at
template resolution, before it has created any ruleset, enabled
`delete_branch_on_merge`, or made any other change. The adopter's repository is
left untouched — no half-applied protection. But the documented command simply
does not do what the docs say it does.

The trap is sharpened by inconsistency. The neighbouring quick-start one-liners
in the same document — `init.sh` and `doctor.sh` — *are* genuinely stdin-safe
and work piped. An adopter who has just run `curl … init.sh | bash` and
`curl … doctor.sh | bash` successfully has every reason to assume the
`apply-rulesets.sh` one-liner on the same page works the same way. The repo
offers two contradictory invocation contracts under one visual pattern.

The users are two: the adopter following Flywheel's documented quick path with
no local checkout, for whom a copy-pasted, documented command fails on first
use; and the Flywheel maintainer, whose onboarding docs promise an install
step that cannot work. The problem is frequent for that adopter (it is the
*first* protection step in the quick path) and universal (it fails for every
adopter who takes the piped route, regardless of their config), though no
adopter is hard-blocked — the checkout invocation
(`scripts/apply-rulesets.sh …`) still works and is documented alongside.

This is the same shape of defect as §req:composite-action-path: a code path
that only the real adopter exercises (consuming Flywheel's script without
Flywheel's source already on disk) was never modelled by the project's own
runs, which always have the checkout present. The decided outcome is to make
the documented piped command genuinely work, to keep the docs honest about
which invocation forms are supported, to audit every other documented
`curl … | bash` one-liner for the same latent failure, and to add a cheap test
that exercises the stdin path so this class of break cannot ship again.

## apply-rulesets.sh stdin success criteria §req:apply-rulesets-stdin-criteria

- An adopter with **no Flywheel checkout**, running the exact command
  documented in setup.md §5 (`curl -fsSL …/apply-rulesets.sh | bash -s --
  <owner/repo>` plus its `--required-checks` / `--app-id` / optional
  `--release-required-checks` flags), applies the rulesets end to end — the
  destruction-protection, review, and tag-namespace rulesets, plus the release
  gate when requested — with the same result a checkout invocation produces. No
  exit-2, no "Could not open file," no dependence on the caller's working
  directory.
- The piped run resolves all four ruleset templates regardless of the directory
  the adopter happens to be in when they run it. Running from `$HOME`, from an
  unrelated repository, or from an empty `mktemp -d` yields the same templates
  and the same applied rulesets.
- The templates a piped run applies are consistent with the version of the
  script being run — a piped run never combines the logic of one script version
  with ruleset shapes from another in a way that produces a malformed or
  mismatched ruleset. (How the script obtains version-consistent templates is a
  design decision for SPEC; the requirement is that the rulesets it applies are
  the ones that script intends.)
- Every script that setup.md (or the README) documents as a `curl … | bash`
  one-liner is genuinely stdin-safe: piping it produces the behaviour the docs
  describe, with no latent `BASH_SOURCE`/`SCRIPT_DIR`-style failure. Where a
  script legitimately must run from a checkout, the docs present it that way and
  do **not** show a piped form for it.
- The checkout invocation (`scripts/apply-rulesets.sh <owner/repo> …`) is
  unchanged — same templates, same applied rulesets, same idempotent
  create-or-replace behaviour as today.
- A fast local/CI test runs `apply-rulesets.sh` the way an adopter pipes it —
  read from stdin, with no Flywheel checkout in the working directory — and
  fails if the script cannot resolve its ruleset templates; it passes once the
  script resolves them. The test reproduces the failure at template resolution,
  before any GitHub API call, so it needs no live GitHub access and adds no load
  to the rate-limited sandbox installation (§req:sandbox-ci-budget). e2e stays a
  backstop, not the first line of defence for this class of bug.
- The clean-failure property is preserved: if the script genuinely cannot obtain
  its templates (e.g. no network on a piped run), it still aborts before
  creating any ruleset or changing any repository setting, leaving no
  partially-applied protection state.

## apply-rulesets.sh stdin user stories §req:apply-rulesets-stdin-stories

- As an adopter with no Flywheel checkout, I want the documented
  `curl … apply-rulesets.sh | bash -s -- <owner/repo>` command to actually apply
  my branch and tag protection, so I can secure my repo from the quick path
  without cloning Flywheel first.
- As an adopter who just ran the `init.sh` and `doctor.sh` one-liners
  successfully, I want `apply-rulesets.sh` to work the same way when piped, so I
  am not tripped up by one script on the page that silently needs a checkout the
  others do not.
- As an adopter, I want a failed template fetch to abort the run before any
  ruleset is applied, so a botched piped run never leaves my repository
  half-protected.
- As a Flywheel maintainer, I want setup.md to show only invocation forms that
  work, so no adopter hits exit 2 on a command I documented.
- As a Flywheel maintainer, I want every documented `curl … | bash` one-liner
  verified stdin-safe, so I learn about a latent self-location failure from my
  own audit rather than from an adopter's bug report.
- As a Flywheel maintainer, I want a cheap test that runs the script exactly as
  an adopter pipes it, so the "our own runs always have the checkout, so the
  adopter path is never modelled" failure mode (the same shape as
  §req:composite-action-path) cannot ship again.

## apply-rulesets.sh stdin quality attributes and constraints §req:apply-rulesets-stdin-constraints

- **Fail clean, never half-protected.** The script's existing property — it dies
  before touching any ruleset or repo setting when it cannot proceed — is a hard
  requirement to preserve. A run that cannot obtain valid templates leaves the
  repository exactly as it found it.
- **Idempotence preserved.** The fix changes only how the script locates its
  templates, not its create-or-replace-by-name behaviour; re-running it (piped or
  from a checkout) still updates existing rulesets in place rather than stacking
  duplicates.
- **One consistent invocation contract.** After the fix, every documented piped
  one-liner behaves the same way when piped — the adopter does not have to know
  which scripts secretly require a checkout. Consistency across `init.sh`,
  `doctor.sh`, and `apply-rulesets.sh` is part of the outcome, not just the
  single-script fix.
- **Strict mode stays.** The script relies on `set -u` (and its other strict-mode
  guards) to fail fast on unset variables; the fix coexists with strict mode
  rather than relaxing it to paper over the unbound `BASH_SOURCE[0]`.
- **Version-consistent templates.** Under stdin the script cannot read its own
  file location, and therefore cannot derive from the runner which Flywheel ref
  it was fetched from; whatever templates a piped run uses must still match the
  script's own logic. Choosing the ref/source for a remote fetch deterministically
  is a SPEC design decision — the requirement is only that the result is
  version-consistent, never a silent script/template mismatch.
- **No heavier dependency surface for the adopter.** A piped run already requires
  network (it is itself fetched over the network and it calls the GitHub API via
  `gh`) and already requires `gh`, `jq`, and `python3`/PyYAML. The fix should not
  impose new tools or new privileges on the adopter beyond what the script
  already demands.
- **Cheap coverage only.** The regression test lives in the fast local/CI suite
  and does not draw on the e2e sandbox's rate-limited installation
  (§req:sandbox-ci-budget).
- **Priority.** Adopter-facing and on the documented onboarding path — the *first*
  protection step in the quick start — so it directly degrades first-run
  experience for every adopter who takes the piped route. It ranks below the
  failures that break releases or the whole v2 major (§req:release-safety-gate,
  §req:composite-action-path): no adopter is hard-blocked, since the checkout
  invocation works and is documented alongside, and the failure is clean rather
  than corrupting. It is self-contained — one script's self-location, a docs
  audit, and a cheap test — and removes a documented command that fails on first
  use. In decreasing order of user impact: (1) make the piped
  `apply-rulesets.sh` command work end to end; (2) keep the docs honest and audit
  every other documented one-liner for the same class of failure; (3) the cheap
  stdin regression guard.

## Setup completion summary §req:setup-completion-summary

When an adopter finishes wiring flywheel into a repo, they cannot tell
whether setup is actually *done*. `scripts/init.sh` ends by printing a
fixed "Next steps" block — review `.flywheel.yml`, commit and push, open a
smoke-test PR, run `doctor.sh` — and prints it identically no matter what
the run did. It says the same thing whether the adopter set up App
credentials or skipped them, applied the protection rulesets or declined,
hit a pre-flight blocker or sailed through clean. The adopter is left to
reconstruct from scrollback what was configured, what was skipped, and
what still needs doing — and to remember to run a *separate* validator
(`doctor.sh`) to find out whether any of it actually took. There is no
moment where setup says "here is what I did, here is what is left, and
here is whether you are ready."

The same gap exists in the manual path. An adopter retrofitting an
existing repo follows the §0 brownfield walkthrough in
`docs/adopter/setup.md` — audit tags, disable prior release automation,
confirm the bot can push, audit recent commits — and reaches the end with
no single place that confirms the whole sequence is complete. The script
and the docs describe "you are finished" differently (or, in the script's
case, not at all), so an adopter who runs init and an adopter who follows
the walkthrough learn two different pictures of "done."

This compounds a vocabulary the rest of the setup cluster (#234–242)
already established. §req:preflight-detection made init's *up-front*
findings speak two axes — a **bucket** (local-env / instance / config) and
a **severity** (block / warn / info) — and made `doctor.sh` speak the same
language. But the *end* of the run drops that vocabulary entirely: the
"Next steps" block is prose with no buckets, no severity, no tie to the
findings the same run surfaced minutes earlier. The adopter learns one
language for "what is wrong before we start" and a different, vaguer one
for "what is left now that we are done."

The users are the adopter wiring flywheel into a repo (greenfield or
retrofit) and the flywheel maintainer who runs setup unattended — in CI or
via `curl … | bash`. For the unattended maintainer the gap is sharper: a
piped run prints "Next steps" and exits 0 regardless of whether a step
failed or was silently skipped, so a CI pipeline cannot tell a clean setup
from a half-finished one. The problem is frequent (every adoption),
mandatory (no adopter avoids setup), and is first-run-experience friction
rather than a release-correctness fault — nobody's published releases
break, but every adopter pays in uncertainty about whether they are
actually done.

This is the closing item of the setup-onboarding cluster: it consumes the
detection and the two-axis vocabulary built in §req:preflight-detection
and turns them into the run's *final* report, so the adopter's last screen
matches the language of the first.

## Setup completion summary success criteria §req:setup-completion-summary-criteria

- Setup ends with a **summary that reflects what the run actually did**, not
  a fixed list. Every scaffold step init can touch is accounted for with its
  real outcome: the `.flywheel.yml` preset, the two adopter workflow files,
  `.gitattributes` plus the merge-driver git config, the App credentials (the
  `FLYWHEEL_GH_APP_ID` variable and `FLYWHEEL_GH_APP_PRIVATE_KEY` secret), and
  ruleset application. Each is shown as configured, skipped, failed, or
  deferred-to-the-adopter.
- Setup ends with an **explicit verdict**: "complete" or "incomplete — N
  items remain." A **deliberate skip is not a failure** — when the adopter
  answers no to a step or passes a `--skip-*` flag, the run can still read
  "complete," with the skipped item listed as deferred and the exact command
  to finish it later. Only a step that failed, or an unresolved
  block-severity finding, makes the verdict "incomplete."
- Outstanding and deferred items in the summary are **labelled in the
  pre-flight vocabulary** — the same bucket (local-env / instance / config)
  and severity (block / warn / info) axes from §req:preflight-detection — so
  the adopter reads the *end* of the run in the same language as its
  *beginning*. "App credentials not set" reads as the same kind of thing at
  completion as it would at pre-flight.
- Each deferred item names **the exact command that finishes it**, so the
  adopter never has to reconstruct the remaining step from scrollback (e.g.
  the `scripts/apply-rulesets.sh <repo> --app-id <id>` line init already
  emits when rulesets are skipped, surfaced uniformly for every deferred
  step).
- Setup **auto-runs the `doctor.sh` validation at the end of every run** —
  interactive or not — so the adopter sees a green/red confirmation that the
  scaffold actually took, instead of being told to run a separate validator
  themselves. doctor's findings feed the same end-of-run summary and speak
  the same buckets and severity, so init and doctor produce one picture of
  "done," not two.
- In a **non-interactive run** (`curl … | bash`, CI), the completion summary
  is **machine-readable** and init **exits with a meaningful code**: zero
  when setup is complete (including complete-with-deliberate-deferrals),
  non-zero when a step that was meant to run failed or a block-severity
  finding is unresolved. A clean setup that the adopter intentionally
  trimmed still exits zero.
- A **strict mode** (a flag) is available that **elevates warn-severity
  outstanding items to a non-zero exit**, so a maintainer who wants CI to
  treat any deferred-or-warned item as a failure-to-investigate can opt into
  it, while the default keeps deliberate skips green.
- The manual §0 brownfield walkthrough in `docs/adopter/setup.md` ends with a
  **completion check that mirrors the script's verdict and vocabulary**, so
  an adopter who follows the docs and an adopter who runs init reach the same
  definition of "finished."
- A clean greenfield run that configures everything ends with an
  **all-configured summary and a "complete" verdict** — the change is
  additive and never makes a healthy setup look unfinished.

## Setup completion summary user stories §req:setup-completion-summary-stories

- As an adopter, I want setup to end by telling me exactly what it
  configured, what I skipped, and what failed, so I do not have to scroll
  back through the whole run to reconstruct where I stand.
- As an adopter, I want a clear "you are set up" or "N items still needed"
  verdict at the end, so I know whether I can stop or still have work to do.
- As an adopter who deliberately skipped the rulesets for now, I want the run
  to still say I am done — with the one command to apply them later — so a
  choice I made on purpose is not reported to me as a failure.
- As an adopter, I want the leftover items at the end described in the same
  local-env / instance / config and block / warn / info terms the pre-flight
  used, so I am not learning a second vocabulary for the same kinds of
  problem.
- As an adopter, I want setup to validate itself at the end instead of
  telling me to go run another script, so I get a green/red confirmation that
  the wiring actually took before I walk away.
- As a maintainer running setup in CI or via `curl … | bash`, I want a failed
  or block-level setup to exit non-zero with a readable summary, so an
  unattended pipeline can tell a finished setup from a half-finished one.
- As a maintainer with stricter standards, I want a flag that also fails the
  run on warn-level leftovers, so CI can treat any deferred item as something
  to investigate while ordinary adopters keep their deliberate skips green.
- As an adopter retrofitting an existing repo by hand, I want the §0
  walkthrough to end with the same completion check the script uses, so the
  manual path and the scripted path agree on what "done" means.

## Setup completion summary quality attributes and constraints §req:setup-completion-summary-constraints

- **One vocabulary, end to end.** The completion summary reuses the bucket ×
  severity classification from §req:preflight-detection rather than inventing
  a third way to describe setup state. init's pre-flight, init's completion
  summary, and doctor all speak the same buckets and severity names.
- **Deliberate skip ≠ failure.** The verdict distinguishes an adopter's
  intentional choice (answered no, passed `--skip-*`) from a step that was
  supposed to run and did not. Conflating the two would train adopters to
  ignore "incomplete," defeating the signal.
- **Additive to the happy path.** A clean, fully-configured run is unchanged
  except for gaining a passing summary and verdict. The completion signal
  never turns a healthy setup into a scary one.
- **Auto-validation respects the cost ceiling.** Auto-running `doctor.sh`
  costs `gh` API calls; the validation stays within flywheel's
  API-budget posture (§req:sandbox-ci-budget) — it reuses what the run
  already knows where it can and does not balloon into a heavy re-probe of
  the whole environment.
- **Exit-code contract is stable and documented.** The default exit
  semantics (zero on complete-including-deliberate-deferrals, non-zero on
  real failure or unresolved block) and the strict-mode flag are a contract
  CI can depend on; the §req:preflight-detection block-severity exit behavior
  is preserved, not overridden.
- **Machine-readability does not break interactive readability.** The
  non-interactive summary is parseable, but the interactive run still reads
  as human-friendly prose — one summary serves both audiences rather than
  forcing a format that is good for neither.
- **Priority.** Adopter-facing and on the documented onboarding path — it is
  the *last* thing every adopter sees, so it directly shapes first-run
  confidence. It ranks below the failures that break releases or a whole
  major (§req:release-safety-gate, §req:composite-action-path) and below the
  pre-flight spine it depends on (§req:preflight-detection): no adopter is
  hard-blocked, and the scaffold itself still works without it. It is the
  closing, polish item of the setup-onboarding cluster (#234–242). In
  decreasing order of user impact: (1) the outcome-accurate summary and
  complete/incomplete verdict at end of run; (2) the auto-validation pass so
  the adopter gets a green/red confirmation without a second command; (3) the
  non-interactive exit-code contract and strict-mode flag; (4) aligning the
  §0 manual walkthrough's completion check with the script's.
