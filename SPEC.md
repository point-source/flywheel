# flywheel — Specification

## Overview §spec:overview

*Status: not started*

<!-- Describe the desired behavior of this section. -->

## Action version lockstep §spec:action-version-lockstep

*Status: in progress*

Flywheel runs as adopter-side CI: an adopter's repository invokes flywheel
on its `pull_request` and `push` events. Every part of flywheel an adopter
runs — the dispatch logic, the release scripts, the `semantic-release`
invocation — comes from a version the adopter chose, and choosing that
version is a single act. The adopter pins flywheel at one git ref, and
every flywheel file that runs comes from that ref.

Flywheel is distributed as a single composite GitHub Action, referenced
directly from an adopter's workflow job:

```yaml
jobs:
  conduct:
    runs-on: ubuntu-latest
    steps:
      - uses: point-source/flywheel@v1
        with:
          event: pull_request
          app-id: ${{ vars.FLYWHEEL_GH_APP_ID }}
          app-private-key: ${{ secrets.FLYWHEEL_GH_APP_PRIVATE_KEY }}
```

The `@<ref>` on that line is the only version-control surface:

- Pinning a major (`@v1`) runs the latest release within that major; the
  floating major tag is advanced automatically on every release.
- Pinning an exact version (`@v1.2.3`) runs exactly that release.

Either way GitHub resolves the ref and places flywheel's repository on the
runner at that ref before any step executes. The composite action's
JavaScript core, its `scripts/`, and its `semantic-release` configuration
are therefore all at the pinned version by construction. There is no second
version input, no ref derived at runtime, and no file that records or
rewrites a version.

