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

## setup-node on the current major §spec:setup-node-v5-upgrade

*Status: complete*

Every `actions/setup-node` reference in the repository names the `@v5`
major. A repository-wide search for `actions/setup-node@v4` returns
nothing; all seven references — the dispatcher Node-setup step in
`action.yml`, the four CI workflows (`integration.yml`,
`release-gate.yml`, `verify-dist.yml`, `e2e.yml`), the contributor note
in `CONTRIBUTING.md`, and the adopter example in `docs/adopter/setup.md`
— pin `@v5`. The pin uses the same major-float style the rest of the
repository already uses for first-party actions (`actions/checkout@v6`),
so a reader sees one consistent convention rather than a mix of `@v4` and
`@v5`. §req:setup-node-v5 §req:setup-node-v5-criteria
§req:setup-node-v5-constraints

**Why this is its own change.** A `setup-node` major bump is a dependency
upgrade with its own potential behavior changes — a different default
Node version, deprecations, and cache behavior. The dispatcher
Node-setup step was added by the composite-action-path fix
(§spec:composite-self-reference) and deliberately pinned *down* to `@v4`
to match the rest of the repo and keep that bug fix tightly scoped;
folding the bump into it would have spread the blast radius across five
files. The upgrade is therefore carried as a separate, reviewable change.
§req:setup-node-v5 §req:setup-node-v5-stories

**Why it is low-risk — and why it is still verified, not assumed.** The
two behaviors a setup-node major bump can change are out of flywheel's
blast radius: every usage sets `node-version` explicitly (`"24"`), so v5's
changed *default* Node version cannot alter which runtime is provisioned,
and no usage relies on the action's `cache` input, so any cache-behavior
change is moot. Because the whole point of doing this deliberately is to
catch a v5 behavior change rather than wave it through on the edit alone,
the change is confirmed against running CI: typecheck, unit tests, and
`verify-dist` pass under v5, and the integration suite passes — confirming
a bumped workflow still provisions node 24 and runs `npm ci` plus the
suite exactly as before. The heavier e2e run is not required for this
change; per §spec:sandbox-test-budget (§req:sandbox-ci-budget) it is
reserved against the rate-limited sandbox installation.
§req:setup-node-v5-criteria §req:setup-node-v5-constraints

**Composite dispatcher unchanged in behavior.** Under `@v5` the
`action.yml` setup-node step still provisions node 24 — the runtime the
committed `dist/index.cjs` bundle targets (esbuild `node24`) — so an
external adopter running flywheel gets the same Node runtime as before the
bump (§spec:composite-self-reference). The change alters no workflow's
triggers, jobs, permissions, or reported check names, and adds no GitHub
App scope; an adopter consuming flywheel sees identical release behavior.
The adopter example in `docs/adopter/setup.md`, copied verbatim by new
adopters, shows `@v5`, so a fresh project starts on the current major
rather than an already-superseded one. §req:setup-node-v5
§req:setup-node-v5-stories §req:setup-node-v5-constraints

**Criteria.**

- A repository-wide search for `actions/setup-node@v4` shall return no
  matches.
- All seven `actions/setup-node` references shall name the `@v5` major,
  pinned major-float (`@v5`), not a commit SHA.
- Every usage shall keep `node-version` set explicitly to node 24.
- No usage shall depend on the `cache` input.
- When CI runs under v5, typecheck, unit tests, `verify-dist`, and the
  integration suite shall pass.
- When an external adopter runs the composite under v5, the dispatcher
  shall provision node 24, unchanged from `@v4`.

**Scope and alternatives.**

- *SHA-pinning every action* for supply-chain hardening is a separate,
  repo-wide decision and is out of scope; this change follows the existing
  major-float convention.
- *Adopting the `cache` input* while touching these steps is a separate
  decision, not part of this bump; the steps remain cache-free.

§req:setup-node-v5-constraints

## Pre-flight finding classification §spec:preflight-classification

*Status: complete*

Setup tooling speaks one vocabulary for "what is wrong with my setup."
Every finding emitted by `init.sh`'s pre-flight pass and by `doctor.sh`
carries two independent labels: a **bucket** — one of `local-env`,
`instance`, `config` — and a **severity** — one of `block`, `warn`,
`info`. The bucket answers *whose problem this is and when it gets fixed*;
the severity answers *how bad it is*. The two are orthogonal: a `block`
may be `local-env` (`gh` not authenticated) or `instance` (the repo
already runs release-please), and a `config` finding may be `warn`
(`allow_auto_merge` disabled) or `info`. §req:preflight-detection
§req:preflight-detection-constraints

The buckets carry fixed meanings an adopter can act on without reading
docs:

- **`local-env`** — a condition on the adopter's own machine or account
  (a missing or under-scoped `gh`), which they fix themselves before
  setup can proceed. A pre-flight concern.
- **`instance`** — a one-time fix to *this* repository made during
  install (a conflicting release system to remove). An install-time
  concern that does not recur once resolved.
- **`config`** — an ongoing configuration setting that lives on past
  install (`allow_auto_merge`, `delete_branch_on_merge`). A long-term
  concern that can drift later.

**Why two axes rather than one severity scale.** Before this change an
adopter could read a finding's seriousness but never its ownership or
lifetime — the same "`allow_auto_merge` disabled" message read
identically whether it was theirs to fix on their machine, a one-shot
repo edit, or a setting that would silently regress. Collapsing
ownership-and-lifetime into the severity scale loses information the
adopter needs to know *who* fixes a finding and *whether it comes back*.
Keeping the axes independent lets every (bucket, severity) combination
carry its own meaning. §req:preflight-detection-stories
§req:preflight-detection-constraints

**Why init and doctor share the vocabulary.** An adopter wiring up
flywheel previously met two languages: init's ad-hoc `error:` / `warning:`
prefixes and doctor's `FAIL` / `WARN` / `NOTE`. doctor's existing severity
levels map onto the shared names (`FAIL`→`block`, `WARN`→`warn`,
`NOTE`→`info`), and doctor additionally prints each finding's bucket
label. Whether init and doctor share implementation code is a build-time
decision deferred to ROADMAP; the spec requires only that the *vocabulary*
— bucket names and severity names — is identical across the two tools.
doctor stays read-only and keeps its exit contract: exit 1 when any
`block`-severity finding is present, 0 otherwise. §req:preflight-detection
§req:preflight-detection-criteria §req:preflight-detection-constraints

**Criteria.**

- Every finding emitted by init's pre-flight pass and by `doctor.sh` shall
  carry exactly one bucket from {`local-env`, `instance`, `config`} and
  exactly one severity from {`block`, `warn`, `info`}.
- The bucket and severity names shall be identical between init's
  pre-flight and `doctor.sh` — an adopter reads one vocabulary, not two.
- `doctor.sh` shall print the bucket label on each finding it reports.
- `doctor.sh` shall remain read-only — it probes state and prints
  findings, and writes nothing to the repository.
- `doctor.sh` shall exit 1 when any `block`-severity finding is present
  and 0 otherwise, unchanged from its current contract.
- When `gh` is unauthenticated the finding shall read `local-env` +
  `block`; when the repo already runs an interfering release system the
  finding shall read `instance` + `block`; when `allow_auto_merge` is
  disabled the finding shall read `config` + `warn`.

**Scope and alternatives.**

- *A single combined severity-with-ownership scale* (e.g. five levels from
  "fix-on-your-machine-now" to "advisory-config") was rejected: it forces
  one ordering on two genuinely independent questions and produces a scale
  no one can memorize.
- *Sharing a finding-emitter implementation between init and doctor* is a
  reasonable build choice but is left to ROADMAP; the spec constrains the
  vocabulary, not the code path.

## Pre-flight gate and control flow §spec:preflight-gate

*Status: complete*

`init.sh` runs a single pre-flight detection pass as the **first** thing
it does — before it issues any prompt and before it writes any file
(`.flywheel.yml`, the two workflow files, `.gitattributes`, merge-driver
git config). An adopter whose environment or repository has a
`block`-severity problem learns of it while nothing has been written yet;
setup never leaves a half-laid scaffold behind a late-discovered blocker.
§req:preflight-detection §req:preflight-detection-criteria
§req:preflight-detection-constraints

