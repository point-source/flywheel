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
to hand the adopter's build a release it can still attach to. §req:problem-statement

**Opt-in.** `.flywheel.yml` accepts a repository-wide boolean
`release_as_draft` (default `false`), a third top-level key alongside
`streams` and `release_files`. `src/config.ts` validates it: a non-boolean
value and a misspelled key are both configuration errors, surfaced like
every other `.flywheel.yml` error. The setting is repository-wide — not
per-stream or per-branch — because GitHub's own immutable-releases setting
is a repository/organization-level control; flywheel matches that scope so
the two cannot express disagreeing configurations. §req:constraints

The behavior is declared, never inferred. flywheel cannot tell whether an
adopter's build attaches an asset: that decision lives in a build workflow
in the adopter's repository that flywheel never reads. And a repository
having immutable releases enabled does not imply its releases carry assets.
No signal available to flywheel answers the question, so the adopter states
the intent explicitly. §req:constraints

**Draft creation.** When `release_as_draft` is `true`, the `.releaserc.json`
that `src/release-rc.ts` generates configures `@semantic-release/github`
with `draftRelease: true`, so the GitHub Release is created as an
unpublished draft instead of being published. When `release_as_draft` is
`false` or absent, `@semantic-release/github` is configured exactly as
today and the release publishes immediately — an adopter who has not opted
in observes no change whatsoever. §req:success-criteria

`@semantic-release/github` stays in the plugin chain rather than being
removed: it still generates the release notes, posts the released-in
comments, and produces the release object the adopter's build attaches to.
`draftRelease` is the single documented deviation from the plugin's
defaults.

The draft state changes nothing else in the release run. semantic-release
core creates and pushes the git tag, and `@semantic-release/git` commits
the changelog, regardless of whether the release object is a draft. The
release-body @-mention sanitizer and the back-merge step operate
identically — the sanitizer edits the body of the draft (drafts are fully
mutable), and the back-merge replays the `chore(release)` commit and tag,
which are branch-and-tag operations independent of the release object.

**Concurrency.** semantic-release derives the next version from git tags,
never from GitHub Release objects. Because the tag is created and pushed on
every release run irrespective of `draftRelease`, releases cut in quick
succession compute correct, monotonic versions even while earlier releases
remain unpublished drafts. The draft state of a release object is invisible
to version computation; a test exercises consecutive draft releases and
asserts the version sequence. §req:success-criteria

**Handoff to the adopter's build.** flywheel's responsibility ends when the
draft release exists. The adopter's build owns attaching the artifact and
publishing the draft — publishing is the act that makes the release
immutable, and the build is the only actor that knows the artifact is
attached. flywheel does not track, wait on, or publish the draft itself; it
stays stateless. §req:quality-attributes

A build that must attach an asset *before* publication cannot be triggered
by the `release` event: GitHub does not fire `release` events for draft
releases. The reliable pre-publication signal is the release tag push. An
opted-in adopter's build workflow therefore triggers on `push:` of the
release tags, looks the draft release up by tag name, uploads its artifact,
and publishes the draft as its final step. `docs/adopter/setup.md`
documents this build shape — the tag-push trigger and the
publish-as-final-step — separately from the immediate-publish `build.yml`
example used by adopters who have not opted in.

**flywheel's own releases.** flywheel does not set `release_as_draft`: it
ships no release assets (it is distributed as an action pinned by git ref,
with `dist/` committed). Its releases take the default immediate-publish
path, and that path is immutable-safe. Immutability freezes only the tag
and the assets; flywheel attaches no assets, and the tag is created once
and never moved. Immutability still permits editing a published release's
title and notes, so the @-mention sanitizer continues to work post-publish.
Enabling immutable releases on `point-source/flywheel` therefore requires
no flywheel code change, and flywheel dogfoods the guarantee it offers
adopters. §req:priorities

**Stuck-draft failure mode.** If an opted-in adopter's build fails before it
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

- *Per-stream or per-branch opt-in* — rejected: immutable releases is a
  repository/organization-level GitHub setting, so a finer-grained flywheel
  control could express a configuration GitHub itself cannot honor.

**Tradeoffs accepted.**

- An opted-in adopter migrates its build workflow from a `release: published`
  trigger to a release-tag `push` trigger and adds a publish step. This is a
  breaking change for that adopter, but scoped to the opt-in — adopters who
  do not set `release_as_draft` are untouched. Accepted: there is no
  pre-publication trigger other than the tag push, because GitHub does not
  raise `release` events for drafts.

- A draft release whose build never publishes it lingers indefinitely.
  Accepted as the adopter's responsibility (see *Stuck-draft failure mode*)
  rather than expanding flywheel into a stateful release monitor.
