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
<!--   - doctor.sh repo-settings read — doctor reports allow_auto_merge / -->
<!--     delete_branch_on_merge as disabled when an under-scoped token simply -->
<!--     can't read them (false negative); severity reconciled to warn+config -->
<!--     (§req:doctor-settings-read, §req:doctor-settings-read-criteria, -->
<!--     §req:doctor-settings-read-stories, §req:doctor-settings-read-constraints) -->
<!--   - Dependabot PR deadlock — when the app private key is empty on a -->
<!--     Dependabot-triggered run, the conductor skips entirely and never posts -->
<!--     the required flywheel/conventional-commit check, so the PR can never -->
<!--     merge (#243; fork PRs are the sibling case, tracked separately by #162) -->
<!--     (§req:dependabot-deadlock, §req:dependabot-deadlock-criteria, -->
<!--     §req:dependabot-deadlock-stories, §req:dependabot-deadlock-constraints) -->
<!--   - doctor.sh curl-mode script references — doctor's remediation messages -->
<!--     name flywheel scripts by local relative path (scripts/apply-rulesets.sh, -->
<!--     scripts/init.sh), which an adopter cannot follow when doctor itself is -->
<!--     run via `curl … | bash` and no local scripts/ exists (#238) -->
<!--     (§req:doctor-curl-script-refs, §req:doctor-curl-script-refs-criteria, -->
<!--     §req:doctor-curl-script-refs-stories, §req:doctor-curl-script-refs-constraints) -->
<!--   - doctor.sh credential-check clarity — the App-token credential checks -->
<!--     hard-FAIL (exit 1) when the local gh token cannot list repo Variables/ -->
<!--     Secrets, reading as if flywheel is broken; downgrade the can't-verify -->
<!--     case to warn and say plainly that an unverifiable check does not mean -->
<!--     flywheel won't work (#237) -->
<!--     (§req:doctor-credential-clarity, §req:doctor-credential-clarity-criteria, -->
<!--     §req:doctor-credential-clarity-stories, §req:doctor-credential-clarity-constraints) -->

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

Both success criteria are mandatory and were judged equally important —
the newcomer's confusion and the re-runner's redundant prompt are the two
halves of the same onboarding-friction problem. Naming the credentials
(clarity) is the cheaper, higher-confidence half and should land first;
surfacing partial pre-existing state (no redundant asks) is the
higher-impact half for org adopters running `init.sh` repeatedly. Doc
alignment is mandatory for consistency but rides along with the prompt
wording rather than gating it. This is self-contained onboarding polish:
nothing is blocked on it and no workflow breaks today, so it sits below
the release-safety and CI-budget work in this document on severity, but it
removes friction at adoption — the moment an adopter is most likely to
abandon setup.

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
permissions the path the adopter chose requires (repo-admin to write the
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
whether it recurs, and the same finding reads differently coming out
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
tag-protection rulesets. To enumerate the managed branches it needs to read
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
match reality. The problem is mandatory (the script does not run without the
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

## doctor.sh repo-settings read §req:doctor-settings-read

`scripts/doctor.sh` is the read-only validator an adopter runs to confirm a
repository is correctly wired for flywheel. Under "Repo settings" it checks two
GitHub repository options flywheel depends on: `allow_auto_merge` — without it
flywheel cannot schedule native auto-merge, so eligible PRs fall back to a
direct merge that bypasses required status checks (#147/#153) — and
`delete_branch_on_merge`, without which head branches linger after every merge.

doctor reads both off a single `gh api repos/<owner>/<repo>` call and treats a
setting as enabled only when its field reads back exactly `true`. But GitHub
omits these merge-setting fields from the repository object entirely when the
caller's token lacks repo-admin permission: the API call itself still succeeds
and returns the repo, just without the admin-only fields. doctor cannot tell
that *absence* apart from a genuine `false`, so it reports the setting as
**disabled** when the truth is "enabled, but this token can't see it." An
adopter running doctor with a non-admin token — or an App installation token —
is told to go re-enable settings that are already on. That false negative sends
the adopter chasing a non-problem and erodes trust in the whole report; a check
that confidently misdirects is worse than one that stays silent.

This is the same conflation doctor already avoids everywhere else. Its variable,
secret, and ruleset checks distinguish "could not read — needs admin" from
"absent" by inspecting whether the API call succeeded (e.g. "could not list repo
secrets — listing requires an admin PAT"). The repo-settings block is the one
place that reads admin-gated fields off an otherwise-successful call and so
silently mis-reports. The fix shall make every such read distinguish three
states — enabled, disabled, and could-not-verify — not two.

The two checks also carried inconsistent severity historically: `allow_auto_merge`
reported as a hard fail while `delete_branch_on_merge` reported as a warn. The
pre-flight-detection work (#250, §req:preflight-detection) already reconciled
this — both now report at warn severity in the config bucket — and that is the
intended, settled level. This requirement ratifies it rather than re-opening it.

The users are the adopter validating their setup and the flywheel maintainer who
owns doctor. The problem is frequent (any adopter who runs doctor without an
admin token), self-inflicted (a reporting bug, not a release fault), and
corrosive rather than blocking: nothing breaks, but the adopter is actively
misdirected. It sits inside the setup-onboarding cluster and reuses the
two-axis vocabulary — bucket × severity — established by §req:preflight-detection.

## doctor.sh repo-settings read success criteria §req:doctor-settings-read-criteria

- An adopter whose repo has the setting enabled and whose token *can* read it
  sees it reported enabled, exactly as today.
- An adopter whose token *cannot* read the setting (no repo-admin; the field is
  absent from the API response) sees a distinct "could not verify
  `<setting>` — reading it requires repo-admin" finding, never a "disabled"
  claim. doctor does not assert a setting is off when it merely could not read
  it.
- When a setting is genuinely disabled and the token can read it, doctor reports
  it disabled with the existing remediation guidance (re-run
  `scripts/apply-rulesets.sh`, or the Settings path), unchanged.
- The could-not-verify finding is classified **local-env** (it is about the
  adopter's own token and permissions) at **warn** severity, consistent with how
  doctor already reports the analogous "could not list repo secrets — requires
  an admin PAT" case.
- The same three-state treatment (enabled / disabled / could-not-verify) is
  applied across **every** doctor check that reads a permission-gated field off
  an otherwise-successful `gh api` response — not only the two settings named in
  #239. No remaining check can silently report "disabled" or "absent" when the
  real cause is a permission gap.
- Both `allow_auto_merge` and `delete_branch_on_merge`, when genuinely disabled,
  report at the **same** severity and bucket (warn / config), ratifying the
  reconciliation #250 already made; doctor no longer reports one as a fail and
  the other as a warn.
- doctor's exit contract is unchanged: a could-not-verify finding is not a
  block, so doctor still exits 1 only when a block-severity finding is present
  and 0 otherwise (§req:preflight-detection-criteria).
- A fast local test exercises the could-not-verify path — doctor fed a repo
  response with the admin-gated fields absent reports "could not verify," not
  "disabled" — so this false negative cannot silently return. The test needs no
  live GitHub access and adds no load to the rate-limited sandbox installation
  (§req:sandbox-ci-budget).

## doctor.sh repo-settings read user stories §req:doctor-settings-read-stories

- As an adopter running `doctor.sh` with a non-admin or App installation token, I
  want doctor to tell me it couldn't read `allow_auto_merge` /
  `delete_branch_on_merge` rather than claim they're disabled, so I don't waste
  time re-enabling settings that are already on.
- As an adopter, I want a could-not-read finding to read the same way as doctor's
  other permission notes ("requires an admin PAT"), so I recognise it as a
  visibility limit on my side, not a misconfiguration of my repo.
- As an adopter with a genuinely disabled setting, I want doctor to still flag it
  with the same remediation guidance as before, so the real-misconfiguration
  case is unchanged.
- As a flywheel maintainer, I want every doctor check that reads a
  permission-gated repo field to distinguish "could not verify" from "off," so no
  other check silently false-negatives the way the repo-settings block did.
- As a flywheel maintainer, I want the two settings to share one severity (warn)
  and bucket (config), so the report speaks one consistent language and the
  historical fail-vs-warn mismatch stays closed.

## doctor.sh repo-settings read quality attributes and constraints §req:doctor-settings-read-constraints

- **Three states, not two.** Every repo-field read distinguishes enabled,
  disabled, and could-not-verify. The absence of a field under insufficient
  permission is never collapsed into "disabled."
- **One vocabulary.** Findings use the bucket × severity vocabulary from
  §req:preflight-detection: a genuinely-disabled setting is config + warn; a
  could-not-verify finding is local-env + warn. No new severity or bucket names
  are introduced.
- **Severity reconciliation is ratification, not re-litigation.** #250 already
  set both settings to warn + config; this requirement records that as the
  intended end state rather than proposing a different level.
- **Exit contract unchanged.** doctor stays read-only and keeps exit 1 only when
  a block-severity finding is present, 0 otherwise. Neither the warn for a
  disabled setting nor the could-not-verify finding is a block, so doctor's exit
  behavior for these checks does not change.
- **No new privilege.** The fix changes how doctor *interprets* what it already
  reads; it requests no additional scopes. The whole point is to behave
  correctly precisely when the token is under-scoped.
- **Mechanism is open.** How doctor tells an absent field from a `false` one
  (distinguishing JSON null from boolean false, probing for the field's presence,
  or another means) is a SPEC design decision; the requirement fixes the
  adopter-visible behavior — never a false "disabled."
- **Low blast radius.** The change is confined to doctor.sh's reporting of
  repo-field reads; it does not alter `apply-rulesets.sh`, the settings
  themselves, or any release behavior.
- **Cheap coverage only.** The regression test lives in the fast local/CI suite
  and does not draw on the e2e sandbox's rate-limited installation
  (§req:sandbox-ci-budget).
- **Priority.** Low-severity, self-contained onboarding correctness. Nothing
  breaks and no release is at risk, so it does not outrank the release-safety
  (§req:release-safety-gate), composite-action (§req:composite-action-path), or
  stdin (§req:apply-rulesets-stdin) work in this document. It is nonetheless a
  direct trust-eroder — doctor actively misdirects under-scoped adopters — and is
  cheap: a three-state read, an audit of sibling checks, and one local test.

## Dependabot PR deadlock §req:dependabot-deadlock

An adopter who follows Flywheel's documented setup registers the GitHub App
private key as an **Actions** secret and applies the default ruleset from
`apply-rulesets.sh`, which makes `flywheel/conventional-commit` a **required**
check. The moment they also enable Dependabot, every Dependabot PR becomes
permanently unmergeable.

GitHub runs `dependabot[bot]`-actored workflows with the **Dependabot** secret
store, not the Actions store — the same secret isolation it applies to fork
PRs. The app private key the adopter registered for Actions is therefore not
present on a Dependabot-triggered run, so it arrives empty. Flywheel's
conductor cannot mint an app token without it, so it skips the run entirely —
and skipping means the required `flywheel/conventional-commit` check is never
posted. The PR sits at `BLOCKED` with that check showing **Expected**
indefinitely: it is waiting on a check that, by construction, never
arrives. A routine `build(deps)` bump is stranded with no obvious cause.

The skip notice makes this worse by being wrong. It says the PR "can still be
merged manually" — language written for the era before the check was required.
Once `apply-rulesets.sh`'s own default makes the check required, that
reassurance is false: the PR cannot be merged at all, by hand or otherwise,
until the missing check appears. The adopter reads a calm "this is expected for
fork PRs" notice while their PR is silently deadlocked, and the notice never
mentions Dependabot at all.

The deadlock is silent, permanent, and near-universal for its trigger: it fires
for every adopter who combines the documented default ruleset with Dependabot —
which is to say, the recommended secure configuration plus one of the most
common GitHub features. Nothing the adopter did was wrong; the project's own
defaults compose into a trap.

There are two distinct user wants tangled in this one symptom, and they pull in
opposite directions. The adopter wants Dependabot PRs to **stop deadlocking** —
unconditionally, with no setup, the moment they adopt Flywheel. But they do
**not** want every secret-less PR to gain Flywheel's full powers, because
auto-merge in the hands of an untrusted actor is a repository-compromise vector.
The resolution is that breaking the deadlock and granting auto-merge are
separable: posting the required check needs no app privilege and is always safe,
while auto-merge stays gated behind whether the app key is actually reachable on
the run. For Dependabot, the adopter makes the key reachable by registering it
in the **Dependabot** secret store — a deliberate, GitHub-native act of trust
that an external fork can never perform. The secret store *is* the actor
allowlist; Flywheel adds no allowlist of its own.

This requirement covers the **Dependabot** trigger only. Fork PRs are the
sibling instance of the same empty-key root cause and remain tracked separately
by #162; a fix here shares a seam with that case and may relieve it, but
fork-specific behaviour, documentation, and verification are out of scope and
issue #162 stays open.

## Dependabot PR deadlock success criteria §req:dependabot-deadlock-criteria

- A Dependabot PR in a repo that requires `flywheel/conventional-commit`, where
  the app key is **not** in the Dependabot secret store, still receives a
  pass/fail `flywheel/conventional-commit` check reflecting its title — so the
  PR is no longer deadlocked and a maintainer can merge it once it is green and
  reviewed. The deadlock is gone with **zero adopter configuration**.
- In that same not-opted-in state, the Dependabot PR is **not** auto-merged and
  gains none of the app-only actions (title rewrite, auto-merge / needs-review
  labels, promotion-PR upserts). It is made mergeable, not merged.
- When the adopter registers the app key in the **Dependabot** secret store, a
  Dependabot PR runs the full conductor exactly as a first-party PR does: its
  title is validated (and rewritten if malformed), the auto-merge or
  needs-review label is applied, and the PR auto-merges when its title type is
  listed in the target branch's `auto_merge` set and every other required gate
  (other checks, required reviews) is satisfied.
- A Dependabot PR is **never** auto-merged unless the app key is reachable on
  the run. Absent the Dependabot secret, it receives the check and waits for a
  human; auto-merge is opt-in by the explicit act of granting Dependabot the
  key, never a default.
- The pass/fail verdict a Dependabot title receives matches the verdict the same
  title would receive on a first-party PR — Dependabot's `build(deps): …` /
  `chore(deps): …` titles validate identically.
- `docs/adopter/setup.md` documents registering the app private key in the
  Dependabot secret store, alongside the Actions secret, as the step that
  enables full Flywheel behaviour (including auto-merge) for Dependabot PRs.
- The notice emitted when the key is empty names Dependabot explicitly, states
  whether the required check was posted, and no longer claims the PR "can still
  be merged manually" in the case where that is untrue.
- The `apply-rulesets.sh` default that makes `flywheel/conventional-commit` a
  required check is unchanged — the fix posts the check, it does not weaken the
  default (§req:dependabot-deadlock-constraints).

## Dependabot PR deadlock user stories §req:dependabot-deadlock-stories

- As an adopter who just turned on Dependabot, I want its PRs to receive the
  required conventional-commit check even though I have configured nothing
  special, so a routine dependency bump is never permanently stuck behind a
  check that can't be posted.
- As an adopter, I want to opt Dependabot into the full Flywheel flow —
  auto-merge included — by registering the app key where Dependabot can read it,
  so trusted dependency bumps merge automatically when they are green.
- As a security-conscious adopter, I want a Dependabot PR to auto-merge **only**
  because I explicitly granted it the key, and an external contributor's PR to
  never auto-merge at all, so I keep control over what merges without review.
- As an adopter reading a run log, I want the notice to tell me plainly that
  this is a Dependabot PR and whether the required check was posted, so I am not
  misled into thinking the PR is mergeable when it is deadlocked — or left
  worrying when it is actually fine.
- As a Flywheel maintainer, I want setup.md to show the Dependabot-secret step,
  so adopters enable Dependabot auto-merge from the docs instead of discovering
  the deadlock through a bug report.

## Dependabot PR deadlock quality attributes and constraints §req:dependabot-deadlock-constraints

- **Safe by default.** No run that lacks the app key gains auto-merge or any
  other app-only action. Breaking the deadlock (posting the check) and granting
  auto-merge are separate outcomes with separate triggers; the former is
  unconditional, the latter is gated on the key being reachable.
- **Trust is GitHub-enforced, not Flywheel-configured.** The Dependabot secret
  store is the opt-in that marks Dependabot trusted; an external fork can never
  reach it, so a fork can never auto-merge. Flywheel adds no allowlist of its
  own — the secret store already *is* the actor allowlist, and a second trust
  mechanism would only risk drifting out of sync with GitHub's.
- **No new privilege.** Posting the check requires only the low-privilege token
  always present on a run (`checks: write`); it needs none of the App's
  authority. The App-only features stay skipped when the key is empty. (Which
  token posts the check and how the conductor degrades is a SPEC design
  decision; the requirement is that the required check is posted and that no
  app-only action runs without the key.)
- **Required-check default preserved.** `flywheel/conventional-commit` remains a
  required check by `apply-rulesets.sh` default. The defect is the unposted
  check, not the requirement — the fix is to always post it for Dependabot, not
  to relax the default and let malformed titles through.
- **Supply-chain risk is the adopter's to accept.** Auto-merging Dependabot
  means a dependency update that passes checks can merge without human review —
  the standard supply-chain tradeoff. Flywheel makes that lever explicit and
  off by default (it activates only when the adopter registers the Dependabot
  secret and lists the relevant types in a branch's `auto_merge` set); it does
  not decide dependency trust on the adopter's behalf.
- **Scope boundary.** Only the Dependabot trigger is in scope. Fork PRs (#162)
  share the empty-key root cause and may benefit from the same seam, but
  fork-specific behaviour, docs, and tests are out of scope and #162 remains
  open. This requirement neither closes nor depends on #162.
- **Statelessness preserved.** The empty-key path posts a check and exits;
  Flywheel holds no state between runs and waits on nothing after posting.
- **Cheap coverage.** A fast local/CI test reproduces the empty-key Dependabot
  path — required check posted, no auto-merge label applied — without drawing on
  the rate-limited e2e sandbox installation (§req:sandbox-ci-budget). e2e stays a
  backstop, not the first line of defence for this class of deadlock.
- **Priority.** Adopter-facing, silent, and permanent: a Dependabot PR stuck at
  `BLOCKED` with no posted check and a reassuring-but-wrong notice is a worse
  first-run experience than a clean failure, because nothing tells the adopter
  what is wrong. The trigger is near-universal — the documented default ruleset
  plus one of GitHub's most common features. It ranks below the failures that
  break releases or the whole v2 major (§req:release-safety-gate,
  §req:composite-action-path): a maintainer who notices can still merge a stuck
  PR by hand, so no adopter is hard-blocked, only silently obstructed. In
  decreasing order of user impact: (1) post the required check so Dependabot PRs
  are never deadlocked, with no adopter configuration; (2) document and enable
  the Dependabot-secret opt-in so trusted bumps can auto-merge; (3) make the
  notice honest about Dependabot and about whether the check was posted.

## doctor.sh curl-mode script references §req:doctor-curl-script-refs

`scripts/doctor.sh` is a read-only validator an adopter runs to confirm a repo
is correctly wired for flywheel. It is documented to be run **two ways**: from a
local checkout (`./scripts/doctor.sh`) and — the form the README and adopter
setup guide lead with — straight off GitHub with
`curl -fsSL …/scripts/doctor.sh | bash`, where nothing of flywheel is on the
adopter's disk. The scripts doctor tells an adopter to run as a fix —
`apply-rulesets.sh` and `init.sh` — are themselves documented the same dual way,
including a curl one-liner.

When doctor reports a problem it also prints how to fix it, and those
remediation messages name the fix scripts by **local relative path**: "Re-run
`scripts/apply-rulesets.sh $REPO`", "run `scripts/apply-rulesets.sh $REPO`",
"re-run `scripts/init.sh`". That instruction is only followable when doctor was
itself run from a local checkout. An adopter who followed the documented
`curl … | bash` path has no `scripts/` directory, so the very next thing doctor
tells them to do cannot be done — it points at a file that does not exist on
their machine. They are left to reverse-engineer that the fix is "fetch *this*
script the same way I just fetched doctor, and run it with the right
arguments."

The gap is that doctor already solves exactly this problem for its **own**
dependencies but not for the scripts it recommends. To locate `lib/findings.sh`
and `lint-flywheel-config.py`, doctor checks whether it is running beside its
on-disk siblings and, when it is not (the curl case), fetches them over the
network — and it fetches them at the **same version** doctor itself came from
(honoring `FLYWHEEL_TEMPLATES_BASE` for a pinned consumer, defaulting to `main`),
not blindly at `main`. The remediation messages were never given that same
treatment: they assume the local layout unconditionally.

The affected messages span four finding areas — repo-settings
(`allow_auto_merge`, `delete_branch_on_merge`), branch-protection (no ruleset,
ruleset-without-PR-requirement, a branch not covered), tag-namespace
(`refs/tags/v*`), all pointing at `apply-rulesets.sh`; plus the `.gitattributes`
findings pointing at `init.sh`. They break identically under curl. A further
wrinkle is that even the local form is under-specified: `apply-rulesets.sh`
cannot do its job without `--app-id`, which the current "`scripts/apply-rulesets.sh
$REPO`" text omits — so an adopter who *does* have the script still pastes a
command that fails on a missing argument.

The user is the adopter validating their setup — most often via the documented
curl path, on a machine with no flywheel checkout — and the flywheel maintainer
who owns the setup tooling. The problem is frequent (any adopter who hits a
finding), self-inflicted onboarding friction rather than a release-correctness
fault: nobody's releases break, but the one document whose entire job is to tell
an adopter what is wrong and how to fix it hands them a fix they cannot run.
This sits in the setup-onboarding cluster (#234–242) alongside
§req:preflight-detection (shared doctor vocabulary) and touches the same
repo-settings findings as §req:doctor-settings-read; the apply-rulesets curl
form it shall emit is the one whose own invocation is constrained by
§req:apply-rulesets-stdin.

## doctor.sh curl-mode script references success criteria §req:doctor-curl-script-refs-criteria

- An adopter who runs doctor via the documented `curl … | bash` path and hits
  any finding is given a remediation command that **runs as-is in that same
  context** — it fetches and runs the named fix script over the network (the
  curl form) rather than naming a `scripts/…` path that is absent on their
  machine.
- An adopter who runs doctor from a local checkout (`./scripts/doctor.sh`)
  still sees the **local `scripts/…` path** form in remediation messages — the
  fix matches how they actually invoked doctor, with no regression to the
  local workflow.
- Every remediation command that names a fix script carries the **arguments
  that script needs to actually perform the fix** — `apply-rulesets.sh` is
  shown with `--app-id` (and the repo target), not just its bare path — using
  a clearly-marked placeholder (e.g. `<your-app-id>`) where doctor cannot know
  the concrete value, and substituting `$REPO` where doctor does know it. An
  adopter who copy-pastes the command applies the fix instead of erroring on a
  missing argument.
- **Every** doctor finding that points at a flywheel script is corrected —
  both `apply-rulesets.sh` (repo-settings, branch-protection, tag-namespace)
  and `init.sh` (`.gitattributes`). A reader scanning doctor's output finds no
  remaining remediation message that assumes a local `scripts/…` layout and
  breaks under curl.
- The curl form a message emits points at the **same flywheel version doctor
  itself was fetched from** — honoring the pin / `FLYWHEEL_TEMPLATES_BASE` that
  already governs how doctor fetches `findings.sh` and the linter, defaulting
  to `main` — so a pinned adopter is told to fetch the matching
  `apply-rulesets.sh` / `init.sh`, not a `main` that may have drifted.
- doctor's existing exit contract, severity buckets, and finding vocabulary are
  unchanged — only the wording of the remediation guidance changes. A repo that
  was healthy before is healthy after; a finding that fired before fires after,
  with the same severity and bucket.
- A fast local test confirms the behavior in both modes: a finding's
  remediation is the network/curl form when doctor runs without its on-disk
  siblings, and the local-path form when it runs beside them — so a future edit
  that reintroduces a bare `scripts/…` path under curl is caught cheaply,
  without drawing on the rate-limited e2e sandbox (§req:sandbox-ci-budget).

## doctor.sh curl-mode script references user stories §req:doctor-curl-script-refs-stories

- As an adopter validating my repo with the documented
  `curl …/doctor.sh | bash`, when doctor flags a missing ruleset I want the
  fix-it command to be one I can paste right then and there, so I am not told
  to run a `scripts/apply-rulesets.sh` that does not exist on my machine.
- As an adopter who cloned flywheel and runs `./scripts/doctor.sh`, I want the
  remediation to keep showing the local script path, so the instruction matches
  how I actually invoke things and I am not pushed to re-download a script I
  already have.
- As an adopter, I want the suggested fix command to already include the flags
  the script needs — like `apply-rulesets.sh`'s `--app-id` — so that pasting it
  actually applies the fix rather than failing on a missing argument and
  sending me back to the docs.
- As an adopter running a version-pinned flywheel, I want the curl command
  doctor prints to fetch the matching version of the fix script, so I do not
  apply a `main` script that disagrees with the doctor I am running.
- As a flywheel maintainer, I want every script reference doctor prints to be
  safe in both invocation modes, so no finding ever leaves an adopter holding
  an instruction they cannot follow.

## doctor.sh curl-mode script references quality attributes and constraints §req:doctor-curl-script-refs-constraints

- **Guidance-only change.** doctor stays read-only and its contract is
  untouched: same exit codes, same severity buckets, same finding vocabulary,
  same set of findings on a given repo. Only the human-readable remediation
  text changes. The fix cannot alter what doctor *detects* — only what it
  *advises*.
- **One invocation-mode detector.** The local-vs-curl decision reuses the seam
  doctor already has for locating `findings.sh` and the linter (the presence of
  its on-disk siblings), rather than introducing a second, independently-drifting
  notion of "am I running from disk or from curl." There is one source of truth
  for invocation mode.
- **Version-consistent fix URLs.** When a message emits a curl form, its URL
  resolves against the same ref doctor resolved itself from
  (`FLYWHEEL_TEMPLATES_BASE` / the pinned consumer ref, defaulting to `main`),
  so a pinned adopter is pointed at the matching script. A message shall not
  hard-code `main` when doctor itself was fetched from a pin.
- **Placeholder honesty.** Where doctor cannot know an argument's value — the
  App ID above all — the emitted command uses an obvious placeholder consistent
  with the form already shown in `docs/adopter/setup.md`
  (`--app-id <your-app-id>`), never a fabricated value or a silent omission.
  Where doctor *does* know a value (`$REPO`), it substitutes it.
- **Scope is doctor's messages.** The change is confined to the remediation
  strings doctor prints; it does not modify `apply-rulesets.sh` or `init.sh`
  themselves, nor the adopter docs (which already document the curl forms).
- **Cheap coverage.** The behavior is pinned by a fast local/CI test, not the
  e2e sandbox (§req:sandbox-ci-budget); e2e stays a backstop, not the first
  line of defense for a wording regression.
- **Priority.** Low-severity, adopter-facing correctness of guidance, and
  self-contained. No release breaks and no adopter is hard-blocked — but an
  adopter who hits a finding on the documented curl path is handed an
  instruction they cannot follow, in the one tool whose purpose is to tell them
  how to fix their setup, so the cost is paid precisely at the moment of
  greatest confusion. It ranks below the release- and major-breaking failures
  in this document (§req:release-safety-gate, §req:composite-action-path) and
  sits with the other onboarding-friction fixes in the setup cluster. In
  decreasing order of user impact: (1) make every remediation runnable in the
  curl mode adopters actually use; (2) keep the local-checkout form correct for
  maintainers; (3) complete the suggested commands so a paste applies the fix.

## init.sh preset wording §req:init-preset-wording

The very first decision `scripts/init.sh` asks an adopter to make is the
one it explains worst. Interactive setup prints a three-line preset menu and
waits for a 1/2/3 choice:

```text
1) minimal       — single stream, single branch (releases on every push to main)
2) three-stage   — develop → staging → main with promotion PRs
3) multi-stream  — main-line + a customer-acme variant
```

Option 3's description is written for someone who already knows the answer.
"main-line + a customer-acme variant" names two things — `main-line` and
`customer-acme` — that mean nothing to a first-time adopter. `customer-acme`
is a placeholder branch name lifted straight out of the bundled
`flywheel.multi-stream.yml` template; it has leaked from an internal example
into user-facing copy, so the menu reads as if "acme" were a flywheel
concept the adopter is expected to recognise. Worse, the line never says
what the preset is *for*: nothing on it explains that `multi-stream` stands
up two independent release lines that each cut their own prereleases with
their own version suffix and auto-merge rules. An adopter staring at the
menu cannot tell whether option 3 is what they want, because the words on it
describe a shape ("main-line + a variant") rather than a purpose ("you ship
more than one release line in parallel").

The friction is sharpest exactly where it is least recoverable: at the menu,
before the adopter has read any docs, with a default of 1 one keystroke away.
Faced with a choice they cannot parse, an adopter either picks `minimal` to
be safe — and discovers later they needed parallel streams — or picks
`multi-stream` on a guess and gets a second `customer-acme` branch they did
not ask for and now have to rename or tear out. Options 1 and 2 are clearer
but not immune: "single stream, single branch" and "promotion PRs" still lean
on flywheel vocabulary the adopter is meeting for the first time on this very
screen.

The same `customer-acme` placeholder and the same unexplained framing recur
beyond the interactive menu — in the `--preset` validation/usage text that
lists the same three names, and in the adopter-facing docs (`README.md`,
`docs/adopter/setup.md`) that describe the presets. An adopter who pipes
`init.sh` non-interactively and has to pass `--preset` by hand, or who reads
the docs before running anything, meets the same opaque vocabulary in every
place the presets are named.

The users are first-time adopters choosing a preset — interactively at the
menu, or by hand via `--preset` — plus anyone reading the setup docs to
decide before they run. The multi-stream preset itself originated for
**per-customer forks** (a vendor maintaining a client-specific release line
beside the main product), but it serves any case that needs two or more
independent release lines: long-term-support branches, region-specific
builds, white-label variants. The menu hides all of that behind one
customer's example name.

This is the opening item of the setup-onboarding cluster (#234–242): the
literal first prompt of the first-run experience. It is pure first-run
friction, not a release-correctness fault — every preset still works once
chosen — but it is frequent (every adoption hits it), mandatory (no adopter
skips the preset choice), and it sets the tone for everything the
§req:preflight-detection and §req:setup-completion-summary work later in the
run tries to make clear. If the adopter's *first* screen speaks insider
jargon, the polish downstream starts from a deficit.

## init.sh preset wording success criteria §req:init-preset-wording-criteria

- A **first-time adopter can pick the right preset from the menu line
  alone**, without opening docs or reading the template files. Each option's
  one-liner states what the preset is *for* in plain terms, so the choice is
  self-evident at the prompt.
- **Option 3 says what a multi-stream setup does**: that it maintains two (or
  more) independent release lines in parallel, each shipping its own
  prereleases — not just "main-line + a variant." A reader who has never seen
  flywheel can tell from the line what they would get and when they would want
  it.
- The menu line for option 3 carries **no undefined jargon** — in particular,
  `customer-acme` no longer appears in the menu as if it were a flywheel
  concept. The concept is described generically (a second, independent release
  line); the concrete per-customer "acme" example survives only where it has
  room to be explained — in the bundled template and the adopter docs.
- The **preset identifiers are unchanged**: `minimal`, `three-stage`, and
  `multi-stream` remain the exact strings `--preset` accepts. Only the
  human-readable descriptions are reworded, so existing `--preset` invocations,
  scripts, docs, and muscle memory keep working.
- The clarified wording is **consistent everywhere the presets are named** —
  the interactive menu, the `--preset` validation/usage text, and the
  adopter-facing docs (`README.md`, `docs/adopter/setup.md`) tell the same
  story about each preset, so an adopter meets one explanation no matter which
  surface they hit first.
- Options 1 and 2 are **reviewed for the same plain-language bar** and reworded
  where they lean on unexplained flywheel vocabulary, so the clarity is not
  limited to option 3 while the rest of the menu stays opaque.
- The concrete **per-customer / LTS / regional use cases** that motivate
  multi-stream are findable by an adopter who wants more than the menu line —
  surfaced in the docs where the preset is described — so "when would I choose
  this?" has an answer beyond the one-liner.

## init.sh preset wording user stories §req:init-preset-wording-stories

- As a first-time adopter at the preset menu, I want each option to tell me
  what it is *for* in plain words, so I can choose the right one without
  leaving the prompt to go read documentation.
- As an adopter who needs parallel release lines, I want option 3 to say it
  maintains two independent release streams, so I recognise it as what I want
  instead of guessing or defaulting to `minimal` and finding out too late.
- As a first-time adopter, I do not want to see `customer-acme` presented as a
  flywheel concept I am supposed to understand, so I am not left wondering who
  "acme" is or whether it applies to me.
- As an adopter passing `--preset` non-interactively, I want the usage/help
  text to explain the presets the same way the menu does, so I am not handed a
  bare list of names with no guidance on which to pick.
- As an adopter reading `docs/adopter/setup.md` or the README before I run
  anything, I want the preset descriptions there to match the menu and to give
  me a concrete example of when multi-stream applies (a customer fork, an LTS
  line, a regional build), so I can decide before I start.
- As an existing adopter with `--preset multi-stream` already wired into a
  script, I want that flag to keep working unchanged, so clarifying the wording
  does not break my setup.

## init.sh preset wording quality attributes and constraints §req:init-preset-wording-constraints

- **Self-evident at the prompt.** The bar is that the menu line alone is
  enough to choose correctly — clarity is measured at the point of decision,
  not in docs the adopter may never open. Copy that is only clear *after*
  reading the spec does not meet it.
- **Concept over example.** The menu describes multi-stream by its purpose (two
  independent release lines in parallel), not by one customer's branch name.
  The concrete "acme" example is retained only where there is space to frame it
  as an example — the template and the docs — never as bare, unexplained menu
  text.
- **Identifiers are a stable contract.** `minimal`, `three-stage`, and
  `multi-stream` are the strings `--preset` accepts and are referenced across
  docs, scripts, and adopters' own automation; the rewrite touches descriptions
  only and must not rename them.
- **One explanation, every surface.** The menu, the `--preset` help/validation
  text, and the adopter docs must not drift into three different descriptions
  of the same preset. The cluster's "one vocabulary, end to end" principle
  (§req:setup-completion-summary) applies here too: the adopter meets a single,
  consistent account of each preset.
- **Documentation must still parse.** Any `.flywheel.yml` example shown while
  clarifying the preset docs remains a valid config an adopter can copy
  verbatim — the documented snippets stay loadable, per the repo's
  docs-examples guarantee.
- **Copy-only, behaviour-unchanged.** Reword the descriptions; do not change
  which `.flywheel.yml` each preset writes or how `init.sh` behaves. A run that
  chose a given preset before the change produces the same configuration after
  it.
- **Priority.** Adopter-facing and on the documented onboarding path, and
  literally the first decision of the first run — but pure wording, with no
  release or correctness consequence, so it ranks below every requirement that
  protects releases or the v2 major (§req:release-safety-gate,
  §req:composite-action-path) and below the detection spine the rest of the
  setup cluster depends on (§req:preflight-detection). It is a low-risk,
  high-visibility polish item: cheap to land, disproportionately shaping the
  adopter's first impression. In decreasing order of user impact: (1) rewrite
  option 3 so multi-stream's purpose is plain and `customer-acme` no longer
  reads as jargon; (2) extend the same clarity to the `--preset` help text and
  the adopter docs so every surface agrees; (3) review options 1 and 2 to the
  same plain-language bar.

## init.sh GitHub-App step §req:app-step-clarify

After choosing a preset, the next thing `scripts/init.sh` asks an adopter to
do is the step that most often stalls a first run: standing up the credential
the flywheel workflows use to act on the repo. Interactive setup prints

```text
  Flywheel needs a GitHub App for installation tokens. Pick a setup path:
    1) Create the App for me  — opens browser, ~30s round-trip
    2) I have an App already — paste credentials manually
    3) Skip — I'll set the App credentials later
```

and waits for a 1/2/3 choice. The line speaks in mechanism, not need.
"installation tokens" is GitHub-internals jargon — an adopter who has never
built a GitHub App has no idea what an installation token is, why flywheel
needs one, or what they are agreeing to by picking option 1. The prompt
never says **what the App is allowed to do** (which permissions it will
hold), **how long it sticks around** (it is a permanent dependency, not an
install-time scaffold), or **why an App rather than something simpler** like
a personal access token the adopter may already have. The adopter is asked to
create or paste a credential whose purpose, scope, and lifetime are all
unstated.

The step also assumes a blank slate. By the time this prompt appears,
flywheel's own pre-flight pass (§req:preflight-detection) has *already* looked
up the App credentials — it reads `FLYWHEEL_GH_APP_ID` and
`FLYWHEEL_GH_APP_PRIVATE_KEY` at both repo and org level, recovers the numeric
App ID when it can, and even checks whether an org-level App is actually
installed on the owner. Yet the App step throws most of that away. It honours
only the all-or-nothing case (both credentials already present at the same
level → "already set", skip). Every partial or org-level state falls through
to the same cold menu: an adopter who already has the App ID set as an org
variable, or who has an App installed org-wide but not yet on this repo, is
asked to "paste credentials manually" for an App the tooling already knows
about. Option 2 in particular ignores what pre-flight found and demands a
fresh paste of values that may already be one variable lookup away.

The sharpest of the ignored states is **an App that exists but is not
installed where it needs to be**. Pre-flight emits a warning when it finds an
org-level App ID that does not appear in the owner's installation list, but
the App step itself does nothing with that knowledge — it offers "create" or
"paste", neither of which is the actual fix. The adopter whose org already has
a flywheel App just needs to *install it on this repo*, and the one action
that would resolve their situation is the one the menu does not offer. They
either create a redundant second App or paste credentials for an App that
still cannot mint tokens for this repo, and discover the gap only when the
first workflow run fails.

The users are the adopter wiring flywheel into a repo — greenfield, where
"create the App for me" is the right path, and retrofit, where an App or its
credentials frequently already exist somewhere in the org — and the
maintainer who owns the setup tooling. The problem is frequent (every
adoption reaches this step), mandatory (no workflow runs without the
credential), and it is where a first run most often ends in a half-configured
repo: a created-but-uninstalled App, a pasted key with no matching
installation, or an abandoned "skip" the adopter never comes back to.

This is the credential-prompt item of the setup-onboarding cluster
(#234–242). It sits directly on the detection spine built once in
§req:preflight-detection — it consumes that pass's App-ID, credential, and
installation findings rather than re-probing — and it shares the cluster's
"one vocabulary, end to end" goal with §req:setup-completion-summary and the
plain-language bar set by §req:init-preset-wording.

## init.sh GitHub-App step success criteria §req:app-step-clarify-criteria

- The App step **explains the credential in terms of need, not mechanism**.
  Before asking the adopter to choose, the copy says what the App is *for*
  (it lets the flywheel workflows act on the repo as a bot — push releases,
  open and merge promotion PRs, apply labels) and **which permissions** that
  requires, in place of the bare phrase "installation tokens". A first-time
  adopter can tell what they are granting without already knowing how GitHub
  Apps work.
- The copy **states that the App is a permanent dependency**, used on every
  workflow run for the life of the adoption — not a one-time install artifact
  — so an adopter does not later delete it as setup leftovers. It also says,
  in brief, **what changing it later looks like** (the credential can be
  rotated or the App revoked), so the adopter understands this is an ongoing
  thing they own.
- The copy **says why a GitHub App and not a personal access token**, in one
  or two plain sentences, so an adopter who wonders "couldn't I just use a
  PAT?" gets an answer at the prompt instead of guessing. A PAT path is **not**
  offered.
- When pre-flight has **already detected an existing App or its credentials**,
  the App step **reflects that at the prompt** rather than starting cold. The
  detected App (by ID, and the level — repo or org — it was found at) is shown
  and offered as the default, so the adopter confirms or overrides what the
  tooling already found instead of being asked to supply it from scratch.
- The "I have an App already" path **reuses what pre-flight found** instead of
  demanding a manual paste of credentials the tooling can already see. The
  adopter is asked only for what is genuinely missing, not to re-enter values
  already present as a variable or secret.
- When an App **exists at the org level but is not installed on this repo**,
  the App step **surfaces that specific state and offers the action that
  fixes it** — installing the existing App here — rather than only "create" or
  "paste". The adopter whose org already has a flywheel App is routed to
  install it, not to create a duplicate.
- The clarified credential framing is **consistent with how the rest of setup
  and doctor speak** — same names for the App ID and key, same bucket/severity
  vocabulary (§req:preflight-detection) — so the adopter meets one account of
  the App credential across pre-flight, this prompt, the completion summary,
  and doctor.
- The **credential identifiers and behaviour are unchanged**:
  `FLYWHEEL_GH_APP_ID` (variable) and `FLYWHEEL_GH_APP_PRIVATE_KEY` (secret)
  remain the names workflows read, and a run that produced working credentials
  before the change still produces them after. The change is to the copy and
  to how detected state is consumed, not to what gets written.

## init.sh GitHub-App step user stories §req:app-step-clarify-stories

- As a first-time adopter at the App step, I want the prompt to tell me what
  the App is allowed to do and why flywheel needs it, so I can decide to create
  it without first learning how GitHub Apps and installation tokens work.
- As an adopter weighing the choice, I want to know the App is a permanent part
  of my setup and roughly what rotating or revoking it later involves, so I
  treat it as infrastructure I own rather than setup debris I might delete.
- As an adopter who already manages a personal access token, I want the prompt
  to say why flywheel uses an App instead of a PAT, so I am not left wondering
  whether I am being made to do unnecessary work.
- As an adopter whose org already has the App ID or key configured, I want the
  step to show me what it already found and let me confirm it, so I am not
  asked to paste credentials the tooling can already see.
- As an adopter who picks "I have an App already", I want setup to fill in the
  parts it already detected and ask me only for what is missing, so I am not
  re-entering values that are already set.
- As an adopter whose org has a flywheel App that is not installed on this
  repo, I want the step to recognise that and offer to install it here, so I
  fix the real gap instead of creating a second App or pasting a key that still
  cannot mint tokens for my repo.

## init.sh GitHub-App step quality attributes and constraints §req:app-step-clarify-constraints

- **Need before mechanism.** The prompt is judged by whether a first-time
  adopter can decide from it alone — what the App does, what it can access, how
  long it lives — without prior GitHub-App knowledge. Copy that only makes
  sense to someone who already understands installation tokens does not meet
  the bar.
- **A PAT is not a viable substitute for this tool, and the copy must be able
  to say why briefly.** Flywheel adds the App to its branch/tag rulesets as a
  bypass actor of type *Integration* so the bot can push releases and tags to
  protected branches; only a GitHub App can be that kind of bypass actor, so a
  PAT cannot stand in. A PAT would also tie the automation to one human's
  account and rate limit, run as that person rather than a bot in the audit
  trail, and live as a long-lived, manually rotated secret instead of a
  short-lived token minted per run. This is the rationale the prompt
  summarises; it is also the reason no PAT path is built.
- **Consume detection, do not re-probe.** The step reads the App-ID,
  credential, and installation findings the pre-flight pass
  (§req:preflight-detection) already produced rather than issuing its own
  duplicate `gh` lookups. Detection is built once on the spine and consumed
  here.
- **Show what is detected; let the adopter override.** Detected state is a
  default to confirm, never a silent decision. An adopter can always override
  what pre-flight found — the detection informs the prompt, it does not replace
  the adopter's choice.
- **One vocabulary, every surface.** The App credential is named and described
  the same way across pre-flight, this prompt, the completion summary
  (§req:setup-completion-summary), and doctor — the cluster's end-to-end
  consistency goal applies here as it does to the preset wording
  (§req:init-preset-wording).
- **Identifiers and outcomes are a stable contract.** `FLYWHEEL_GH_APP_ID` and
  `FLYWHEEL_GH_APP_PRIVATE_KEY` are the strings the action and workflows read;
  the change reworks copy and detection handling only and must not rename them
  or alter which credentials a successful run leaves behind.
- **Non-interactive and piped runs keep working.** The clarified step degrades
  the same way the current one does on a non-interactive shell or a
  `curl … | bash` invocation — it prints the manual finish command rather than
  blocking on a prompt — so the new detection-aware copy does not regress
  scripted adoption.
- **Priority.** Adopter-facing and on the documented onboarding path, and the
  step where a first run most often stalls with a half-configured credential —
  so it ranks above the pure-wording polish of §req:init-preset-wording but,
  like the rest of the setup cluster, below the requirements that protect
  releases or the v2 major (§req:release-safety-gate,
  §req:composite-action-path) and below the detection spine it depends on
  (§req:preflight-detection). In decreasing order of user impact: (1) replace
  the "installation tokens" framing with permission-, lifetime-, and
  why-an-App copy so the choice is informed; (2) consume pre-flight's detected
  App and credentials so existing-App adopters confirm rather than re-paste;
  (3) surface the org-App-not-installed-here state and offer to install it,
  closing the one gap that today's create/paste menu cannot.

## doctor.sh credential-check clarity §req:doctor-credential-clarity

`scripts/doctor.sh` is the read-only validator an adopter runs to confirm a
repository is correctly wired for flywheel. Under "App-token credentials" it
checks that the two values flywheel runs on are present: `FLYWHEEL_GH_APP_ID`
(a repository or org **Variable**) and `FLYWHEEL_GH_APP_PRIVATE_KEY` (a
repository or org **Secret**). To check them, doctor lists the repo's
Variables and Secrets via `gh api` and looks for those names.

Listing Variables and Secrets requires an **admin PAT**: GitHub App
installation tokens are categorically forbidden from reading Variables or
Secrets, regardless of the permissions granted to the App, and a plain
`gh auth login` token without admin scope cannot list them either. So the
*common* local case — an adopter who authenticated `gh` with an ordinary
account, or who is running doctor from a context holding an App token — cannot
perform this check at all. doctor already detects this: the list call fails and
doctor knows it could not read, as distinct from reading an empty list. But it
then reports that could-not-read as a hard **FAIL** ("could not list repo
variables — listing requires an admin PAT…"). A FAIL drives doctor's exit code
to 1, and the credentials section is the visually prominent block where an
adopter looks to confirm flywheel is set up. The combined signal an adopter
takes away is "flywheel's credentials are broken" — when the truth is "doctor,
from this machine with this token, simply cannot see them." The credentials may
be perfectly configured at the org or repo level; doctor just lacks the scope to
look.

Two things are wrong with that, and they are the two levers #237 names. First,
the **severity is miscast**: a can't-verify-from-here condition is a limit on
the adopter's local token, not a defect in the repository's configuration, so it
should not fail the run or read as a fault. This is exactly the conflation
§req:doctor-settings-read fixed for the repo-settings block — could-not-verify
is a third state, distinct from "present" and "missing," and belongs at warn,
not fail. The credential block already *distinguishes* could-not-list from
absent (the hard part settings-read had to add); it just files the former at the
wrong severity. Second, the **messaging is silent on consequence**: nowhere does
doctor say that a skipped or unverifiable credential check does not mean flywheel
won't work — it only means doctor could not verify that one area. An adopter is
left to infer the worst.

The original issue paired this messaging fix with a *behavior* lever — making
credential checks opt-out-by-default and adding a flag to run them. That lever is
**deliberately not taken here**: credential checks continue to run by default,
the existing `--skip-credentials` flag (used by CI flows that already minted an
App token, where the mint itself is the credential proof) keeps its current
meaning, and no new opt-in flag is introduced. The friction the issue describes
is resolved by making the unverifiable case read correctly — a non-fatal "could
not verify from here, and that's fine" — rather than by hiding the check. Keeping
it on by default means an adopter who *does* hold an admin token still gets the
genuine missing-credential FAIL with no extra ceremony.

The genuine failure still exists and still matters: when the token *can* list
(an admin PAT) and the Variable or Secret is truly absent, that is a real
misconfiguration flywheel cannot run without, and it stays a FAIL with its
existing remediation. The point is to fail only when doctor actually established
the credential is missing — never merely because it could not look.

The users are the adopter validating their setup with whatever token `gh`
happens to hold, and the flywheel maintainer who owns doctor. The problem is
frequent (most local runs are not made with an admin PAT), self-inflicted (a
reporting-severity bug, not a release fault), and corrosive: nothing is broken,
but a green-on-the-repo setup is reported red and the adopter is told their
credentials are wrong when they are not. It sits in the setup-onboarding cluster
(#234–242) and reuses the bucket × severity vocabulary established by
§req:preflight-detection and applied to doctor by §req:doctor-settings-read.

## doctor.sh credential-check clarity success criteria §req:doctor-credential-clarity-criteria

- An adopter who runs doctor with a token that **cannot list** Variables/Secrets
  (an ordinary `gh auth login` account, or an App installation token) sees a
  **could-not-verify** finding for each of `FLYWHEEL_GH_APP_ID` and
  `FLYWHEEL_GH_APP_PRIVATE_KEY` — never a "missing" claim and never a FAIL. The
  finding states plainly that verifying these requires an admin PAT and that this
  is a limit on the local token, not a defect in the repo.
- That could-not-verify finding **does not drive doctor's exit code to 1**: with
  no genuine block present, doctor exits 0, so an under-scoped local run no longer
  reports the repository as broken.
- doctor makes unmistakable, in the credentials block, that a **skipped or
  unverifiable credential check does not mean flywheel won't work** — it means
  only that doctor could not verify that area from here. This reassurance is
  present wherever the credential check ends in anything other than a confirmed
  pass (the could-not-verify case and the existing `--skip-credentials` skip
  note).
- When the token **can list** and the Variable or Secret is **genuinely absent**,
  doctor still reports a **FAIL** with the existing remediation guidance (the
  `gh variable set` / secret-set instructions). The real-misconfiguration case is
  unchanged — doctor fails only when it has actually established the credential is
  missing.
- When the token can list and both values are present (at repo or org level),
  doctor reports them OK exactly as today, including the source annotation
  ("repo" / "org (all|private|selected)").
- Credential checks **continue to run by default**. The `--skip-credentials` flag
  keeps its current meaning — skip the checks, caller verifies out of band — and
  its skip note carries the same "does not mean flywheel won't work" framing. No
  new flag is added to opt into or out of the checks.
- The distinct credential states an adopter can land in — verified-present,
  skipped, could-not-verify, genuinely-missing — are each reported in language
  that tells them apart at a glance, so no two states read the same.
- A fast local test exercises the could-not-verify path — doctor run against a
  list call that fails reports "could not verify" at warn and exits 0, not FAIL —
  so this severity regression cannot silently return. The test needs no live
  GitHub access and adds no load to the rate-limited sandbox installation
  (§req:sandbox-ci-budget).

## doctor.sh credential-check clarity user stories §req:doctor-credential-clarity-stories

- As an adopter running `doctor.sh` with an ordinary `gh` login (no admin PAT), I
  want doctor to tell me it couldn't verify the App credentials from here rather
  than fail and imply they're missing, so I don't go chasing a setup problem that
  doesn't exist.
- As an adopter whose credentials are correctly set at the org level, I want an
  under-scoped local run to come back clean (exit 0), so a passing repo isn't
  reported as broken just because my local token can't see org Secrets.
- As an adopter reading the credentials block, I want it to say outright that a
  check doctor couldn't run does not mean flywheel won't work, so I understand a
  could-not-verify line is a visibility limit, not a verdict on my repo.
- As an adopter who *does* hold an admin PAT and is genuinely missing a Variable
  or Secret, I want doctor to still FAIL and tell me exactly how to set it, so the
  real misconfiguration is caught with no loss of guidance.
- As a CI maintainer whose flow already minted an App token, I want
  `--skip-credentials` to keep skipping the checks exactly as before, so this
  change doesn't disturb pipelines that already prove the credentials by using
  them.
- As a flywheel maintainer, I want the credential block to file could-not-verify
  at warn — the same three-state, same-severity treatment §req:doctor-settings-read
  gave the repo-settings block — so doctor speaks one consistent language about
  what it can and cannot confirm.

## doctor.sh credential-check clarity quality attributes and constraints §req:doctor-credential-clarity-constraints

- **Could-not-verify is warn, not fail.** A list call that fails for lack of
  scope is a local-env condition at warn severity, never a block. doctor fails on
  credentials only when it successfully listed and the value is truly absent.
- **Three states, kept distinct.** present / missing / could-not-verify are
  reported as three different outcomes; an inability to look is never collapsed
  into "missing." This mirrors §req:doctor-settings-read; here the distinction
  already exists in the code and only the severity and wording change.
- **One vocabulary.** Findings use the bucket × severity vocabulary from
  §req:preflight-detection: a genuinely-missing credential is config + fail (a
  block); a could-not-verify credential is local-env + warn. No new severity or
  bucket names are introduced.
- **Reassurance is explicit, not implied.** The "a skipped or unverifiable check
  does not mean flywheel won't work" message is stated in the output, not left for
  the adopter to infer from the absence of a FAIL.
- **Behavior is unchanged except severity and wording.** Checks still run by
  default; `--skip-credentials` keeps its meaning; no new flag is added; the set
  of values checked and where they may live (repo or org Variable/Secret) is
  unchanged. The original issue's opt-in-by-default lever is intentionally not
  taken — see §req:doctor-credential-clarity for why.
- **Exit contract preserved.** doctor stays read-only and exits 1 only when a
  block-severity finding is present, 0 otherwise (§req:preflight-detection-criteria).
  The change removes a false block; it adds none.
- **No new privilege.** doctor requests no additional scopes. The whole point is
  to behave correctly precisely when the local token is under-scoped — not to
  demand a stronger one.
- **Low blast radius.** The change is confined to doctor.sh's App-token
  credentials block — its severity for the can't-list case and the wording of the
  could-not-verify, skip, and missing findings. It does not touch how flywheel
  itself reads credentials at run time, init.sh's invocation of doctor
  (out of scope for #237), or any release behavior.
- **Cheap coverage only.** The regression test lives in the fast local/CI suite
  and does not draw on the e2e sandbox's rate-limited installation
  (§req:sandbox-ci-budget).
- **Priority.** Low-severity, self-contained onboarding correctness, and a direct
  sibling of §req:doctor-settings-read — same defect class (a permission gap
  mis-reported as a fault), same fix shape (reconcile to warn + clearer wording).
  Nothing breaks and no release is at risk, so it does not outrank the
  release-safety (§req:release-safety-gate), composite-action
  (§req:composite-action-path), or stdin (§req:apply-rulesets-stdin) work. It is
  nonetheless a real trust-eroder — doctor reports correctly-configured repos as
  broken to the majority of local runs — and cheap: a severity change, four
  reworded findings, and one local test.
