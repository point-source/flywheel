# flywheel — Specification

## Overview §spec:overview

*Status: not started*

<!-- Describe the desired behavior of this section. -->

## Action version lockstep §spec:action-version-lockstep

*Status: not started*

Flywheel ships as a reusable workflow (`pr.yml`, `push.yml`) and a
composite action. Adopters pin the reusable workflow at a version ref.
The reusable workflow runs the flywheel action at a version consistent
with the pin the adopter chose, and the checkout of the action source
succeeds regardless of which branch or PR ref the caller runs on.

**Constraint:** GitHub resolves `github.workflow_ref` /
`GITHUB_WORKFLOW_REF` from the workflow that initially triggered the
run, not from a reusable workflow it calls — so inside a reusable
workflow that value is the *caller's* ref. Deriving the action checkout
ref from it makes checkout target a ref (e.g. `refs/pull/114/merge`)
that exists in the caller's repo but not in `point-source/flywheel`,
failing for every non-default-branch caller (reported in #183, a
regression from the ref-derivation mechanism added in #166). GitHub
exposes no runtime context for a reusable workflow's own pinned ref;
how version consistency is achieved within that constraint is an open
design decision deferred to `/symphonize:plan`.

**Why:** #166 aimed for exact-version lockstep so an adopter pinned at
`pr.yml@v1.2.3` never runs action behavior from a different release.
The available mechanisms trade exactness, per-branch flexibility, and
single-source-of-truth against each other; the chosen trade-off must be
deliberate, not incidental.
