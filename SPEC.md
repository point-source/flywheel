# flywheel — Specification

## Overview §spec:overview

*Status: not started*

<!-- Describe the desired behavior of this section. -->

## Action version lockstep §spec:action-version-lockstep

*Status: not started*

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