**Internal structure.** The root `action.yml` is a composite action. Its
steps check out the adopter's repository, run the dispatch logic as a
nested JavaScript action (`uses: ./core`), and — on push events — run
`semantic-release` and the release scripts. Inside a composite action
`./core` resolves against flywheel's own checkout at the pinned ref, and
`github.action_path` locates the bundled `scripts/`; both inherit the
adopter's chosen version with no plumbing. The `scripts_dir` output that
the reusable push workflow needed (#134) is therefore unnecessary.

**Why a single composite action.** A reusable workflow cannot determine the
ref it was pinned at: GitHub resolves `github.workflow_ref` from the
workflow that *triggered the run*, never from a reusable workflow it calls,
and exposes no other context for a reusable workflow's own pin. Any design
that keeps a reusable-workflow layer shall therefore derive that ref
(impossible to do correctly) or carry the version a second time. A
composite action invoked directly by the adopter has no such layer — GitHub
performs the version resolution as part of `uses:`. Removing the reusable
workflow removes the only component that cannot name itself, and with it
the entire failure class.

**Alternatives rejected.**

- *Release-time rewrite* (#172): a `release_files` rule rewrote the action
  ref inside the reusable workflows on every release. GitHub blocks an App
  token from modifying `.github/workflows/*.yml` without the
  `workflows: write` scope, which Flywheel's App does not hold — releases
  failed (GH013, #178).

- *Runtime ref derivation* (#180): a step parsed `GITHUB_WORKFLOW_REF` to
  recover the pin. That variable holds the caller's ref, so the action
  checkout targeted a ref absent from `point-source/flywheel` and failed
  for every non-default-branch caller (#183).

- *Caller-supplied version input*: keep the reusable workflows and add an
  optional input carrying the action ref. This resolves the checkout
  failure, but leaves two version surfaces on the caller (the workflow pin
  and the input) that can drift, and a hardcoded major literal in each
  reusable workflow that a maintainer shall bump per major release. It is
  sound as an interim measure (see *Interim delivery*) but is rejected as
  the end state: it does not remove the reusable-workflow layer that causes
  the problem.

Both #172 and #180 tried to make a reusable workflow name its own
version. The composite action does not need to — the adopter names it
once, and GitHub resolves it.

**Interim delivery.** #183 is a live defect on the `v1` reusable workflows.
The composite-action design is a breaking change and ships as flywheel v2;
until it does, the caller-supplied version input ships as a non-breaking
`v1` release so current adopters are not left with failing checkouts. The
interim input and the reusable workflows are removed when v2 lands.

**Tradeoffs accepted.**

- The composite-action caller is a few lines longer than a reusable-workflow
  caller (`runs-on`, `steps`), and migrating to it is a breaking change —
  every adopter updates its caller workflows once. Accepted: it ships as a
  deliberate v2, and in exchange the failure class (#166, #172, #178, #180,
  #183) becomes structurally impossible — no version literal exists anywhere
  in flywheel, so there is nothing for a maintainer to keep in sync.

- A composite action cannot declare `concurrency`; it lives in the adopter's
  caller workflow, where the scaffolded template places it. Flywheel can no
  longer change the concurrency strategy centrally. Accepted: the strategy
  is stable and is reasonably an adopter concern.

**Security.** The composite action runs inside the adopter's workflow and
checks out the adopter's repository — the trust position flywheel already
holds. It mints its own GitHub App installation token from
adopter-supplied credentials. The adopter's chosen `@<ref>` is the sole
determinant of which flywheel code runs, which is the property this design
exists to guarantee.

## Immutable release support §spec:immutable-release-support

*Status: complete*

GitHub immutable releases freeze a release's git tag and attached assets
the moment the release is published — afterward they cannot be added,
modified, or deleted. `@semantic-release/github` creates *and publishes*
the release in one step; an adopter whose build attaches a compiled
artifact does so from a separate workflow triggered by that release, i.e.
*after* publication. On an immutability-enabled repo the upload is
rejected and the pipeline fails. This section lets flywheel hand such a
build a release it can still attach to, on the branches where that
handoff is needed and nowhere else. §req:problem-statement

**Opt-in, per branch.** `.flywheel.yml` accepts `release_as_draft` as a
per-branch boolean, valid on any branch whose `release` is `prerelease`
or `production`; setting it on a `release: none` branch, or setting it
to a non-boolean value, is a configuration error. Default is `false`.
The decision is declared, never inferred: flywheel cannot read the
adopter's build workflow to learn whether it attaches an asset, and a
repository merely having immutable releases enabled does not imply its
releases carry assets — no signal available to flywheel answers the
question, so the adopter states the intent explicitly. §req:constraints

**Why per-branch scope.** GitHub's immutable-releases setting and
flywheel's `release_as_draft` describe different things. GitHub's
setting governs whether a *published* release's tag and assets are
frozen; flywheel's setting governs *who performs the publish step* —
semantic-release immediately, or the adopter's build after attaching
an artifact. Any combination produces a release shape GitHub honors.
Because the publishing decision varies per release branch (one branch
attaches a binary, another attaches nothing), the configuration surface
varies at the same scope. A repo-wide flag forces every release branch
onto the draft path the moment any single branch needs it, which in
turn forces a publish-trigger workflow on branches whose releases
attach no artifact — the concrete friction this scope exists to remove.
§req:problem-statement §req:constraints

**Observable behavior.** For each opt-in branch, semantic-release creates
the GitHub Release as an unpublished draft instead of publishing it; the
release tag is still created and pushed. For every other branch the
release publishes immediately, with no change from the default. An
adopter who has not opted in on a branch observes no change on that
branch whatsoever, even when other branches in the same repository are
opted in. §req:success-criteria

`@semantic-release/github` stays in the plugin chain: it still generates
release notes, posts released-in comments, and produces the release
object the build attaches to. `draftRelease` is the single deviation
from the plugin's defaults. Tag creation, the changelog commit, the
release-body @-mention sanitizer, and the back-merge step are all
independent of the release object's published state — they are branch
and tag operations, or edits to a still-mutable draft body.

**Concurrency.** semantic-release derives the next version from git
tags, never from GitHub Release objects. Because the tag is created and
pushed on every release run irrespective of `draftRelease`, releases cut
in quick succession compute correct, monotonic versions even while
earlier releases remain unpublished drafts — and this holds whether the
concurrent releases come from one branch or from a mix of draft and
immediate-publish branches in the same repository. The draft state of a
release object is invisible to version computation.
§req:success-criteria

**Handoff to the adopter's build.** flywheel's responsibility ends when
the draft release exists. The adopter's build owns attaching the
artifact and publishing the draft; publishing is the act that makes the
release immutable, and the build is the only actor that knows the
artifact is attached. flywheel does not track, wait on, or publish the
draft itself — it stays stateless. §req:quality-attributes

A build that shall attach an asset *before* publication cannot be
triggered by the `release` event: GitHub does not fire `release` events
for draft releases. The reliable pre-publication signal is the release
tag push. An opt-in branch's build therefore triggers on `push:` of
that branch's release tags, looks the draft up by tag name, uploads its
artifact, and publishes the draft as its final step.
`docs/adopter/setup.md` documents this build shape, and the
immediate-publish shape, side by side; a single mixed-mode repository
runs both, one per branch.

**flywheel's own releases.** flywheel ships no release assets — it's
distributed as an action pinned by git ref, with `dist/` committed —
so the default immediate-publish path is immutable-safe regardless.
The `develop` branch takes that default path. The `main` branch sets
`release_as_draft: true` for an internal CI-gating reason unrelated to
immutability: see §spec:release-gate, which uses the draft window to
hold a production release until the full e2e suite runs against the
tagged SHA. The behavior of `release_as_draft` from the adopter's
perspective is unchanged; flywheel is one consumer of the per-branch
mechanism it offers. §req:priorities §spec:release-gate

**Stuck-draft failure mode.** If an opt-in branch's build fails before
it publishes the draft, the release remains an unpublished draft
indefinitely. flywheel does not monitor or recover it — consistent with
statelessness, and the adopter owns the build. The condition is visible
(an unpublished draft in the releases list) and recoverable by re-running
the build. A watchdog would require flywheel to hold state about
releases it has handed off, which this design specifically avoids.
§req:quality-attributes

**Alternatives rejected.**

- *Inferring the draft decision* — from the presence of `release_files`,
  or from detecting immutability is enabled on the repository.
  `release_files` describes in-repo version stamping, not release
  assets, and immutability being enabled does not imply assets are
  attached. Neither signal answers the actual question, which only the
  adopter's (flywheel-invisible) build workflow knows.

- *flywheel publishing the draft on a signal from the build* — adds a
  stateful round-trip for no gain over the build publishing the draft
  directly as its final step.

- *Repository-wide opt-in only* (the prior shape of this feature). See
  *Why per-branch scope*: tying flywheel's draft decision to the same
  scope as GitHub's repo-level immutability forces every release branch
  onto the draft path the moment any single branch needs it.
  §req:problem-statement

- *Top-level default with per-branch override.* Two configuration
  surfaces invite drift, and the effective behavior of a branch can no
  longer be read from that branch's own block — a reader shall look up
  the top-level default and combine the two. Per-branch-only keeps every
  branch's draft behavior local to its declaration.

**Tradeoffs accepted.**

- A branch that opts in writes its build workflow against a release-tag
  `push` trigger with a publish step at the end, rather than the
  `release: published` trigger an immediate-publish branch uses.
  Scoped to the opt-in — branches that do not opt in are untouched.
  No pre-publication trigger other than the tag push exists, because
  GitHub does not raise `release` events for drafts.

- A draft release whose build never publishes it lingers indefinitely.
  Adopter's responsibility (see *Stuck-draft failure mode*) rather
  than expanding flywheel into a stateful release monitor.

## Sandbox test budget §spec:sandbox-test-budget

*Status: complete*

flywheel's integration and e2e suites both exercise the real GitHub
API against `point-source/flywheel-sandbox` through a single App
installation, so they share one ~5000-requests/hour primary
rate-limit bucket. A run that exhausts the bucket fails not for any
code reason but because the budget is gone, and a maintainer who
sees that repeatedly learns to treat red CI as flake-not-signal.
This section defines the rules that keep per-run API consumption
inside the shared installation's headroom.
§req:sandbox-ci-budget

**Polling discipline.** The default per-poll interval for
sandbox-driven assertions lives in one place, set high enough that
no scenario exceeds its share of the per-run API budget. Individual
assertions override the default at the call site — the default is
the floor, not the ceiling — so a single file gates per-run cost
and per-assertion latency stays tunable.
§req:sandbox-ci-budget-criteria

**Workflow path filtering.** A documentation-only change — files
under `docs/`, `*.md` at the repository root, and
`.github/ISSUE_TEMPLATE/` — bypasses the sandbox-driven steps of
`integration.yml` and the bundle rebuild of `verify-dist.yml`, and
each workflow reports its check name as a successful no-op.
Filtering happens inside the job rather than via top-level
`paths-ignore`: top-level filtering causes GitHub to never report
the check, which would block any PR whose required-check rule
expects that name. Unit tests (`npm test`) continue to run on
doc-only PRs at zero sandbox cost and catch doc-parser regressions
covered by `tests/docs-examples.test.ts` — the only doc-touching
verification verify-dist performs.
§req:sandbox-ci-budget-criteria §req:ci-constraints

**Installation separation (contingent).** If polling discipline and
path filtering together fail to reach zero rate-limit-induced
failures across a typical development week, the integration and
e2e suites move to independent installations on the same sandbox so
each draws from its own primary rate-limit bucket. Not done
preemptively: it adds a credential pair to rotate, and the two
shipped mitigations are expected to suffice. §req:ci-priorities

**Alternatives rejected.**

- *ETag / conditional-request middleware on the sandbox Octokit
  client.* 304 responses don't count against the primary limit but
  add a maintained middleware layer, and they don't help against
  secondary (burst / concurrent) limits. Polling discipline and
  path filtering address the same axis with fewer moving parts.

- *Time-based debouncing of e2e* — skip a run if one ran in the last
  hour against the same sandbox. Requires flywheel to hold state
  about prior runs, violating statelessness.
  §req:ci-quality-attributes

**Tradeoffs accepted.**

- A higher default poll interval lengthens fast-resolving e2e
  assertions. The per-call override mechanism lets specific
  assertions opt back into faster polling where latency matters.

- Doc-only PRs no longer surface a doc-processing regression in
  integration or verify-dist. Those suites do not read docs;
  `tests/docs-examples.test.ts` (run under `npm test` on every PR)
  is the surface that would catch such a regression, and it still
  runs.

**Observability (nice-to-have).** Per-run API-call counts surfaced
in CI logs would let drift in per-scenario cost be caught before it
exhausts the bucket. Not yet implemented. §req:ci-priorities

## Release gate §spec:release-gate

*Status: complete*

flywheel is a runtime action: a broken release tagged at `@v1` is
consumed by every adopter pinned to that major on their next CI run.
The per-push e2e cadence that incidentally covered release SHAs is no
longer a reliable gate — the same rate-limit budget pressure that
motivates §spec:sandbox-test-budget teaches maintainers to merge
through red CI, and an unchecked red SHA on `develop` becomes the
release SHA on the next promotion. This section specifies a release
pipeline in which no production release on `main` publishes, and no
floating `@vN` major tag advances, without a green e2e run against
the exact SHA being released. §req:release-safety-gate

**Mechanism.** flywheel's `.flywheel.yml` sets `release_as_draft:
true` on `main` and leaves `develop` on the default immediate-publish
path. On a `develop → main` promotion, `@semantic-release/github`
creates the production release as an unpublished draft and pushes the
version tag. The release object exists and the tag is in place, but
`@vN` has not moved yet — `release-major-tag.yml` fires on
`release: published`, which GitHub does not raise for drafts.
`.github/workflows/release-gate.yml` triggers on the production
version tag's push, runs the full e2e suite against the tagged SHA,
and on green calls GitHub's Update Release API with `draft: false`.
The publish fires `release: published`, which triggers
`release-major-tag.yml` to advance `@vN`. On red, the workflow exits
non-zero; the draft stays unpublished, `@vN` stays at the prior
release, and adopters pinned to the major continue to consume the
previous green release.
§req:release-safety-gate-criteria

This reuses the per-branch `release_as_draft` mechanism from
§spec:immutable-release-support for an internal CI-gating purpose
rather than artifact attachment. flywheel attaches no release assets;
the draft window exists only so the gate has an unpublished release
to publish (green) or leave alone (red). The behavior of the broader
`release_as_draft` feature is unchanged.

**Develop-push cadence.** With the gate in place, `e2e.yml` no longer
auto-triggers on `push:` to `develop` — only `workflow_dispatch` for
manual investigation. Integration tests, unit tests, and verify-dist
still run on every PR; the e2e signal exists only at release time,
which is where adopters consume it. §req:ci-priorities

**Red-candidate behavior.** A red gate run leaves the release as an
unpublished draft in the releases UI. flywheel does not retry,
auto-publish, or auto-clean. Recovery paths:

1. *Supersede.* Merge the fix to `develop`, let the next promotion
   run. semantic-release derives version from git tags, and the
   stuck draft's tag is already pushed, so the new release does not
   collide. The stuck draft may be deleted manually but does not
   block.

2. *Re-run.* The workflow is idempotent: on green it publishes the
   draft, on red it leaves the draft alone, and after a successful
   publish it is a no-op.
§req:release-safety-gate-criteria

**Authentication.** Two installation tokens: `FLYWHEEL_E2E_APP_ID`
(scoped to the sandbox, identical to `e2e.yml`) for the e2e step,
and `FLYWHEEL_GH_APP_ID` (scoped to `point-source/flywheel`,
identical to `flywheel-push.yml`) for the publish API call. No new
secrets. §req:ci-quality-attributes

**Concurrency.** Serializes per tag with `cancel-in-progress: false`
— a partial publish shall not be cancelled. Cross-tag concurrency is
unconstrained.

**Statelessness.** flywheel holds no state between draft-creation
(in `semantic-release`) and publish (in `release-gate.yml`). The
repository's tags, release objects, and check runs are the state
machine. §req:ci-quality-attributes

**Adopter invisibility.** `release_as_draft: true` is set only in
flywheel's own `.flywheel.yml`. Scaffolded `.flywheel.yml` files
leave every branch on immediate-publish, and `release-gate.yml` is
not scaffolded into adopter repos by `scripts/init.sh`. An adopter
consuming `@v1` sees the same release object structure, trigger
event, and timing as before — flywheel's internal verification is
invisible from the outside. §req:release-safety-gate-criteria

**Alternatives rejected.**

- *Staging branch* (`develop → staging → main`). Adds a third tier
  to the branch topology and pulls staging semantics into
  `.flywheel.yml`, which adopters configure. The back-merge logic
  currently mapping `main → develop` would need to learn about
  staging. Equivalent gating outcome to the release gate with
  substantially more disruption, and a real risk of confusing
  adopters who would wonder whether to mirror the topology.

- *Inline e2e in `flywheel-push.yml`* — run e2e as a job inside the
  release-cut workflow, gating `semantic-release` on its result.
  Mechanically simpler but loses the observable-artifact property:
  there is no draft to point at as the candidate that is gated.
  The release-gate-on-tag-push design leaves a visible artifact
  (the unpublished draft) for the maintainer to inspect.

- *On-demand-only e2e* — drop the auto-trigger, run manually before
  releases. Depends entirely on maintainer discipline; not a
  structural gate. If the maintainer forgets, a broken release
  still ships.

- *Promotion-PR gate* — open a `develop → main` PR and gate merge
  on e2e via branch protection. Requires shifting the promotion
  mechanism from the existing push-driven flow to a PR-driven flow,
  a larger change with no advantage over the tag-push-triggered
  gate.

- *Gate the floating major tag instead of publication.* Replace the
  body of `release-major-tag.yml` to run e2e and advance `@vN` only
  on green, with no `release_as_draft` involvement. Simpler but
  strictly weaker: a published-but-not-floated release stays in
  the releases UI as a real release, and adopters pinned to an
  exact version (`@v1.3.0`) still see the broken code. The
  release-gate design protects every adopter regardless of pin
  shape.

**Tradeoffs accepted.**

- Develop pushes no longer carry e2e signal. A regression that only
  e2e would catch can sit on `develop` for up to a release cycle
  (~one business day) before the release gate surfaces it.
  Accepted: the cost — slightly later detection of a
  release-blocking bug — is paid only by maintainers, while the
  gain (rate-limit headroom, faster develop CI) accrues every
  push. The gate ensures no broken SHA reaches adopters regardless
  of when the regression landed on `develop`.

- A stuck-draft production release sits in the repository's
  releases UI until manually addressed. Accepted: this is the
  visible failure mode the gate is supposed to produce. The
  pattern mirrors the stuck-draft model already documented for
  adopters in §spec:immutable-release-support.

**Security.** `release-gate.yml` runs on the SHA the production
tag points to — a commit that flywheel's own release pipeline
just created. No untrusted input modifies what gets executed; the
workflow trusts the tag pointer the same release pipeline pushed.
The publish step calls a single authenticated GitHub API endpoint
with a token already scoped to `point-source/flywheel`. No new
attack surface beyond what `flywheel-push.yml` already exposes.
