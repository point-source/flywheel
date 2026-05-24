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
that keeps a reusable-workflow layer must therefore derive that ref
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
  reusable workflow that a maintainer must bump per major release. It is
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

*Status: in progress*

GitHub immutable releases (generally available October 2025) freeze a
release's git tag and attached assets the moment the release is published —
afterward they cannot be added, modified, or deleted. flywheel runs
`semantic-release` on a push to a release branch, and `@semantic-release/github`
creates *and publishes* the GitHub Release in one step. An adopter whose
build attaches a compiled artifact to the release does so from a separate
build workflow triggered by that release — that is, *after* publication. On
a repository with immutable releases enabled, that asset upload is rejected
and the adopter's release pipeline fails. This section makes flywheel able
to hand the adopter's build a release it can still attach to, on the
branches where that handoff is needed and nowhere else. §req:problem-statement

**Opt-in.** `.flywheel.yml` accepts `release_as_draft` as a per-branch
boolean (default `false`), set on any branch whose `release` is
`prerelease` or `production`. `src/config.ts` validates it: a non-boolean
value and the appearance of `release_as_draft` on a `release: none` branch
are both configuration errors, surfaced like every other `.flywheel.yml`
error. §req:constraints

The behavior is declared, never inferred. flywheel cannot tell whether an
adopter's build attaches an asset: that decision lives in a build workflow
in the adopter's repository that flywheel never reads. And a repository
having immutable releases enabled does not imply its releases carry assets.
No signal available to flywheel answers the question, so the adopter states
the intent explicitly. §req:constraints

**Why per-branch scope.** GitHub's immutable-releases setting and
flywheel's `release_as_draft` describe different things and are therefore
orthogonal. GitHub's setting is repository/organization-level and governs
whether a *published* release's tag and assets are frozen. flywheel's
setting governs *who performs the publish step* — semantic-release
immediately, or the adopter's build after attaching an artifact. Any
combination of repo-wide immutability and per-branch draft produces a
release shape GitHub honors: a `release_as_draft: false` branch on an
immutability-enabled repo publishes an asset-less immutable release
immediately; a `release_as_draft: true` branch on the same repo produces a
draft, gets its asset, and the build's final publish makes that release
immutable. Because the *decision* — which actor publishes — varies per
release branch (one branch attaches a binary, another attaches nothing, a
third attaches a snapshot), the configuration surface varies at the same
scope. A repo-wide flag forces every release branch onto the draft path
once any branch needs it, which in turn requires a publish-trigger workflow
on branches that would otherwise need none. §req:problem-statement
§req:constraints

**Migration from the previous top-level form.** A top-level
`release_as_draft` key under `flywheel:` is no longer recognized; if
present, `src/config.ts` produces a configuration error naming the
per-branch replacement and listing the branches that would need it (every
`release: prerelease` or `release: production` branch in the file).
Migration is mechanical and explicit — no silent translation that would
distribute the old repo-wide setting to every branch and reintroduce the
pain this change exists to remove. §req:success-criteria §req:priorities

**Draft creation.** At release time, `src/release-rc.ts` reads
`release_as_draft` from the target branch and passes `draftRelease: true`
through to `@semantic-release/github` for that release only. When the
branch's value is `false` or absent, the release publishes immediately — an
adopter who has not opted in on a branch observes no change on that branch
whatsoever, even when other branches in the same repository are opted in.
§req:success-criteria

`@semantic-release/github` stays in the plugin chain rather than being
removed: it still generates the release notes, posts the released-in
comments, and produces the release object the adopter's build attaches to.
`draftRelease` is the single deviation from the plugin's defaults.

Tag creation, the changelog commit, the release-body @-mention sanitizer,
and the back-merge step are all independent of the release object's
published state — they are branch and tag operations, or edits to a
still-mutable draft body. This independence is what makes concurrency safe
across mixed-mode repositories.

**Concurrency.** semantic-release derives the next version from git tags,
never from GitHub Release objects. Because the tag is created and pushed on
every release run irrespective of `draftRelease`, releases cut in quick
succession compute correct, monotonic versions even while earlier releases
remain unpublished drafts — and this holds whether the concurrent releases
come from one branch or from a mix of draft and immediate-publish branches
in the same repository. The draft state of a release object is invisible
to version computation. The e2e scenario
`tests/e2e/scenarios/11-release-as-draft.test.ts` exercises consecutive
draft releases and asserts the version sequence.
§req:success-criteria

**Handoff to the adopter's build.** flywheel's responsibility ends when the
draft release exists. The adopter's build owns attaching the artifact and
publishing the draft — publishing is the act that makes the release
immutable, and the build is the only actor that knows the artifact is
attached. flywheel does not track, wait on, or publish the draft itself; it
stays stateless. §req:quality-attributes

