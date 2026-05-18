# ADR 0003 — Quality-template skip clauses use trigger-correct event contexts

- **Status:** Accepted
- **Date:** 2026-05-18
- **Relates to:** issue #150

## Decision

The `if:` guard in the `quality.yml` starter template (`scripts/templates/quality.yml`, and the inline copy in `docs/adopter/setup.md`) matches Flywheel-emitted commit messages via `github.event.merge_group.head_commit.message`, not `github.event.head_commit.message`. The bot-managed promotion PR continues to be matched via `github.event.pull_request.title`.

The guard is deliberately kept as a single job-level expression. A more elaborate "gate job" design — which would also message-match on the `pull_request` trigger — was considered and rejected.

## Context

### What the `if:` is for

`quality.yml` is a starter template for an adopter's required status check. Flywheel keeps a long-lived **promotion PR** (`develop → main`) whose head branch is `develop`. Every release pushes a `chore(release):` commit, and Flywheel back-merges it upstream with `chore: back-merge` commits — all direct pushes to `develop`. Each such push lands on the promotion PR's head branch and re-triggers its required status checks via `pull_request: synchronize`.

Those commits carry no new test signal — a `chore(release):` commit is a pure version bump; a `chore: back-merge` commit is already-tested code being propagated. The `if:` exists to **clear the required check cheaply** on them: a job-level `if:` that evaluates false reports `success` to the required-status-checks rule, so the promotion PR stays mergeable without running the suite.

This is **an optimization, not a correctness requirement.** With no `if:` at all, the suite would simply run on those commits, pass, and the PR would merge — at the cost of redundant CI minutes on every release. `[skip ci]` is *not* a substitute: it is a workflow-level filter that suppresses the workflow entirely, leaving the required check `Pending` forever and deadlocking the promotion PR (see ADR 0001, Issue 1).

### The defect (issue #150)

The template triggers on `pull_request` and `merge_group`, but matched commit messages via `github.event.head_commit.message`. Unqualified `head_commit` is a **`push`-event-only** payload field. On both of this workflow's triggers it is undefined, so `github.event.head_commit.message || ''` always yields `''`, and the two `startsWith` clauses always evaluated `true` — they never skipped anything. Only the `pull_request.title` clause did real work. GitHub's Actions linter flags the dead access as `Context access might be invalid: head_commit`. The same broken block was duplicated in `docs/adopter/setup.md`.

The defect fails safe — always-`true` means "run the suite," never "wrongly skip" — so there was no field symptom, only the linter warning, which is how it was reported.

### The fix

The two triggers expose the tip commit differently, so the clauses are not interchangeable:

- **`merge_group`** carries the tip commit at `github.event.merge_group.head_commit`. The two `startsWith` clauses now match it there.
- **`pull_request`** payloads carry no commit message at all — only the PR title. Release and back-merge commits are pushed directly to branches, so the only way one reaches a `pull_request`-triggered run is on the promotion PR, which the `: promote ` title clause already catches.

So message-matching is live on `merge_group`; on `pull_request` the promotion-PR title is the signal. This split loses no coverage of the documented scenarios.

## Alternatives considered

### Remove the two dead clauses entirely

Keep only the `: promote ` title clause. Simplest, clears the linter. Rejected: it discards the expressed intent (skip release/back-merge commits *specifically*), cements "the promotion PR skips quality wholesale" as the design rather than a coarse fallback, and gives up message-matching on the `merge_group` trigger where it genuinely works.

### Two-job "gate" pattern

A first job resolves the real head commit message via the API (`gh api .../commits/{sha}`) — which works identically on both triggers — and a second `test` job runs only if the gate says so. This would be fully correct and *surgical* (match the commit, not the whole PR) on both triggers.

Rejected for a starter template:

1. It runs on **every** PR, adding a fixed CI cost to each — in order to save CI cost on the minority of release/back-merge commits. Since the `if:` is itself only a CI-cost optimization, a design that taxes every PR to fund it is partly self-defeating. A job-level expression costs nothing to evaluate.
2. It requires the adopter to register **both** jobs as required checks (otherwise a gate failure lets a PR through on the skipped-`test`-reports-`success` rule) — a non-obvious footgun in a copy-paste template.

The surgical precision the gate buys is also low-value here: the promotion PR by design only carries already-tested `develop` commits, so skipping the whole PR is acceptable.

## Consequences

- The linter warning is gone; the template is correct on both triggers for every documented scenario.
- On `pull_request`, skipping remains coarse — the *entire* promotion PR is skipped, not just its release/back-merge commits. Accepted, per above.
- The promotion PR running *inside a merge queue* is not specifically skipped: its `merge_group` head commit is a speculative merge commit (not a `chore(...)` commit), and `pull_request` context is absent under `merge_group`. The suite runs in that case — wasted CI, not a correctness issue. Left as a known limitation.
