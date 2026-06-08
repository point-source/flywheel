# flywheel — Specification

## Overview §spec:overview

*Status: not started*

<!-- Describe the desired behavior of this section. -->

## Action version lockstep §spec:action-version-lockstep

*Status: complete*

Flywheel is distributed as a single composite GitHub Action, invoked
directly from an adopter's workflow job:

```yaml
jobs:
  conduct:
    runs-on: ubuntu-latest
    steps:
      - uses: point-source/flywheel@v2
        with:
          event: pull_request
          app-id: ${{ vars.FLYWHEEL_GH_APP_ID }}
          app-private-key: ${{ secrets.FLYWHEEL_GH_APP_PRIVATE_KEY }}
```

The `@<ref>` on that line is the only version-control surface. GitHub
resolves the ref and places flywheel's repository on the runner at that
ref before any step executes; the composite's JavaScript dispatcher, its
bundled `scripts/`, and its `semantic-release` plugin set are therefore
all at the pinned version by construction. The dispatcher and scripts are
addressed against that checkout via `github.action_path`, not via a
workspace-relative `uses: ./…` (see §spec:composite-self-reference). Pinning a floating major (`@v2`) tracks that
major's latest release; pinning an exact version (`@v2.1.0`) runs exactly
that release. There is no second version input, no ref derived at
runtime, and no file that records or rewrites a version.