A build that must attach an asset *before* publication cannot be triggered
by the `release` event: GitHub does not fire `release` events for draft
releases. The reliable pre-publication signal is the release tag push. An
opted-in branch's build workflow therefore triggers on `push:` of that
branch's release tags, looks the draft release up by tag name, uploads its
artifact, and publishes the draft as its final step. `docs/adopter/setup.md`
documents this build shape — the tag-push trigger and the
publish-as-final-step — for branches that opt in, separately from the
immediate-publish `build.yml` example used for branches that do not. A
single repository with mixed-mode branches runs both shapes side by side,
one per branch.

**flywheel's own releases.** No branch of `point-source/flywheel` sets
`release_as_draft: true`: flywheel ships no release assets (it is
distributed as an action pinned by git ref, with `dist/` committed). Every
flywheel release takes the default immediate-publish path, and that path is
immutable-safe. Immutability freezes only the tag and the assets; flywheel
attaches no assets, and the tag is created once and never moved.
Immutability still permits editing a published release's title and notes,
so the @-mention sanitizer continues to work post-publish. Enabling
immutable releases on `point-source/flywheel` therefore requires no
flywheel code change, and flywheel dogfoods the guarantee it offers
adopters. §req:priorities

**Stuck-draft failure mode.** If an opted-in branch's build fails before it
publishes the draft, the release remains an unpublished draft indefinitely.
flywheel does not monitor or recover it — consistent with statelessness,
and the adopter owns the build. The condition is visible (an unpublished
draft in the repository's releases list) and recoverable by re-running the
build. flywheel adds no watchdog: one would require flywheel to hold state
about releases it has handed off, which this design specifically avoids.
§req:quality-attributes

**Alternatives rejected.**

- *Inferring the draft decision* — from the presence of `release_files`, or
  from detecting that immutable releases is enabled on the repository.
  Rejected: `release_files` describes in-repo version stamping, not release
  assets, and immutability being enabled does not imply assets are attached.
  Neither signal answers the actual question, which only the adopter's
  (flywheel-invisible) build workflow knows. An explicit declaration is the
  only correct mechanism.

- *flywheel publishing the draft on a signal from the build* — the build
  sends a `repository_dispatch` once the asset is attached, and a second
  flywheel run publishes the draft. Rejected: it adds a stateful round-trip
  and new flywheel surface for no gain over the build publishing the draft
  directly as its final step.

- *Repository-wide opt-in only* (the prior shape of this feature).
  Rejected because GitHub's repo-level immutability and flywheel's draft
  decision govern different things — see *Why per-branch scope* — and
  tying them to the same scope forces every release branch onto the draft
  path the moment any single branch needs it. That, in turn, demands a
  publish-trigger workflow on branches whose releases attach no artifact,
  which adopters experienced as concrete friction. §req:problem-statement

- *Top-level default with per-branch override* — keep top-level
  `release_as_draft` as a repo-wide default and let individual branches
  override it. Rejected: two configuration surfaces invite drift, and the
  effective behavior of a branch can no longer be read from that branch's
  own block — a reader must also look up the top-level default and combine
  the two. The per-branch-only form keeps every branch's draft behavior
  local to its declaration.

- *Silent mechanical migration of the top-level form* — when the validator
  sees a top-level `release_as_draft: true`, copy it onto every release
  branch and warn. Rejected: this re-creates the very behavior the
  per-branch scope exists to remove (every branch on the draft path,
  whether or not it attaches an artifact). A loud configuration error
  that forces the adopter to decide per branch is the only migration
  consistent with the design intent. §req:success-criteria

**Tradeoffs accepted.**

- A branch that opts in migrates its build workflow from a
  `release: published` trigger to a release-tag `push` trigger and adds a
  publish step. This is a breaking change for that branch's build, but
  scoped to the opt-in — branches in the same repository that do not set
  `release_as_draft` are untouched, and adopters who do not set it on any
  branch are entirely untouched. Accepted: there is no pre-publication
  trigger other than the tag push, because GitHub does not raise `release`
  events for drafts.

- Adopters using the previous top-level `release_as_draft` perform a
  one-time, mechanical edit: move the key under each release branch where
  draft behavior is intended. Accepted in preference to a silent default
  that would force draft behavior onto branches the adopter never chose —
  the loud error is the correct failure mode given the design intent.

- A draft release whose build never publishes it lingers indefinitely.
  Accepted as the adopter's responsibility (see *Stuck-draft failure mode*)
  rather than expanding flywheel into a stateful release monitor.