Severity drives control flow:

- A **`block`** halts setup. **Interactively**, setup stops and does not
  begin scaffolding until the adopter resolves the condition — or, where
  an override is offered, passes it deliberately. **Non-interactively** (no
  TTY, e.g. `curl … | bash` or CI), a `block` causes setup to exit
  non-zero with the reason printed, rather than proceeding on defaults the
  way init does today.
- **`warn`** and **`info`** are advisory. They are reported in the
  pre-flight summary and never halt setup, interactively or not.

**Why detection precedes action.** Today init discovers the
environment piecemeal and late — it prompts and writes, then probes for
App credentials or account type partway through, and a missing
prerequisite surfaces only after the scaffold is partly written or as a
raw `gh` error in a later step. Moving the full detection pass ahead of
the first prompt or write makes "before setup starts" literal: the
pre-flight summary is the first thing the adopter sees, and a `block`
stops setup before any repository state changes. §req:preflight-detection
§req:preflight-detection-stories

**Why non-interactive runs fail loudly.** A maintainer running setup in CI
or via `curl … | bash` cannot answer a prompt; init's current behavior of
printing a problem and continuing on defaults means an unattended setup
can scaffold over a broken environment silently. Exiting non-zero with the
reason makes the failure visible to the surrounding automation.
§req:preflight-detection-stories §req:preflight-detection-constraints

**Why the override is explicit and never default.** Setup never silently
proceeds past a `block`. Where an override is offered (the existing
release-system block, per §spec:preflight-release-conflict), it is an
opt-in flag the adopter passes deliberately — a recorded decision, not
a default that erodes the gate. §req:preflight-detection-constraints

**Backward compatibility.** On a clean machine and a clean repository the
pre-flight pass finds no blockers, prints a passing summary, and setup
proceeds exactly as before. The pass is purely additive to a healthy
setup's flow. Adopters consuming flywheel as a GitHub Action are
unaffected — this is setup-time tooling only, adding no Action behavior
and no GitHub App scope. §req:preflight-detection-criteria
§req:preflight-detection-constraints

**Criteria.**

- When `init.sh` runs, the pre-flight detection pass shall complete before
  any prompt is issued and before any file is written.
- When a `block`-severity finding is present and the run is interactive,
  setup shall not write any scaffold file until the adopter resolves the
  condition or passes an offered override flag.
- When a `block`-severity finding is present and the run is
  non-interactive, setup shall exit non-zero and print the reason.
- `warn`- and `info`-severity findings shall not halt setup in either
  mode.
- When the environment and repository are clean, the pre-flight pass shall
  report no blockers, print a passing summary, and setup shall proceed
  unchanged from its prior behavior.
- Detection shall be read-only — it probes local tools, `gh` auth state,
  and repo/remote state, and requests no privilege beyond what setup
  already needs.

**Scope and alternatives.**

- *Keeping late probing and merely improving error messages* was rejected:
  a clearer message after a half-written scaffold still leaves the adopter
  to unwind partial state. The fix is ordering, not wording.
- *Defaulting non-interactive runs past blocks for convenience* was
  rejected: it reintroduces the silent-scaffold-over-broken-environment
  failure the gate exists to prevent.

## Pre-flight gh capability detection §spec:preflight-gh-capability

*Status: complete*

The pre-flight pass reports, up front, whether `gh` is installed,
authenticated, and carries the **specific** scopes and permissions the
path the adopter chose needs — and, for a missing one, names the later
step it would block. A scope gap surfaces as a labelled finding before any
write, not as a raw `gh` API error mid-run. These are `local-env` findings
(the adopter fixes them on their own machine/account); a missing required
scope is `block` severity. §req:preflight-detection
§req:preflight-detection-criteria §req:preflight-detection-stories

The scopes checked are tied to what the chosen path actually does:

- **repo-admin** — needed to write the `FLYWHEEL_GH_APP_ID` variable and
  the `FLYWHEEL_GH_APP_PRIVATE_KEY` secret and to apply rulesets.
- **`admin:org`** — needed when credentials are scoped org-wide.
- **GitHub-App creation permission** — needed when the adopter asks init
  to create the App.

**Why scope detection up front, tied to the blocked step.** init proceeds
optimistically and dies at the first `gh` call that exceeds the token's
grant, with an error naming the API call rather than the missing
prerequisite — and today the credential/ruleset `gh` calls swallow scope
failures with `|| true`, so setup re-prompts or silently does nothing
instead of reporting the gap. Detecting the scopes the chosen path needs,
before that path runs, lets setup say "this token lacks repo-admin, which
the App-ID variable write in a later step needs" instead of surfacing an
opaque API error after the adopter has already answered prompts.
§req:preflight-detection §req:preflight-detection-stories
§req:preflight-detection-constraints

**Why the checks are path-specific.** The required scopes depend on the
adopter's choices — repo- versus org-scoped credentials, whether init
creates the App. Probing only the scopes the chosen path needs avoids
blocking an adopter on a permission their path never exercises. (Threat
note: scope detection only *reads* `gh` auth state; it grants nothing and
requests no permission beyond what setup already needs — it exists partly
to surface when those permissions are absent.) §req:preflight-detection
§req:preflight-detection-constraints

**Criteria.**

- The pre-flight pass shall report whether `gh` is installed and
  authenticated as `local-env` findings.
- When the chosen path needs a scope the authenticated token lacks, the
  pass shall report a `local-env` + `block` finding that names the missing
  scope and the later step it would block.
- A path writing repo-level credentials or applying rulesets shall check
  for repo-admin; a path scoping credentials org-wide shall check for
  `admin:org`; a path that asks init to create the App shall check for
  GitHub-App creation permission.
- A missing scope shall be reported before any prompt or write, not as a
  raw `gh` API error during a later step.
- Scope detection shall read `gh` auth state only and shall request no
  additional privilege.

**Scope and alternatives.**

- *Requesting the union of all scopes regardless of path* was rejected: it
  blocks adopters on permissions their chosen path never uses.
- *Catching the `gh` API error at the call site and re-explaining it* was
  rejected: by then prompts have been answered and scaffold may be
  written; the value is in reporting before action.

## Existing release-system detection §spec:preflight-release-conflict

*Status: complete*

The pre-flight pass detects whether the repository **already runs a
release system that would race flywheel's releases** — another tag or
release producer such as release-please, a separate semantic-release, or
hand-rolled `gh release create` / `git tag` / `npm version` in a push or
dispatch workflow — and reports it as an `instance` + `block` finding.
Layering flywheel on top of such a system produces two pipelines racing to
tag and publish, a conflict the adopter would otherwise discover only when
releases start colliding. §req:preflight-detection
§req:preflight-detection-criteria §req:preflight-detection-stories

Interactive setup **halts** on this finding unless the adopter passes an
explicit override flag; the override is a deliberate action, never a
default (per §spec:preflight-gate). Non-interactively, the block exits
non-zero like any other.

**Why best-effort and minimal, biased toward false negatives.** The check
covers the systems that would actually race flywheel's releases — not an
exhaustive audit of every release tool in existence. It is deliberately
tuned to tolerate a missed exotic system (a false negative) rather than
block a clean repo on a false positive: a needless block on a healthy repo
is friction every adopter might hit, whereas a missed exotic system is
rare and still caught downstream when releases actually collide.
§req:preflight-detection-criteria §req:preflight-detection-constraints

**Why `instance` + `block`.** A conflicting release system is a one-time
fix to *this* repository made during install — remove or disable the other
producer — so it is bucketed `instance`. It is `block` because proceeding
produces colliding releases, the most damaging silent outcome in the
onboarding cluster; the adopter decides deliberately (resolve or
override) before flywheel layers on top. §req:preflight-detection-stories
§req:preflight-detection-constraints

**Criteria.**

- When the repository runs a known flywheel-interfering release producer
  (release-please, a separate semantic-release, or hand-rolled
  `gh release create` / `git tag` / `npm version` in a push or dispatch
  workflow), the pass shall report an `instance` + `block` finding.