**Why a single composite action, not reusable workflows.** A reusable
workflow cannot determine the ref it was pinned at — `github.workflow_ref`
resolves to the workflow that *triggered the run*, never to a reusable
workflow it calls. Any reusable-workflow design shall therefore derive
that ref (#172 release-time rewrite failed on GH013 because Flywheel's
App lacks `workflows: write`; #180 `GITHUB_WORKFLOW_REF` parsing failed
for non-default-branch callers, #183) or carry a second version surface
the caller shall keep in sync with the workflow pin. The composite,
invoked directly by the adopter, has no such layer — GitHub performs
the version resolution as part of `uses:`.

**Tradeoffs accepted.**

- The composite caller is a few lines longer than a reusable-workflow
  caller (`runs-on`, `steps`), and migrating to it was a breaking
  change — every adopter updated its caller workflows once at v1 → v2.
  In exchange the failure class (#166, #172, #178, #180, #183) is
  structurally impossible — no version literal exists anywhere in
  flywheel.
- A composite action cannot declare `concurrency`; it lives in the
  adopter's caller workflow, where the scaffolded template places it.
  Flywheel can no longer change the concurrency strategy centrally —
  reasonably an adopter concern.

**Security.** The composite runs inside the adopter's workflow and
checks out the adopter's repository — the trust position flywheel
already holds. It mints its own GitHub App installation token from
adopter-supplied credentials. The adopter's chosen `@<ref>` is the
sole determinant of which flywheel code runs.

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

*Status: in progress*

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
and on green publishes the draft (§spec:release-publish-step, which
owns how the draft is located and flipped public, and how a publish
that cannot complete is surfaced). The publish fires
`release: published`, which triggers
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

**Promotion cadence.** The budget savings above hold only if a
`develop → main` promotion fires at the maintainer's chosen cadence,
not on every bumping push to `develop`. Each bumping promotion
triggers semantic-release on `main`, which fires `release-gate.yml`
and consumes one e2e run against the shared sandbox installation —
auto-merging every bumping promotion makes that cadence equal to the
develop-push cadence, undoing the savings. flywheel's `.flywheel.yml`
therefore lists only non-bumping types (`chore`, `refactor`, `style`,
`test`, `docs`, `ci`, `build`) in `main`'s `auto_merge`; bumping types
(`feat`, `fix`, `fix!`, `perf`) require manual review so a maintainer
decides when a batch of develop activity is worth a release. Non-bumping
promotions still flow automatically because semantic-release computes
no version bump for them and no release fires — they cost nothing.
§req:ci-priorities

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

## Release publish step §spec:release-publish-step

*Status: complete*

The release gate (§spec:release-gate) has two halves — block a red
release, publish a green one — and only the block half is verified.
The publish half has been failing silently in production: on a green
e2e run, `scripts/publish-draft-release.sh` is supposed to locate the
production tag's draft release and flip it public, but it never finds
the draft, errors, and exits without publishing. Every production
release since `release_as_draft` arrived at v1.4.0 (v1.4.0, v1.5.0,
v1.6.0) is stranded as an unpublished draft; nothing has reached
adopters since v1.3.0. To an adopter, a green gate that never
publishes is indistinguishable from no release — a moving `@vN` never
advances and an exact pin never appears — and because the drafts pile
up with no error surfaced, the gap surfaces only when adopters are
noticed to be versions behind. This section specifies the publish
step so the full round trip holds: a green-gated release becomes a
published release adopters receive, and a draft stays unpublished
only when it legitimately failed verification.
§req:release-safety-gate

**Draft-aware lookup.** The publish step locates a release by its tag
using a lookup that **includes unpublished drafts**. GitHub's
`GET /repos/{owner}/{repo}/releases/tags/{tag}` is documented as "Get
a *published* release" and excludes drafts entirely — it returns
`404 Not Found` for a draft regardless of token scope, which is the
root cause of the stranding. The release the gate needs to publish is,
by construction, always a draft on its first green run, so the step
shall query an endpoint that returns drafts (the list-releases
endpoint, whose drafts are visible to a token with push access — which
the `FLYWHEEL_GH_APP_ID` token holds) and select the release whose
`tag_name` matches the gated tag. §req:release-safety-gate-criteria

**Publish-on-green completes.** When the gate's e2e run is green and a
draft release exists for the production tag, the system shall flip
that release from draft to public on the same run that turned green.
After the run, the release is visible to adopters and `release:
published` has fired so `@vN` can advance. The draft-to-public
transition is a guaranteed outcome of a green gate, not an incidental
one. §req:release-safety-gate-criteria

**A draft stays unpublished only for a legitimate reason.** Two — and
only two — outcomes leave a release unpublished: a red e2e run (the
gate exits before the publish step), or no release attached to the tag
(semantic-release was skipped or a bare tag was pushed; the step logs
a notice and is a benign no-op). A release that exists but cannot be
located or flipped is **not** a legitimate reason to leave it a draft;
that is the failure the loud-failure rule below covers.
§req:release-safety-gate-criteria

**Loud failure.** When the publish step cannot complete — the tag has
a release that the lookup fails to return, the response is malformed,
or the publish API call errors — the system shall fail the gate run
non-zero with an error message in the CI log, so a maintainer reading
CI can tell a green release did not reach adopters. The step shall not
treat an unexpected or error response as the benign "no release on the
tag" no-op. The original defect did exactly that: a 404 error body left
on stdout (the API error JSON) passed an emptiness guard and was read
as "nothing to publish," converting a hard failure into a silent one.
The "no release" no-op is reserved for a genuine absence of any release
for the tag, distinguished from a lookup or publish error.
§req:release-safety-gate-criteria

**Tested against real release behavior.** The publish path is
exercised against the responses a real release and a real `gh` client
produce — in particular, a draft lookup that misses returns a
**non-empty** error body on stdout alongside a non-zero exit, not an
empty string. A test that stubs an empty response for the miss case
does not exercise the path that stranded production releases. The
regression that would re-strand releases (an error response mistaken
for "nothing to publish") shall be caught by a test before it ships,
not in production. The retargeting defense is likewise exercised
against the target shape a real release produces — its recorded
target is a branch name, so the publishable case feeds that shape and
asserts the release still publishes, rather than feeding a synthetic
commit-shaped target that no real release ever carries. A guard that
would reject every real release therefore cannot pass review again.
This coverage stays in the fast local unit suite and adds no load to
the e2e suite. §req:release-safety-gate-criteria

**Idempotency.** Re-running the gate on an already-published tag is a
no-op: the release is found, observed to be non-draft, and the step
exits 0 without re-issuing the publish. This preserves the gate's
re-run recovery path (§spec:release-gate, Red-candidate behavior).

**SHA pin (retargeting defense).** When the gate passes the SHA its
e2e ran against, the step publishes only if the tag being published
resolves to that exact commit, and fails the run loudly otherwise.
This defends the rare case where the tag is moved to a different
commit between the gate's checkout and the publish — a release built
on an untested commit shall never reach adopters. The defense
establishes the tag-to-commit identity by **resolving the tag
reference to its commit**, not by reading the field the release
records as its target. `@semantic-release/github` sets that field
(`target_commitish`) to the branch the release was cut from — `main`,
never a commit identifier — so comparing it against a 40-character SHA
can never match and would reject every legitimate green release. A
release whose tag still points at the e2e-tested commit publishes;
only a tag moved off that commit, or a tag that cannot be resolved to
a commit at all, is blocked. A mismatch is a loud failure, not a
silent skip. §req:release-safety-gate-criteria

**Why a list-and-filter lookup over the tags endpoint.** The tags
endpoint cannot see drafts by GitHub's design, so no token scope or
retry makes it work for the gate's first-publish case; switching to a
draft-visible lookup is the only correct fix. Adding a second,
draft-specific call alongside the tags endpoint was rejected — the
list endpoint already returns both published and draft releases, so
one lookup covers the already-published idempotency case and the
draft-to-publish case. The gated draft is the most recent release for
its tag and is created moments before the gate runs, so it appears
without deep pagination; the step selects by `tag_name` rather than
assuming list position.

**Scope.** Restoring the already-stranded v1.4.0–v1.6.0 drafts is out
of scope; this governs releases going forward. A maintainer may
publish those drafts manually. §req:release-safety-gate

## Release CI budget §spec:release-ci-budget

*Status: complete*

Every flywheel release produces up to three pushes on managed
branches in rapid succession — the human merge that initiates the
release, the `chore(release): X.Y.Z` commit semantic-release pushes
onto the release branch, and the back-merge of that release into
each upstream branch. The back-merge fast-forwards when the upstream
has no commits the release branch lacks, in which case the upstream's
new tip *is* the `chore(release):` commit; otherwise it is a true
merge commit (`chore: back-merge vX.Y.Z from <release> into
<upstream>`). Either way the upstream push carries no new source —
just the version bump and changelog replay. The merge push is the
one quality workflows exist to verify; its result decides whether
the release commit gets created at all. The release commit and
back-merge commits are derived artifacts — semantic-release produces
them from a SHA the merge push already certified green, they touch
only `CHANGELOG.md`, version stamps, and the equivalents replayed
onto upstream branches, and re-running the same quality workflows
against them cannot produce a different verdict. This section gives
adopters a primitive to short-circuit quality workflows on those
derived pushes while preserving every required check's reported
result. §req:release-ci-budget

**Mechanism.** Flywheel ships a lightweight composite action at
`point-source/flywheel/classify@v1` that any workflow can `uses:`
as a step. It runs no checkout, mints no token, and consumes no API
budget — it reads `github.event` and emits two boolean step outputs:

- `derived_release_commit` — `'true'` when the head commit is a
  flywheel-produced release commit or back-merge merge commit;
  `'false'` otherwise.
- `promotion_pr` — `'true'` when the workflow is running for the
  long-lived develop→main promotion PR; `'false'` otherwise.

The two outputs are independent. Adopters who want to skip work on
release/back-merge commits but still run quality checks on the
promotion PR (the common case, since the promotion PR carries the
batch of work the maintainer is releasing) gate on
`derived_release_commit` alone. Adopters who additionally want to
skip the promotion PR opt into that separately. The split exists
because adopters polarize on the second decision in a way they do
not on the first. §req:release-ci-budget-criteria

**Identification rule.** A commit is a "derived release commit"
iff it carries a flywheel release-pipeline message prefix *and* was
authored by the bot that emits that prefix. Two prefixes, two
authoring identities, because flywheel's release pipeline uses two
distinct bots:

- `chore(release):` — the version commit, authored by
  `semantic-release-bot` (`semantic-release-bot@martynus.net`), the
  default committer of `@semantic-release/git` when the workflow
  configures no git identity of its own. This commit appears on the
  release branch push, and again on an upstream branch when the
  back-merge fast-forwards onto it.
- `chore: back-merge` — the back-merge merge commit (format
  `chore: back-merge vX.Y.Z from <branch> into <branch>`), authored
  by `github-actions[bot]`
  (`41898282+github-actions[bot]@users.noreply.github.com`), the
  identity `scripts/back-merge.sh` sets before merging.

Requiring a known bot author guards against a human-authored commit
that happens to use one of these prefixes being skipped. The check
is fail-safe in the direction that matters: an unrecognized author
classifies the commit as *non*-derived and the quality workflow
runs — flywheel never skips CI on a commit it is unsure about. The
promotion PR is a separate signal, identified by its title
containing `: promote` — the format flywheel emits when opening
the long-lived promotion PR. These prefixes, the two bot
identities, and the promotion-PR title pattern are declared as part
of flywheel's stable public surface in this section; flywheel's
release and back-merge code paths shall not change them without a
corresponding major-version bump. The rule lives on flywheel's side
of the interface — adopters consume the boolean and do not need to
know any of these patterns to use it correctly. §req:ci-constraints

**Trigger-payload coverage.** The composite classifies correctly on
`push`, `merge_group`, and `pull_request` triggers, reading the head
commit where each populates it (a `pull_request` payload carries no
commit, so only the promotion-PR title signal applies there). Which
payload field to read is implementation detail the composite owns;
adopters wire up triggers and never branch on the event shape in
their own `if:`. §req:release-ci-budget-criteria

**Observable behavior.** An adopter who adds the composite as a
first step and gates downstream jobs (or steps) on its outputs
observes one CI fan-out per release cycle on each gated workflow —
the fan-out from the human merge that initiated the release. The
subsequent release-commit and back-merge pushes (whether the
back-merge fast-forwards the `chore(release):` commit onto the
upstream or lands as a `chore: back-merge` merge commit) trigger
the workflow run, run the composite (which costs sub-second), report
each downstream job as a successful no-op via the `if:` skip, and
complete. An adopter who has not added the composite observes
today's behavior unchanged on every workflow.
§req:release-ci-budget-criteria

**Required-check preservation.** Skipping happens at job-level
`if:` (or step-level `if:` within a job), not at workflow-level
`paths-ignore` or `[skip ci]`. GitHub reports the job's result as
`success` when its `if:` evaluates false (per its required-status-
check semantics), so any branch-protection rule expecting that
check name continues to clear. Workflow-level filtering would
cause GitHub to never report the check and would stall any
tracking PR's required-check rule on `Pending` — the same
constraint that already governs the doc-only filtering in
§spec:sandbox-test-budget. §req:ci-constraints

**Dogfood — flywheel's own quality workflows.** The three quality
workflows in this repository that fire on `push` — `integration
.yml`, `verify-dist.yml`, and `governance-lint.yml` — gate their
work on the `derived_release_commit` output of this composite.
`integration.yml` and `verify-dist.yml` add the composite as a
step alongside their existing `dorny/paths-filter` step and AND
the two filter outputs into each gated step's `if:` clause.
`governance-lint.yml` is a one-job workflow that delegates to a
reusable workflow via `jobs.<id>.uses:`, which forbids steps in
the same job; it gains a tiny preceding `classify` job that runs
the composite and exposes the boolean as a job output, and the
lint job adds `needs: classify` plus `if: needs.classify.outputs
.derived_release_commit != 'true'`. A subsequent vX.Y.Z release on
`point-source/flywheel` produces one fan-out per workflow rather
than two or three. §req:release-ci-budget-criteria

The promotion PR's `: promote` signal is not used by these
workflows — they trigger on `push`, not on the promotion PR — so
`integration.yml` / `verify-dist.yml` / `governance-lint.yml` gate
on `derived_release_commit` only. The `promotion_pr` output is
still exposed for adopters whose quality workflows trigger on
`pull_request` and want the option.

**Scaffolded template update.** `scripts/templates/quality.yml`
currently inlines the message-prefix and PR-title patterns into
its job-level `if:` clause. The template is updated to invoke
`point-source/flywheel/classify@v1` as a first step and gate the
job on its outputs, with the same effective behavior. The inline
form is preserved in a comment as a documented fallback for
adopters who prefer not to add an action invocation. New adopters
who run `scripts/init.sh` (or copy the template manually) receive
the composite-based pattern by default. §req:release-ci-budget-criteria

**Adopter scope of opt-in.** The composite is added per workflow
and per job: an adopter can gate `integration` on the boolean
while keeping `typecheck` running on every push, or apply it to
every job in a workflow file uniformly. The granularity matches
where the `if:` clause is placed; flywheel imposes no top-level
opt-in surface. Adopters who want strict CI on every push remain
in that mode by adding nothing. §req:release-ci-budget-criteria

**Versioning surface.** The composite action ships at
`point-source/flywheel/classify@v1` and floats its major tag in
lockstep with the main `point-source/flywheel@v1` action. Adopters
typically pin both to the same `@v1`. The identification rule and
the boolean output names are part of the major's stable surface;
changes that would alter what the boolean returns for a given
commit shape (e.g., changing the back-merge message prefix)
require a major bump on both actions.
§spec:action-version-lockstep

**Alternatives rejected.**

- *Add the output to the main flywheel action only.* The main
  action mints an App installation token and runs the dispatch
  logic; carrying that overhead into every quality workflow that
  wants to gate on a sub-second classification is wasteful and
  pulls the App credentials into workflows that have no other
  reason to hold them. A separate composite costs nothing to add
  to a workflow that already runs `npm test`.

- *Document the message-prefix patterns and have adopters write
  the `if:` themselves.* This is today's state (the
  `scripts/templates/quality.yml` inline pattern). It works but
  violates the requirement that adopters not mirror flywheel's
  internal authorship and message conventions in their own
  workflows — an adopter pinned to `@v1` who never reads
  flywheel's source has no way to know the back-merge prefix is
  `chore: back-merge` and not, say, `chore: backmerge`. The
  composite moves the rule to flywheel's side of the interface.
  §req:ci-constraints

- *Fold release/back-merge and promotion-PR into one
  `skip_check` output.* Adopters polarize on the promotion-PR
  decision in a way they do not on the release/back-merge
  decision — some want every promotion PR fully exercised because
  it carries the batch of work being released, others want it
  skipped because they already exercised every constituent PR.
  Folding the two into one output forces a single choice on every
  adopter.

- *Per-step micro-granularity via additional outputs.* The two
  booleans plus job-level / step-level `if:` placement cover the
  observed need. Adopters who want to gate individual steps add
  the same `if:` to each step; the composite outputs the booleans
  once per job. Adding more granular outputs (e.g.,
  `is_chore_release` and `is_back_merge` separately) would expose
  internal distinctions adopters have no documented reason to
  branch on.

- *Auto-injecting the gate into adopter quality workflows from
  `init`.* `scripts/init.sh` scaffolds `flywheel-pr.yml` and
  `flywheel-push.yml` but not adopters' quality workflows — the
  quality workflow is the adopter's. Updating `quality.yml`-the-
  template ensures new copies carry the pattern; mass-rewriting
  workflows the adopter authored crosses a scope line `init`
  doesn't otherwise cross.

**Tradeoffs accepted.**

- A new versioned action surface (`point-source/flywheel/classify`)
  exists alongside the main action. The major tag floats with the
  main action's, and the identification rule lives in a single
  small file; the maintenance surface is bounded. Accepted to
  keep adopter overhead near zero per workflow.

- The back-merge merge-commit message format (`chore: back-merge
  vX.Y.Z from <branch> into <branch>`), the release-commit prefix
  (`chore(release):`), and the two authoring bot identities
  (`semantic-release-bot`, `github-actions[bot]`) become part of
  flywheel's stable public surface, formally locking them to the
  major version. Changing any of them becomes a breaking change.
  Accepted: all have been stable since the relevant features
  shipped, and the composite encapsulates them so adopters never
  see them. The dependency on `semantic-release-bot` in particular
  is a dependency on the `@semantic-release/git` default committer;
  if flywheel ever configures an explicit release-commit identity,
  this list is the single place that records the coupling.

- Requiring a recognized bot author means a hand-authored commit
  that happens to use a `chore(release):` or `chore: back-merge`
  message — vanishingly rare, and conventionally avoided by the
  same maintainers who would invoke flywheel — is classified as
  non-derived and its CI runs. This is the safe failure direction:
  flywheel never skips a commit it cannot positively attribute to
  its own pipeline. Adopters who want to also skip such commits add
  their own broader `if:` alongside the composite's output; the
  composite stays narrow and unambiguous.

**Security.** The composite reads `github.event` (workflow-
provided, not adopter-controlled) and emits string outputs. It
mints no token, makes no API call, and reads no secrets. No new
attack surface.

## Workflow run names §spec:workflow-run-names

*Status: complete*

When one commit triggers several of flywheel's workflows — routine on
`develop` and `main`, where a single `chore(release): X.Y.Z` bot commit
fans out to every top-level workflow at once — the GitHub Actions list
shows the same title on every row, because none of flywheel's workflow
files set `run-name` and GitHub's fallback is the triggering commit's
message. The rows are distinct workflows (Governance Lint, Verify dist,
Integration tests, Flywheel — Push, Release gate, and the rest), but
nothing in the title tells them apart; a maintainer scanning CI reads
across to the workflow column or opens each run to identify it. Every
workflow file in this repository sets a `run-name` whose displayed title
begins with the workflow's own human-readable name, so each run in the
list is identifiable at a glance. §req:workflow-run-names

**Observable behavior.** For a commit that triggers multiple workflows,
the Actions list shows a distinct title per run, each of the form
`<Workflow name> — <change context>`. The change context is the head
commit's message for a push, the pull-request title for a `pull_request`
run, and the tag or branch name otherwise — so a reader both identifies
which workflow a row is and ties it back to the change that caused it,
without opening any run. A workflow's triggers, jobs, permissions, and
reported check names are unchanged; the same commit triggers the same set
of workflows with the same checks reporting, and only the list titles
differ. §req:workflow-run-names-criteria §req:workflow-run-names-constraints

**Name source — `github.workflow`, not a repeated literal.** Each
`run-name` leads with `${{ github.workflow }}` rather than re-typing the
workflow's name as a string literal. `github.workflow` evaluates to the
workflow's own `name:`, so the displayed title and the `name:` field
cannot drift: renaming a workflow updates its run name automatically, and
a workflow added later inherits the convention by copying one line. Every
flywheel workflow already declares `name:`, so the expression always
resolves to the intended human-readable name (GitHub's file-path fallback
for a missing `name:` never applies here). §req:workflow-run-names-stories

**Change-context expression — a graceful-degradation fallback chain.**
flywheel's workflows fire on a mix of events — `push`, `pull_request`,
`release`, `workflow_dispatch`, and tag pushes — and `run-name` is
evaluated once, before any job runs, against whichever event actually
triggered the run. A single expression shall therefore yield a useful,
non-empty title for every such event. Each `run-name` resolves the change
context through an ordered `||` chain that takes the first populated value
for the firing event:

1. `github.event.head_commit.message` — present on `push` (branch and
   release-commit pushes), the dominant case this section exists to fix.
2. `github.event.pull_request.title` — present on `pull_request`.
3. `github.event.release.tag_name` — present on `release` (e.g.
   `release-major-tag.yml`).
4. `github.ref_name` — the branch or tag short name, always populated.

The trailing `github.ref_name` is the floor: it is never blank for any
event, so the expression can neither render an empty title nor error on an
event that carries no commit or PR (a `workflow_dispatch` run, for
instance, falls through to the branch name). Ordering commit-message first
matches the fan-out the section targets — the release-bot push — and the
PR title second covers the other high-frequency case. §req:workflow-run-names-constraints

**Coverage — every workflow file, including the reusable ones.** All eight
top-level workflows (`e2e.yml`, `flywheel-pr.yml`, `flywheel-push.yml`,
`governance-lint.yml`, `integration.yml`, `release-gate.yml`,
`release-major-tag.yml`, `verify-dist.yml`) carry the run name and gain
distinct list rows. The two reusable workflows (`push.yml`, `pr.yml`),
invoked via `workflow_call`, also carry it — even though GitHub ignores a
called workflow's `run-name` and renders it nested under its caller's row,
so the reusable workflows produce no separate list entry. Their run name
is a deliberate source-level consistency choice — every workflow file
follows one convention, and a contributor reading any file sees the same
pattern — not an expectation that they gain their own rows.
§req:workflow-run-names-criteria

**Why this is display-only.** `run-name` controls solely the title GitHub
shows for a run; it is not part of `on:`, `jobs`, `permissions`, or any
job's reported check name. Adding it cannot change which workflows a commit
triggers or which checks a branch-protection rule sees — the property that
keeps this a zero-risk polish change rather than a CI-behavior change, and
the reason it is safe to apply uniformly across every workflow at once.
§req:workflow-run-names-constraints

**Alternatives rejected.**

- *Repeating the workflow name as a string literal* (e.g.
  `run-name: "Verify dist — …"`, as the issue sketches). Works, but
  duplicates the `name:` value in each file: a later rename updates one and
  silently leaves the run name stale. `${{ github.workflow }}` keeps a
  single source of truth for the name. §req:workflow-run-names-stories

- *A per-event expression in each workflow* — tailoring the context to the
  exact events that workflow declares (commit-only for a push-only
  workflow, title-only for a PR-only workflow). Marginally shorter per
  file, but every workflow then carries a different expression, the shared
  convention is lost, and a workflow that later adds a trigger silently
  renders blank for the new event. The one fallback chain is correct on
  every event, so the same line is copied everywhere. §req:workflow-run-names-criteria

- *Leaving the reusable workflows without a run name* — since GitHub
  ignores it for called workflows, it changes nothing observable. Rejected
  for consistency: "every workflow file sets `run-name` the same way" is a
  simpler rule to state and to lint than "every workflow file except the
  reusable ones," and it removes a question for the next contributor.
  §req:workflow-run-names-criteria

**Tradeoffs accepted.**

- A run name built from `github.event.head_commit.message` carries the
  full commit message, including any body, where GitHub's own default
  fallback shows only the first line. In practice the Actions list renders
  the leading line and flywheel's managed-branch commits are
  single-line conventional commits, so the displayed title matches the
  default's shape; a GitHub Actions expression cannot split on the first
  newline, and the multi-line case is benign, so no trimming is attempted.

- The change touches every workflow file in one sweep. Because it is
  display-only (see above), the blast radius of a mistake is a wrong title,
  not a broken or skipped check, so the uniform edit is low-risk.

## Composite self-reference §spec:composite-self-reference

*Status: complete*

An external adopter who pins `point-source/flywheel@<ref>` and triggers
flywheel on a `pull_request` or `push` event runs flywheel's logic to
completion, regardless of what the adopter's own repository contains. No
step fails with `Can't find 'action.yml', 'action.yaml' or 'Dockerfile'`,
because every flywheel-shipped file a step invokes — the JavaScript
dispatcher, the bundled `scripts/`, and the semantic-release plugin set —
is located from flywheel's own checkout on the runner, never from the
adopter's workspace. §req:composite-action-path §req:composite-action-path-criteria

**The problem this fixes.** GitHub places flywheel's repository at the
pinned ref in the runner's action cache, then the composite's first step
checks the *adopter's* repository into `GITHUB_WORKSPACE`. A local-action
reference written as `uses: ./…` inside a composite resolves against the
workspace — the adopter's repository — not against the action's own
checkout. The v2.0.0 composite invoked its dispatcher as `uses: ./core`
under the mistaken belief that `./core` resolves against flywheel's
checkout; it does not. By the time the dispatch step ran, the workspace
held the adopter's repository, which contains no `core/`, so every
external adopter failed on the first dispatch step of every event — the
entire v2 major was unusable outside flywheel's own repository.
§req:composite-action-path

**The resolution rule.** flywheel addresses its own files through
`${{ github.action_path }}`, GitHub's built-in absolute path to the
action's checkout on the runner. The three release-script steps
(sanitize, register-merge-drivers, back-merge) already resolved this way
and were correct. The defect was isolated to the one `uses: ./…`
self-reference, the sole construct subject to workspace-relative
resolution. Bringing the dispatcher under the same `github.action_path`
rule unifies every flywheel self-reference under one resolution semantics
and removes the only workspace-relative reference to flywheel's own code.
The source comments and the §spec:action-version-lockstep description that
asserted `./core` resolves against the action's checkout were wrong and
are corrected, so the assumption cannot be reintroduced.
§req:composite-action-path-constraints

**Full release cycle, not just the first step.** The guarantee covers the
entire managed-release flow an adopter can reach on a release branch:
dispatch, semantic-release, release-body @-mention sanitization,
merge-driver registration, and back-merge into upstream branches. Each
step locates flywheel's bundled assets from flywheel's own checkout. The
fix is not complete when only the dispatcher's first step is reachable —
several later steps (sanitize, register-merge-drivers, back-merge) were
only ever exercised by flywheel's dogfood, never against a real adopter,
so each is verified to resolve correctly on the adopter path.
§req:composite-action-path-criteria §req:composite-action-path-stories

**Lockstep preserved.** The adopter still pins exactly one ref, and the
dispatcher, `scripts/`, and semantic-release configuration all come from
it; `github.action_path` points at that single ref's checkout. The
adopter-visible contract is unchanged — one ref pins everything — so the
fix introduces no second version surface to track
(§spec:action-version-lockstep). §req:composite-action-path-constraints

**Scope.** The dogfood path (`uses: ./` with flywheel's source already in
the workspace) and adopters pinned to a v1 ref see no behavior change;
only the external-adopter v2 path changes, from failing to working. The
fix adds no GitHub App scope or permission and holds no state between
runs. It is fix-forward: the requirement is met when the next release
works end-to-end for an external adopter, and the already-built,
unpublished v2.0.0 draft and its tag are left as they are.
§req:composite-action-path-constraints §req:composite-action-path-criteria

**Alternatives considered.**

- *Pin the nested action by repository path* (`uses:
  point-source/flywheel/core@<ref>`). `uses:` does not interpolate
  expressions, so `<ref>` would be a hardcoded literal — exactly the
  second version surface §spec:action-version-lockstep exists to
  eliminate. Rejected.
- *Copy or symlink `core/` into the workspace* before the dispatch step.
  Pollutes the adopter's checkout, can collide with adopter files, and
  leaves a workspace-relative reference that the next contributor could
  re-break the same way. Rejected.
- *Collapse `core/` into the root action.* The root must stay a composite
  (it checks out the adopter repo, then runs semantic-release and the
  release scripts as sibling steps), so it cannot itself be the node
  action. Rejected.

## Adopter-style resolution regression test §spec:adopter-resolution-test

*Status: complete*

A test in flywheel's cheap suite — unit or per-PR CI, not the
rate-limited e2e sandbox — fails when the composite is consumed the way an
external adopter consumes it (flywheel's files resolved from the action's
checkout while the workspace does not contain flywheel's source) and
passes once resolution is correct. This class of bug — flywheel unable to
find its own files when run from the action cache rather than from a
workspace that already holds its source — is caught before a release is
built, not only by the e2e gate or by an adopter.
§req:composite-action-path-criteria §req:composite-action-path-stories

**Why the cheap suite, and why the e2e gate was not enough.** flywheel's
v2.0.0 defect reached a built release because the every-PR suites never
modelled an adopter consuming flywheel from the action cache. The dogfood
invokes flywheel as `uses: ./`, which lays flywheel's own source —
including `core/` — into the workspace, so `./core` happened to resolve
and the dogfood passed. Only `sync-e2e-fixtures.mjs` rewrites `uses: ./`
to a pinned `point-source/flywheel@<sha>` and reproduces the real adopter
path, and only the e2e suite ran it — the most expensive, rate-limited
suite in the pipeline (§spec:sandbox-test-budget, §req:sandbox-ci-budget).
The release gate correctly refused to publish, so no adopter received the
broken major, but the maintainer learned of a total break from the
slowest possible signal. A cheap test moves first detection of this class
to every PR and adds no load to the sandbox installation the e2e suite
already strains. §req:composite-action-path §req:composite-action-path-constraints

**What the test asserts.** The guard models the resolution *rule*, not a
literal action-file shape. The prior `action-shape.test.ts` asserted the
composite contained `uses: ./core` — it encoded the broken assumption and
passed happily while every adopter failed, which is how a static
shape-check can rot. The replacement instead asserts adopter-style
resolution semantics: no flywheel self-reference in the composite resolves
against the workspace (no `uses: ./…` pointing at flywheel's own code),
and every reference to a flywheel-shipped file — dispatcher and scripts
alike — resolves through `github.action_path`. A reviewer can state the
rule the test enforces in one sentence and check it against the running
action. §req:composite-action-path-criteria §req:composite-action-path-constraints

**Backstop unchanged.** The e2e suite keeps exercising the full
rewritten-pin adopter path as a backstop; it is no longer the first line
of defense for this bug class. The dogfood (`flywheel-push.yml` and the
other workflows that invoke flywheel on this repository) keeps passing
unchanged. §req:composite-action-path-criteria