- Interactive setup shall halt on this finding unless the adopter passes
  an explicit override flag; the override shall never be the default.
- The check shall be scoped to known interfering producers, not an
  exhaustive release-tool scanner.
- The check shall prefer a false negative (missing an exotic system) over
  a false positive that blocks a clean repository.

**Scope and alternatives.**

- *An exhaustive release-tooling scanner* was rejected: the cost of false
  positives — blocking clean repos — outweighs catching every exotic
  system, which is caught downstream when releases collide.
- *Auto-disabling the detected system* is out of scope: detection is
  read-only and the adopter owns the one-time `instance` fix.

## Pre-flight credentials and App detection §spec:preflight-credentials-app

*Status: complete*

The credentials detection — the `FLYWHEEL_GH_APP_ID` variable and the
`FLYWHEEL_GH_APP_PRIVATE_KEY` secret, at both repo and org level — and the
GitHub-App existence/installation detection run as part of the **same**
pre-flight pass and are classified on the same two axes as every other
finding. #232 ships the complete pre-flight pass; the sibling issues
(#234–242) refine the prompts and messaging that *consume* these findings.
§req:preflight-detection §req:preflight-detection-criteria
§req:preflight-detection-constraints

**Why these detections belong in the spine, not the siblings.** The
credentials prompt (#234–242) and the GitHub-App detection both need the
same environment-probing and classification capability. Building detection
and vocabulary once here — and having the sibling issues refine only the
prompts and messaging on top — avoids each feature reinventing detection or
inventing a third vocabulary. The pre-flight pass is the shared spine of
the setup-onboarding cluster; this section fixes the scope boundary
between what #232 detects and what the siblings present.
§req:preflight-detection §req:preflight-detection-stories
§req:preflight-detection-constraints

**Scope boundary.** In scope for #232: detecting whether the App-ID
variable and private-key secret exist (repo- and org-level) and whether
the GitHub App exists and is installed, and classifying each on the
bucket × severity axes. Out of scope for #232 and deferred to the
siblings: the wording and flow of the credentials prompt, the
create-versus-reuse App choice presentation, and the install-confirmation
messaging. §req:preflight-detection-constraints

**Criteria.**

- The credentials detection (the `FLYWHEEL_GH_APP_ID` variable and
  `FLYWHEEL_GH_APP_PRIVATE_KEY` secret, at repo and org level) shall run as
  part of the pre-flight pass and carry a bucket and severity.
- The GitHub-App existence/installation detection shall run as part of the
  same pre-flight pass and carry a bucket and severity.
- The detection capability and the classification vocabulary shall be
  reusable by the credentials and GitHub-App sibling work (#234–242)
  without redefining either.
- The prompts and messaging that consume these findings are out of scope
  for this section and are refined by the sibling issues.

**Scope and alternatives.**

- *Letting each sibling issue probe credentials and App state on its own*
  was rejected as the explicit anti-goal: it reinvents detection per
  feature and risks a third severity vocabulary. Detection and vocabulary
  are built once here and reused.

## apply-rulesets self-provisions PyYAML ephemerally §spec:apply-rulesets-pyyaml

*Status: complete*

`scripts/apply-rulesets.sh` is the one-shot setup step an adopter runs once
per repository — documented in `docs/adopter/setup.md` (§5) as a
`curl -fsSL … | bash -s -- <owner/repo>` one-liner — to apply Flywheel's
branch- and tag-protection rulesets. To enumerate the managed branches it
runs two small Python snippets that load `.flywheel.yml` with PyYAML: one
emits every managed branch ref, the other the subset with
`release: production`. The script never asks the adopter to install PyYAML
and never leaves anything installed on their machine. When PyYAML is missing,
the script provisions it for itself in a throwaway location, uses it for the
two parses, and removes it before exiting. §req:apply-rulesets-pyyaml
§req:apply-rulesets-pyyaml-criteria

**The behavior is ephemeral because the need is ephemeral.** The script runs a
single time per repository, so a dependency it needs only for that run leaves
no trace afterward. On stock macOS — the common case — the Xcode Command Line
Tools `python3` (3.9.x) adopters actually have does not ship PyYAML, so a
first-time adopter following the documented setup would otherwise hit a hard
stop on the very first Flywheel action they take. Rather than instruct them to
*permanently* mutate their user site-packages for a one-shot script (the prior
`pip3 install --user pyyaml` message), the script automates exactly the
workaround the reporter of #245 performed by hand: stand up a disposable
PyYAML, use it, tear it down. §req:apply-rulesets-pyyaml
§req:apply-rulesets-pyyaml-stories

**Why keep PyYAML rather than drop it.** The two reads must stay byte-for-byte
equivalent to today's output — the same complete list of managed branch refs
and the same `release: production` subset, feeding the same ruleset behavior.
PyYAML is what computes that result now; continuing to parse `.flywheel.yml`
with PyYAML is the surest guarantee of parse parity. Hand-rolling a YAML parser
in shell/`awk`, or swapping in a different YAML tool, would re-implement the
parse and risk diverging on quoting, anchors, or block structure for no
adopter-visible gain. The change is to *how the dependency is satisfied*, not
to *what the parses compute*. §req:apply-rulesets-pyyaml-criteria
§req:apply-rulesets-pyyaml-constraints

**Tiered satisfaction, fast path preserved.** When the invoking `python3`
can already `import yaml`, the script uses it directly — no provisioning, no
added latency, no extra steps. An adopter who already has PyYAML sees no
change. Only when the import fails does the script provision an ephemeral,
isolated environment (a throwaway interpreter context that exists for the
duration of the run and nowhere in the adopter's persistent Python install),
satisfy PyYAML there, and run the two parses against it. The provisioning
installs PyYAML and nothing else, into an isolated throwaway location, so it
cannot alter the adopter's interpreter or global/user packages. The cleanup is
unconditional — it runs whether the script succeeds, fails, or is interrupted —
so a partial run leaves nothing behind. §req:apply-rulesets-pyyaml
§req:apply-rulesets-pyyaml-criteria §req:apply-rulesets-pyyaml-constraints

**Graceful degradation, not a cryptic stop.** Where self-provisioning
genuinely cannot work in a given environment — for example an interpreter with
`ensurepip` stripped (some Debian/Ubuntu builds) and no alternative provisioner
available, or no network to fetch the package — the script exits with a clear,
copy-pasteable, actionable message naming the precise remedy for that
environment, rather than the bare `PyYAML is required` import error. The
failure path is the exception, reached only after auto-provisioning has been
attempted and ruled out. §req:apply-rulesets-pyyaml-criteria
§req:apply-rulesets-pyyaml-constraints

**Documentation matches reality.** The script's header comment no longer
claims PyYAML is `preinstalled on macOS` — true only of the retired system
Python 2, not the Xcode CLT `python3` adopters have. Its stated dependencies
describe what adopters actually run and how the script obtains PyYAML when it
is absent. §req:apply-rulesets-pyyaml §req:apply-rulesets-pyyaml-stories

**Blast radius.** The change is confined to `apply-rulesets.sh` — its
dependency-resolution preamble and header comment — and to the matching
dependency note in `docs/adopter/setup.md`. The ruleset-application logic (the
`gh api` calls, payload assembly, idempotent create-or-replace) is untouched.
Because the script runs unauthenticated-input-free over an `owner/repo`
argument the adopter supplies and fetches only PyYAML into a disposable
location, auto-provisioning adds a runtime network dependency on the package
index but no persistent footprint and no new credential surface.
§req:apply-rulesets-pyyaml-constraints

**Criteria.**

- When an adopter on stock macOS (Xcode CLT `python3`, no PyYAML) runs the
  script as documented, the script shall complete end-to-end without any
  manual dependency install and without prompting the adopter to install
  anything.
- After the script exits — on success, failure, or interruption — the
  adopter's Python environment and user site-packages shall be exactly as
  they were before; nothing PyYAML-related shall remain installed.
- When the invoking `python3` can already `import yaml`, the script shall use
  it directly, adding no provisioning step and no latency.
- The two `.flywheel.yml` reads shall produce results identical to today: the
  complete list of managed branch refs, and the `release: production` subset,
  with the same downstream ruleset behavior.
- When self-provisioning genuinely cannot succeed in the environment, the
  script shall exit with a clear, copy-pasteable, actionable message naming
  the remedy — not a bare import error.
- The script's header comment shall not claim PyYAML is preinstalled on
  macOS; the stated dependencies shall match what adopters actually have and
  how the script obtains PyYAML when it is missing.

**Scope and alternatives.**

- *Instructing a persistent `pip install`* (the prior behavior) is rejected:
  it leaves a lasting change on the adopter's machine for a script run once —
  the core grievance of #245.
- *Dropping PyYAML for a hand-rolled or alternate-tool YAML parse* is rejected:
  it risks parse divergence against a hard parse-parity requirement for no
  adopter-visible benefit, and a different tool (`yq`) is no more likely to be
  present on stock macOS than PyYAML.
- *Requiring a project checkout or a pre-existing virtualenv* is rejected: the
  script must stay `curl … | bash`-friendly and safe to re-run, with no
  assumption of local project tooling.

§req:apply-rulesets-pyyaml-constraints §req:apply-rulesets-pyyaml-stories
## Stdin-safe ruleset application §spec:apply-rulesets-stdin

*Status: complete*

The `apply-rulesets.sh` one-liner documented in `docs/adopter/setup.md` §5
— `curl -fsSL …/apply-rulesets.sh | bash -s -- <owner/repo>` — applies the
full set of branch and tag protection rulesets end to end for an adopter
who has no Flywheel checkout. The piped run resolves its four ruleset
templates (`managed-branches.json`, `managed-branches-review.json`,
`tag-namespace.json`, `release-gate.json`) regardless of the working
directory the adopter happens to be in — `$HOME`, an unrelated repository,
or an empty `mktemp -d` all produce the same applied rulesets. No run dies
with exit 2 or "Could not open file" before the first GitHub API call.
§req:apply-rulesets-stdin §req:apply-rulesets-stdin-criteria

**The problem this fixes.** A script piped through `bash` has no file on
disk, so `BASH_SOURCE[0]` is unset. `apply-rulesets.sh` located its
templates with `SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"`
and read `"$SCRIPT_DIR/rulesets/<name>.json"` — a self-location that only
resolves when the script's own file is present. Under the piped form, with
`set -u` active, the unbound `BASH_SOURCE[0]` degrades `SCRIPT_DIR` to the
caller's working directory; the subsequent `jq … "$SCRIPT_DIR/rulesets/…"`
read fails unless the caller already stands inside a Flywheel checkout —
exactly the situation the piped form exists to avoid. The documented first
protection step of the quick path therefore never applied anything for an
adopter taking the piped route. §req:apply-rulesets-stdin

**The resolution rule — local first, then fetch, mirroring the sibling
scripts.** The fix adopts the self-location idiom the other stdin-safe
quick-start scripts already use (`init.sh`, `doctor.sh`): guard
`BASH_SOURCE[0]` under strict mode (`${BASH_SOURCE[0]:-}`), use the bundled
`rulesets/` directory when the script runs from a checkout, and otherwise
fetch the four templates over the network — the same `raw.githubusercontent.com`
source the run was itself piped from, and the same source `init.sh` fetches
its `templates/` from. This was chosen over inventing a new mechanism
because (a) it is the proven idiom already in this script family, (b) it
keeps the `rulesets/*.json` files the single source of truth rather than
duplicating them, and (c) it makes the invocation contract uniform across
`init.sh`, `doctor.sh`, and `apply-rulesets.sh` — a consistency the
requirement calls for in its own right. §req:apply-rulesets-stdin-constraints

**Version-consistent templates without self-location.** Because a piped
script cannot read its own file, it cannot derive from the runner which
Flywheel ref it was fetched from. The templates a piped run applies shall
nonetheless match the logic of the script applying them, never a silent
script-from-one-version / shapes-from-another mismatch. The fetch therefore
draws from a deterministically chosen ref — the same ref the documented
`curl` URL publishes from — rather than from anything inferred at runtime,
and the ruleset JSON shapes the script's `jq`/`gh` logic depends on stay
stable across versions. A checkout run is inherently consistent because it
reads the templates shipped alongside it. §req:apply-rulesets-stdin-constraints

**Docs present only invocation forms that work.** `docs/adopter/setup.md`
(and the README, where it documents one-liners) shows a piped form for
`apply-rulesets.sh` only because the piped form now works; the checkout
form is documented alongside as before. Every script the docs present as a
`curl … | bash` one-liner is verified stdin-safe — none carries a latent
`BASH_SOURCE`/`SCRIPT_DIR` self-location failure. Where a script shall run
from a checkout, the docs do not show a piped form for it. The maintainer
learns of any such latent failure from this audit rather than from an
adopter's bug report. §req:apply-rulesets-stdin-criteria §req:apply-rulesets-stdin-stories

**Fail clean, idempotent, strict, no new dependencies — all preserved.** A
run that cannot obtain valid templates (e.g. no network on a piped run)
still aborts before creating any ruleset, flipping `delete_branch_on_merge`,
or changing any repository setting — the adopter's repository is left
exactly as it was found, never half-protected. The create-or-replace-by-name
behaviour is untouched: re-running (piped or from a checkout) updates
existing rulesets in place rather than stacking duplicates. The fix coexists
with `set -u` and the script's other strict-mode guards rather than relaxing
them to paper over the unbound variable. It imposes no tool or privilege on
the adopter beyond what the script already requires (`gh`, `jq`,
`python3`/PyYAML, and network — a piped run is itself network-fetched and
calls the GitHub API). §req:apply-rulesets-stdin-criteria §req:apply-rulesets-stdin-constraints

**Same shape as the composite-action-path defect.** This is the
§req:composite-action-path failure mode (§spec:composite-self-reference) in
a second place: a code path only the real adopter exercises — consuming a
Flywheel script without Flywheel's source already on disk — that the
project's own runs, which always have the checkout present, never modelled.
The fix is to make that path work and to widen the audit to every documented
one-liner, so the class is closed rather than patched at one site.
§req:apply-rulesets-stdin

**Alternatives considered.**

- *Embed the four ruleset JSONs inline in the script* (heredocs), so a
  piped run carries its own templates and there is zero script/template
  version skew by construction. This is the strongest version-consistency
  guarantee, but it duplicates the `rulesets/*.json` files into the script
  (a new drift surface needing its own parity guard) and diverges from the
  local-first/fetch idiom the sibling scripts use — losing the uniform
  invocation contract the requirement asks for. Rejected in favour of the
  sibling-script idiom plus stable, deterministically-sourced templates.
- *Relax `set -u` or default `SCRIPT_DIR` to a hardcoded path.* Papers over
  the unbound `BASH_SOURCE[0]` without making the piped path actually find
  its templates, and weakens the strict-mode guard the script relies on to
  fail fast. Rejected.
- *Document the piped form away — show only the checkout invocation.* Keeps
  the docs honest at the cost of the quick-path capability the piped form
  exists to provide, and leaves the adopter who pipes `init.sh`/`doctor.sh`
  successfully to wonder why this one script is special. Rejected: the
  decided outcome is to make the documented command work, not to retract it.

## Stdin-path ruleset regression test §spec:apply-rulesets-stdin-test

*Status: complete*

A test in Flywheel's cheap suite — unit / per-PR CI, not the rate-limited
e2e sandbox — runs `apply-rulesets.sh` the way an adopter pipes it: read
from stdin, with no Flywheel checkout in the working directory. It fails
when the script cannot resolve its four ruleset templates and passes once
the script resolves them. This class of break — a Flywheel script unable to
find its own bundled assets when run without a workspace that already holds
Flywheel's source — is caught before a release is built, not only by the
e2e gate or by an adopter. §req:apply-rulesets-stdin-criteria §req:apply-rulesets-stdin-stories

**Why the cheap suite, and why e2e was not enough.** The defect shipped
because every-PR suites always invoked the script from a checkout, where
`SCRIPT_DIR` resolves and the templates are found; only the adopter path,
which the cheap suites never modelled, exercises the stdin self-location.
A cheap test moves first detection of this class to every PR. The test
reproduces the failure at template resolution — before any `gh` API call —
so it needs no live GitHub access and adds no load to the rate-limited
sandbox installation the e2e suite already strains (§spec:sandbox-test-budget,
§req:sandbox-ci-budget). This mirrors the cheap adopter-style guard added
for the composite-action-path defect (§spec:adopter-resolution-test).
§req:apply-rulesets-stdin §req:apply-rulesets-stdin-constraints

**What the test asserts.** The guard models the resolution outcome, not a
literal code shape: piped from stdin in a directory containing no Flywheel
source, the script obtains all four ruleset templates rather than aborting
on a missing `SCRIPT_DIR/rulesets/…` read. A reviewer can state the property
in one sentence — "piped with no checkout, the script still finds its
templates" — and it stays true after the underlying resolution mechanism
changes. §req:apply-rulesets-stdin-criteria

**Backstop unchanged.** The e2e suite keeps exercising the full adopter
path as a backstop; it is no longer the first line of defence for this bug
class. §req:apply-rulesets-stdin-criteria

## Setup completion summary §spec:setup-completion-summary

*Status: complete*

`init.sh` ends with an **outcome summary** that reports what the run
actually did, not a fixed "Next steps" list. Today the run closes with a
static block — review `.flywheel.yml`, commit and push, open a smoke-test
PR, run `doctor.sh` — printed identically whether the adopter configured
App credentials or skipped them, applied the protection rulesets or
declined, hit a pre-flight blocker or sailed through clean. The new summary
accounts for **every scaffold step init can touch**, each with its real
outcome: the `.flywheel.yml` preset, the two adopter workflow files,
`.gitattributes` plus the merge-driver git config, the App credentials (the
`FLYWHEEL_GH_APP_ID` variable and `FLYWHEEL_GH_APP_PRIVATE_KEY` secret), and
ruleset application. Each step reads as **configured**, **skipped**,
**failed**, or **deferred** to the adopter. §req:setup-completion-summary
§req:setup-completion-summary-criteria §req:setup-completion-summary-stories

The summary closes with an **explicit verdict**: "complete", or
"incomplete — N items remain". A **deliberate skip is not a failure** —
when the adopter answers no to a step or passes a `--skip-*` flag, the
verdict can still read "complete", with the skipped item listed as deferred
alongside the exact command that finishes it later. Only a step that was
meant to run and failed, or an unresolved `block`-severity finding, makes
the verdict "incomplete". §req:setup-completion-summary-criteria
§req:setup-completion-summary-constraints

Outstanding and deferred items are **labelled in the pre-flight
vocabulary** — the same `local-env` / `instance` / `config` bucket and
`block` / `warn` / `info` severity axes the pre-flight pass and `doctor.sh`
already speak (§spec:preflight-classification). "App credentials not set"
reads as the same kind of thing at completion as it would at pre-flight, so
the adopter meets one vocabulary at the start of the run and the same one at
the end. Each deferred item names **the exact command that finishes it** —
the `scripts/apply-rulesets.sh <repo> --app-id <id>` line init already emits
for skipped rulesets, surfaced uniformly for every deferred step — so the
adopter never reconstructs the remaining work from scrollback.
§req:setup-completion-summary-criteria §req:setup-completion-summary-stories
§req:setup-completion-summary-constraints

**Why an outcome summary replaces the fixed block.** The static list left
the adopter to reconstruct from scrollback what was configured, skipped, or
half-done, and to remember a *separate* validator to learn whether any of it
took. There was no single moment that said "here is what I did, here is
what is left, here is whether you are ready." The cost is friction on every
adoption — frequent, mandatory, first-run-experience — rather than a
release-correctness fault; the fix is to make the run's last screen report
its own result. §req:setup-completion-summary §req:setup-completion-summary-stories

**Why reuse the pre-flight vocabulary rather than invent a third.** The rest
of the setup cluster (#234–242) already taught the adopter one language for
"what is wrong" — bucket × severity, shared between init's pre-flight and
doctor. A separate end-of-run vocabulary would make the adopter learn a
second way to describe the same kinds of problem. Reusing bucket × severity
keeps init's pre-flight, init's completion summary, and doctor speaking one
language end to end. §req:setup-completion-summary-constraints

**Why a deliberate skip cannot read as failure.** Conflating an adopter's
intentional choice (answered no, passed `--skip-*`) with a step that was
supposed to run and did not would train adopters to ignore "incomplete",
defeating the signal the verdict exists to carry. The verdict distinguishes
the two; a deferred-by-choice item is reported with its finishing command,
not as a fault. §req:setup-completion-summary-constraints

**Additive to the happy path.** A clean greenfield run that configures
everything ends with an all-configured summary and a "complete" verdict.
The change never turns a healthy setup into a scary one — it adds a passing
summary, nothing more, to a run that previously just printed boilerplate.
§req:setup-completion-summary-criteria §req:setup-completion-summary-constraints

**Criteria.**

- When `init.sh` finishes, it shall print a summary that lists every
  scaffold step it can touch — the `.flywheel.yml` preset, the two workflow
  files, `.gitattributes` plus merge-driver git config, the App credentials
  (`FLYWHEEL_GH_APP_ID` variable and `FLYWHEEL_GH_APP_PRIVATE_KEY` secret),
  and ruleset application — each with its real outcome of configured,
  skipped, failed, or deferred.
- The summary shall end with a verdict of "complete" or "incomplete — N
  items remain".
- When a step was skipped by the adopter (answered no, or a `--skip-*`
  flag), the verdict shall still read "complete" and the step shall be
  listed as deferred; only a step that was meant to run and failed, or an
  unresolved `block`-severity finding, shall make the verdict "incomplete".
- Each outstanding or deferred item shall carry a bucket from {`local-env`,
  `instance`, `config`} and a severity from {`block`, `warn`, `info`}
  identical to the names used by the pre-flight pass and `doctor.sh`.
- Each deferred item shall name the exact command that finishes it.
- A clean greenfield run that configures every step shall end with an
  all-configured summary and a "complete" verdict, with no other change to
  the run's behavior.

**Scope and alternatives.**

- *Keeping the static "Next steps" block and merely appending a status
  line* was rejected: the block's flaw is that it ignores what the run did,
  and a verdict bolted onto stale prose still leaves the adopter
  reconstructing outcomes from scrollback.
- *A new completion-only severity scale* was rejected: it forces the
  adopter to learn a second vocabulary for problems the pre-flight already
  named in bucket × severity terms (§spec:preflight-classification).
- *Treating every deferral as "incomplete"* was rejected: it conflates a
  deliberate choice with a real failure and trains adopters to ignore the
  verdict.

## Setup self-validation at end of run §spec:setup-auto-validation

*Status: complete*

`init.sh` **auto-runs the `doctor.sh` validation at the end of every run** —
interactive or not — so the adopter sees a green/red confirmation that the
scaffold actually took, instead of being told to go run a separate
validator. The old run closed by *instructing* the adopter to run
`doctor.sh` themselves; the validation now happens as the final step of
setup, and its findings feed the same end-of-run summary
(§spec:setup-completion-summary). Because doctor already speaks the same
buckets and severity, init and doctor produce **one picture of "done", not
two**. §req:setup-completion-summary §req:setup-completion-summary-criteria
§req:setup-completion-summary-stories

**Why setup validates itself instead of delegating.** A separate validator
the adopter has to remember to run is a step that gets skipped, leaving the
adopter to walk away from a setup they never confirmed took. Folding the
validation into the run's tail means the last thing the adopter sees is a
confirmation the wiring holds — the green/red signal arrives without a
second command. §req:setup-completion-summary-stories

**Why the auto-validation respects the cost ceiling.** Running `doctor.sh`
costs `gh` API calls, and flywheel holds a deliberate API-budget posture
(§req:sandbox-ci-budget). The end-of-run validation stays within that
posture: it reuses what the run already learned — the pre-flight findings
and the per-step outcomes — where it can, rather than ballooning into a
heavy re-probe of the whole environment. The validation is a confirmation
pass, not a second full audit. §req:setup-completion-summary-constraints

**Why one picture of done.** doctor's findings and init's per-step outcomes
both flow into the single completion summary, classified on the same axes,
so an adopter who runs init and an adopter who later runs doctor read
consistent results — the run does not assert "complete" while doctor would
say otherwise. §req:setup-completion-summary-criteria
§req:setup-completion-summary-constraints

**Criteria.**

- When `init.sh` finishes, it shall run the `doctor.sh` validation
  automatically — in both interactive and non-interactive runs — without
  the adopter issuing a separate command.
- The validation's findings shall feed the same end-of-run summary and be
  classified on the same buckets and severity as the rest of the summary.
- The auto-validation shall reuse state the run already gathered where it
  can and shall not balloon into a full re-probe of the environment,
  staying within flywheel's API-budget posture (§req:sandbox-ci-budget).
- `doctor.sh` shall remain read-only when invoked this way — it confirms
  state and writes nothing to the repository.

**Scope and alternatives.**

- *Leaving validation as a documented manual step* was rejected: a step the
  adopter has to remember is the step that gets skipped, so setup confirms
  itself instead.
- *Re-probing the full environment from scratch at end of run* was
  rejected: it duplicates work the run already did and breaches the
  API-budget posture; the pass reuses known state.

## Non-interactive completion contract §spec:setup-exit-contract

*Status: complete*

In a **non-interactive run** (`curl … | bash`, CI) the completion summary
is **machine-readable** and `init.sh` **exits with a meaningful code**: zero
when setup is complete — including complete with deliberate deferrals — and
non-zero when a step that was meant to run failed or a `block`-severity
finding is unresolved. A clean setup the adopter intentionally trimmed still
exits zero. This lets an unattended pipeline tell a finished setup from a
half-finished one, where today a piped run prints "Next steps" and exits 0
regardless of what failed or was silently skipped.
§req:setup-completion-summary §req:setup-completion-summary-criteria
§req:setup-completion-summary-stories

A **strict mode** (a flag) **elevates `warn`-severity outstanding items to a
non-zero exit**, so a maintainer who wants CI to treat any deferred-or-warned
item as a failure-to-investigate can opt into it, while the default keeps
deliberate skips green. §req:setup-completion-summary-criteria
§req:setup-completion-summary-stories §req:setup-completion-summary-constraints

The exit semantics extend, and do not override, the pre-flight gate's
existing contract: a `block`-severity pre-flight finding still exits
non-zero (§spec:preflight-gate). This section governs the **end-of-run**
exit — after the scaffold steps have run — on the same severity vocabulary.
§req:setup-completion-summary-constraints

**Why the exit code is a stable, documented contract.** CI depends on the
exit code to gate a pipeline; if "complete-with-deferrals" sometimes exited
non-zero, or a real failure sometimes exited zero, the signal would be
useless. The default semantics (zero on complete including deliberate
deferrals, non-zero on real failure or unresolved block) and the strict
flag are a contract automation can build on, and the §spec:preflight-gate
block-exit behavior is preserved beneath it. §req:setup-completion-summary-constraints

**Why machine-readability does not cost interactive readability.** The
non-interactive summary is parseable, but the interactive run still reads as
human-friendly prose. One summary serves both audiences rather than forcing
a format good for neither — the same content, rendered for the reader at
hand. §req:setup-completion-summary-constraints

**Why a strict mode rather than changing the default.** Most adopters
deliberately defer steps (rulesets later, org-scoped credentials elsewhere)
and a default that failed CI on every deferral would punish ordinary use.
Strict mode is opt-in for maintainers who want every deferred-or-warned item
investigated, leaving the default green for intentional skips.
§req:setup-completion-summary-stories §req:setup-completion-summary-constraints

**Criteria.**

- In a non-interactive run, `init.sh` shall emit a machine-readable
  completion summary.
- `init.sh` shall exit zero when setup is complete, including complete with
  deliberate deferrals, and non-zero when a step that was meant to run
  failed or a `block`-severity finding is unresolved.
- A clean setup the adopter intentionally trimmed (via answered-no or
  `--skip-*`) shall exit zero.
- A strict-mode flag shall cause `warn`-severity outstanding items to
  produce a non-zero exit; without the flag, `warn`-severity items shall not
  fail the run.
- The pre-flight gate's existing `block`-severity non-zero exit
  (§spec:preflight-gate) shall be preserved, not overridden.
- The interactive run shall still render the summary as human-readable
  prose; one summary shall serve both the interactive and non-interactive
  audiences.

**Scope and alternatives.**

- *Making the default fail on any deferral* was rejected: most adopters
  defer steps on purpose, so the default stays green and strictness is
  opt-in.
- *A separate machine-only output mode divorced from the interactive
  summary* was rejected: two formats drift; one summary is rendered for
  both readers.
- *Overriding the pre-flight gate's exit behavior* was rejected: this
  section adds an end-of-run exit on the same vocabulary and preserves the
  pre-flight contract beneath it.

## Brownfield walkthrough completion parity §spec:setup-completion-docs-parity

*Status: complete*

The manual §0 brownfield walkthrough in `docs/adopter/setup.md` ends with a
**completion check that mirrors the script's verdict and vocabulary**. An
adopter retrofitting an existing repo by hand follows the walkthrough — audit
tags, disable prior release automation, confirm the bot can push, audit
recent commits — and today reaches the end with no single place confirming
the whole sequence is done. The walkthrough now closes the same way init
does: a check that reports outcomes in the `local-env` / `instance` /
`config` and `block` / `warn` / `info` terms used everywhere else, and lands
on the same "complete" / "incomplete" verdict. §req:setup-completion-summary
§req:setup-completion-summary-criteria §req:setup-completion-summary-stories

**Why the manual and scripted paths have to agree on "done".** When the script
defines "finished" one way (or, today, not at all) and the docs describe it
differently, an adopter who runs init and an adopter who follows the
walkthrough learn two different pictures of done. Aligning the walkthrough's
completion check with the script's verdict and vocabulary means both paths
reach one definition of finished. §req:setup-completion-summary-stories
§req:setup-completion-summary-constraints

**Criteria.**

- The §0 brownfield walkthrough in `docs/adopter/setup.md` shall end with a
  completion check whose verdict matches the script's "complete" /
  "incomplete" wording.
- That completion check shall describe outstanding items in the same
  `local-env` / `instance` / `config` buckets and `block` / `warn` / `info`
  severity the script and `doctor.sh` use.
- An adopter who follows the walkthrough and an adopter who runs `init.sh`
  shall reach the same definition of "finished".

**Scope and alternatives.**

- *Leaving the walkthrough to end at its last step with no completion check*
  was rejected: it leaves the manual adopter without the confirmation the
  scripted adopter gets, and lets the two paths diverge on what "done"
  means.
## doctor repo-field reads are three-state §spec:doctor-settings-read

*Status: complete*

Batch 1 (#239) landed the two named repo settings (`allow_auto_merge`,
`delete_branch_on_merge`): they read three-state via the `classify_repo_field`
helper, satisfying criteria 1–3 and 5–7. Batch 2 generalized the same treatment
to every permission-gated field read off an otherwise-successful `gh api`
response (criterion 4) — the `.private` visibility probe and the branch/tag
ruleset-detail reads now branch on call success and surface a `local-env` +
`warn` could-not-verify finding instead of collapsing a permission gap into a
false "absent"/"no coverage" block — closing the section.

`scripts/doctor.sh` reports a repository setting as **enabled**,
**disabled**, or **could-not-verify** — never collapsing the last into the
second. Under "Repo settings" doctor checks two GitHub options flywheel
depends on: `allow_auto_merge` (without it flywheel cannot schedule native
auto-merge, so eligible PRs fall back to a direct merge that bypasses
required status checks — see §spec:release-gate, #147/#153) and
`delete_branch_on_merge` (without it head branches linger after every
merge). Both are read off a single successful `gh api repos/<owner>/<repo>`
response. §req:doctor-settings-read §req:doctor-settings-read-criteria

**The false negative this closes.** GitHub omits these merge-setting fields
from the repository object entirely when the caller's token lacks
repo-admin: the API call still succeeds and returns the repo, just without
the admin-only fields. doctor previously treated a setting as enabled only
when its field read back exactly `true`, so an *absent* field — a `null`
read — was indistinguishable from a genuine `false` and reported as
**disabled**. An adopter running doctor with a non-admin or App
installation token was told to go re-enable settings that were already on,
chasing a non-problem and losing trust in the report; a check that
confidently misdirects is worse than one that stays silent.
§req:doctor-settings-read §req:doctor-settings-read-stories

The reads now distinguish three states. The field present and `true` is
enabled (reported `ok`, unchanged). The field present and `false` is
genuinely disabled — reported `config` + `warn` with the existing
remediation (re-run `scripts/apply-rulesets.sh`, or the Settings path),
unchanged. The field **absent** from an otherwise-successful response is
could-not-verify — reported `local-env` + `warn` with a message in the
same register as doctor's existing permission notes: "could not verify
`<setting>` — reading it requires repo-admin." doctor never asserts a
setting is off when it merely could not read it.
§req:doctor-settings-read-criteria §req:doctor-settings-read-constraints

**Why `local-env` + `warn` for could-not-verify.** A field hidden by an
under-scoped token is a condition on the adopter's own account, not a
misconfiguration of their repo — the same shape as doctor's existing
"could not list repo secrets — listing requires an admin PAT" finding,
which is already `local-env`. It is `warn`, not `block`: doctor cannot
confirm the setting either way, and a visibility limit must not halt a
read-only validator. This reuses the bucket × severity vocabulary of
§spec:preflight-classification (§req:preflight-detection) without inventing
a new severity or bucket name. §req:doctor-settings-read-criteria
§req:doctor-settings-read-constraints

**The fix generalizes beyond the two named settings.** The conflation
doctor avoids everywhere else — its variable, secret, and ruleset checks
already distinguish "could not read — needs admin" from "absent" by
inspecting whether the API *call* succeeded — was specific to fields read
off an otherwise-successful call. Every doctor check that reads a
permission-gated field off a successful `gh api` response distinguishes
enabled / disabled / could-not-verify; none silently reports "disabled" or
"absent" when the real cause is a permission gap. The two repo settings are
the identified instance, not a special case. §req:doctor-settings-read
§req:doctor-settings-read-criteria §req:doctor-settings-read-constraints

**Severity reconciliation is ratified, not re-opened.** `allow_auto_merge`
and `delete_branch_on_merge`, when genuinely disabled, report at the
**same** severity and bucket — `config` + `warn`. The pre-flight work
(#250, §spec:preflight-classification) already reconciled the historical
fail-vs-warn mismatch between them; this section records that as the settled
end state, not a new proposal. §req:doctor-settings-read-constraints

**Mechanism is open; behavior is fixed.** How doctor tells an absent field
from a `false` one (branching on `null` versus `false`, probing field
presence with `jq`, or another means) is an implementation choice the spec
does not pin — the section survives a change of mechanism. What is fixed is
the adopter-visible behavior: never a false "disabled."
§req:doctor-settings-read-constraints

**Scope and blast radius.** The change is confined to how doctor
*interprets* fields it already reads; it requests no additional scopes
(the whole point is to behave correctly when the token is under-scoped),
alters neither `apply-rulesets.sh` nor any setting nor any release
behavior, and leaves doctor read-only. The exit contract is unchanged:
neither a disabled-setting `warn` nor a could-not-verify `warn` is a block,
so doctor still exits 1 only when a `block`-severity finding is present and
0 otherwise (§spec:preflight-classification,
§req:preflight-detection-criteria). §req:doctor-settings-read-constraints

**Criteria.**

- When the setting is enabled and the token can read it (field present and
  `true`), doctor shall report it enabled, exactly as before.
- When the token cannot read the setting (the field is absent from an
  otherwise-successful `gh api` response), doctor shall report a
  `local-env` + `warn` "could not verify `<setting>` — reading it requires
  repo-admin" finding and shall not claim the setting is disabled.
- When the setting is genuinely disabled (field present and `false`),
  doctor shall report it `config` + `warn` with the existing remediation
  guidance, unchanged.
- Every doctor check that reads a permission-gated field off an
  otherwise-successful `gh api` response shall distinguish enabled,
  disabled, and could-not-verify; no such check shall report "disabled" or
  "absent" when the cause is a permission gap.
- `allow_auto_merge` and `delete_branch_on_merge`, when genuinely disabled,
  shall report at the same severity (`warn`) and bucket (`config`).
- doctor shall remain read-only and shall exit 1 only when a
  `block`-severity finding is present, 0 otherwise — neither the
  could-not-verify nor the disabled finding is a block.
- A fast test shall exercise the could-not-verify path: fed a repo response
  with the admin-gated fields absent, doctor reports "could not verify,"
  not "disabled." The test shall need no live GitHub access and add no load
  to the rate-limited sandbox installation
  (§spec:sandbox-test-budget, §req:sandbox-ci-budget).

**Scope and alternatives.**

- *Requesting repo-admin so the fields are always present* was rejected: it
  asks for privilege precisely where the value is behaving correctly
  without it, and an App installation token still could not see them.
- *Reporting could-not-verify as `block`* was rejected: doctor cannot
  confirm the setting either way, and a visibility limit on a read-only
  validator must not halt the adopter.
- *Fixing only the two named settings* was rejected: the same successful-call
  field-absence pattern can recur in any future repo-field read, so the
  three-state treatment is a property of every such check, not a patch to
  two lines.

## Dependabot deadlock: degraded-mode required check §spec:dependabot-degraded-check

*Status: complete*

When the conductor runs on a `pull_request` event and the App private key
arrives empty, it validates the PR title and posts the
`flywheel/conventional-commit` check — `success` or `failure`, reflecting the
title — and then exits without performing any App-privileged action. The
empty-key path is no longer "do nothing and skip"; it is "post the required
check, do nothing privileged, exit." This is what breaks the Dependabot
deadlock with zero adopter configuration: a Dependabot PR in a repo that
requires `flywheel/conventional-commit`, whose run cannot reach the App key,
still gets a concluded check instead of a permanently `Expected` one, so a
maintainer can merge it once it is green and reviewed. §req:dependabot-deadlock
§req:dependabot-deadlock-criteria

**Why posting the check is separable from granting auto-merge — and always
safe.** Posting a check needs only the low-privilege `checks: write`
capability the workflow's built-in `GITHUB_TOKEN` can carry; it needs none of
the App's authority. Auto-merge, title rewrite, label application, and
promotion-PR upserts need the App. Splitting the empty-key path so it posts the
check from the built-in token but mints no App token and runs no App-only
action satisfies *safe by default*: breaking the deadlock and granting
auto-merge become separate outcomes with separate triggers — the former
unconditional, the latter gated on the key being reachable
(§spec:dependabot-full-conductor-optin). A secret-less run gains exactly one
new ability: to post a pass/fail verdict on its own title — the very gate it
needs to pass — with no path to merge, label, or rewrite. §req:dependabot-deadlock
§req:dependabot-deadlock-constraints

**Why this fixes Dependabot but not forks — the same seam, a different token
reach.** Dependabot opens its PRs from branches in the *same* repository
(`dependabot/…`), so the PR workflow can grant the built-in token
`checks: write` and the degraded post succeeds. A fork PR's built-in token is
forced read-only by GitHub regardless of the workflow's `permissions:` block,
so the post cannot succeed there. The degraded path attempts the post on any
empty-key run and degrades gracefully when the token is read-only — so it
shares a seam with the fork case (#162) and may relieve it, but it makes no
claim to fix forks, whose residual read-only-token problem stays #162's.
§req:dependabot-deadlock §req:dependabot-deadlock-constraints

**Verdict parity.** The degraded path runs the title through the same
conventional-commit parser a first-party PR uses, so a Dependabot
`build(deps): …` or `chore(deps): …` receives the identical pass/fail verdict
it would receive on a first-party PR. The check is the same check
(`flywheel/conventional-commit`); only the token that posts it and the absence
of any follow-on action differ. §req:dependabot-deadlock-criteria

**Statelessness preserved.** The degraded path posts one check and returns; it
holds no state between runs and waits on nothing after posting.
§req:dependabot-deadlock-constraints

**Criteria.**

- When the App private key is empty on a `pull_request` run, the conductor
  shall post a `flywheel/conventional-commit` check whose conclusion reflects
  the title, using the workflow's built-in token rather than an App token.
- On that same empty-key run the conductor shall mint no App token and perform
  no App-only action — no title rewrite, no `flywheel:auto-merge` /
  `flywheel:needs-review` label, no native auto-merge, no promotion-PR upsert.
  The PR is made mergeable, not merged.
- The pass/fail verdict a Dependabot title receives shall equal the verdict the
  same title would receive on a first-party PR.
- The `apply-rulesets.sh` default that makes `flywheel/conventional-commit`
  required is unchanged; the fix posts the check, it does not weaken the
  default.
- Where the built-in token is read-only (the fork case), the path shall fail to
  post gracefully rather than error the run; fork-specific behaviour remains out
  of scope (#162).

**Scope and alternatives.**

- *Relaxing the `apply-rulesets.sh` default so the check is no longer required*
  is rejected: the defect is the unposted check, not the requirement. Weakening
  the default would let malformed titles through and remove the guard for every
  adopter, first-party PRs included.
- *Posting the check via the App token through a fallback secret, or
  auto-granting App powers to secret-less runs* is rejected: minting the App
  token is exactly what is impossible without the key, and handing App authority
  to an untrusted actor is the repository-compromise vector the requirement
  forbids.
- *Marking the check advisory (non-required) only for Dependabot* is rejected:
  Flywheel cannot un-require a ruleset check per-PR without weakening the
  ruleset for everyone, and it would re-open the malformed-title gap.

## Dependabot full conductor opt-in §spec:dependabot-full-conductor-optin

*Status: complete*

When the adopter registers `FLYWHEEL_GH_APP_PRIVATE_KEY` in the repository's
(or organisation's) **Dependabot** secret store — alongside the existing
Actions secret — a Dependabot-triggered run resolves the key non-empty
(GitHub sources `secrets.*` from the Dependabot store for Dependabot runs), the
empty-key path is not taken, and the conductor runs the full flow exactly as it
does for a first-party PR: the title is validated and rewritten if malformed,
the `flywheel:auto-merge` or `flywheel:needs-review` label is applied, native
auto-merge is enabled, and the PR auto-merges when its title type is in the
target branch's `auto_merge` set and every other required gate (other checks,
required reviews) is satisfied. A Dependabot PR is **never** auto-merged unless
the key is reachable on that run. §req:dependabot-deadlock
§req:dependabot-deadlock-criteria §req:dependabot-deadlock-stories

**The Dependabot secret store *is* the actor allowlist.** Trust is
GitHub-enforced, not Flywheel-configured. An external fork can never write to a
repository's Dependabot secret store, so a fork can never present the key, so a
fork can never auto-merge — the same gate, with no Flywheel-side list to
maintain. Adding a second trust mechanism (an `allowed_bots:` config, a
hardcoded `dependabot[bot]` allowlist) is rejected: it would duplicate GitHub's
trust boundary and risk drifting out of sync with it. Registering the secret is
a deliberate, GitHub-native act of trust; that act, and only that act, opts
Dependabot into the full flow. §req:dependabot-deadlock-constraints

**No new mechanism on this path — the opt-in is secret placement, not config.**
Once `FLYWHEEL_GH_APP_PRIVATE_KEY` resolves from the Dependabot store, the
existing conductor proceeds unchanged; nothing about the full flow is
Dependabot-specific. Auto-merge fires through the existing `auto_merge`
title-type matching with no special-casing of which dependency types merge — so
a `build(deps)` / `chore(deps)` bump auto-merges only if the adopter lists that
type in the branch's `auto_merge` set. The deliverable here is therefore the
documentation of the opt-in and the explicit, tested invariant that no
auto-merge occurs without the key — not a new code path for the keyed case.
§req:dependabot-deadlock-criteria §req:dependabot-deadlock-constraints

**Documented opt-in.** `docs/adopter/setup.md` documents registering the App
private key in the Dependabot secret store, alongside the Actions secret, as
the step that enables full Flywheel behaviour — auto-merge included — for
Dependabot PRs, so adopters enable it from the docs rather than discovering the
deadlock through a bug report. §req:dependabot-deadlock-criteria
§req:dependabot-deadlock-stories

**Supply-chain risk is the adopter's to accept, and off by default.**
Auto-merging Dependabot means a dependency update that passes checks can merge
without human review — the standard supply-chain tradeoff. Flywheel makes that
lever explicit and double-gated: it activates only when the adopter both
registers the Dependabot secret *and* lists the relevant types in a branch's
`auto_merge` set. Flywheel does not decide dependency trust on the adopter's
behalf. §req:dependabot-deadlock-constraints

**Criteria.**

- With the App key registered in the Dependabot secret store, a Dependabot PR
  shall run the full conductor identically to a first-party PR: title validated
  and rewritten if malformed, auto-merge/needs-review label applied, and
  auto-merge enabled when the title type is in the target branch's `auto_merge`
  set and all other required gates pass.
- A Dependabot PR shall never auto-merge unless the App key is reachable on the
  run; absent the Dependabot secret it receives the degraded check
  (§spec:dependabot-degraded-check) and waits for a human.
- Flywheel shall introduce no actor allowlist of its own; the Dependabot secret
  store is the sole opt-in marking Dependabot trusted.
- `docs/adopter/setup.md` shall document the Dependabot-secret registration as
  the step that enables full Flywheel behaviour, including auto-merge, for
  Dependabot PRs.

**Scope and alternatives.**

- *A Flywheel-side actor allowlist* is rejected: it duplicates the secret-store
  trust boundary and can drift out of sync with GitHub's.
- *Auto-merging Dependabot by default, without the secret opt-in* is rejected:
  it would auto-merge on the secret-less path, violating "never auto-merge
  without the key" and granting repository write to any secret-less actor.

## Dependabot empty-key regression guard §spec:dependabot-deadlock-test

*Status: complete*

A fast unit/CI test reproduces the empty-key Dependabot path and asserts the
two halves of the contract: a well-formed Dependabot title posts a `success`
`flywheel/conventional-commit` check and a malformed one posts `failure`, while
in both cases no `flywheel:auto-merge` / `flywheel:needs-review` label is
applied and no other App-only action runs. The test draws on no rate-limited
e2e sandbox installation. §req:dependabot-deadlock-criteria
§req:dependabot-deadlock-constraints

**Why a unit guard, not e2e.** The deadlock is silent, permanent, and
near-universal for its trigger, so it needs a guard that runs on every PR — not
one gated behind the rate-limited sandbox budget (§spec:sandbox-test-budget,
§req:sandbox-ci-budget). A deterministic unit test on the conductor's degraded
branch, mirroring §spec:apply-rulesets-stdin-test, catches a regression that
re-strands Dependabot PRs at the cheapest possible cost; the e2e suite stays a
backstop, not the first line of defence for this class of deadlock.
§req:dependabot-deadlock-constraints

**Criteria.**

- A unit/CI test shall exercise the empty-key path and assert the required
  check is posted with the correct conclusion for both a well-formed and a
  malformed Dependabot title.
- The same test shall assert no auto-merge/needs-review label is applied and no
  App-only action runs on that path.
- The test shall not consume the e2e sandbox installation.

**Scope and alternatives.**

- *Relying on the e2e sandbox to catch this regression* is rejected: it draws on
  the rate-limited installation and is slow, whereas the degraded path is a pure
  conductor branch a unit test can cover deterministically.
