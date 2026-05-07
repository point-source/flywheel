# Flywheel — requirements

## Purpose of this document

This document captures the **requirements** Flywheel exists to satisfy — the constraints, properties, and outcomes the design serves. It is the layer beneath [`spec.md`](./spec.md):

- `spec.md` describes **what Flywheel does and how**.
- This document describes **what Flywheel must achieve and why** — the requirements the spec is one valid implementation of.

The two are companions, not duplicates. When evaluating a proposed change, the workflow is:

1. **Does it preserve the requirements in this doc?** If yes, it may be a valid spec change.
2. **Does it conflict with the spec?** If yes, the spec must be updated (and this doc reviewed to confirm the requirement framing still holds).
3. **Does it surface a missing requirement?** Add it here first, then update the spec.

This doc is also the right place to look when considering **alternative substrates** (other forges, CI systems, queue backends) — the requirements are platform-independent; the spec is GitHub-specific.

---

## Audience requirements

The two audiences Flywheel is designed for and the constraints each imposes.

### A1. Small-to-medium engineering teams shipping continuously

Constraint: humans are the bottleneck. Each manual step costs round-trip latency and carries error risk.

Implications:
- The default path for a well-formed PR must be **zero human touches** between commit and release artifact.
- Routine commit types (`fix`, `chore`, `docs`, etc.) should not require approval; semantically risky types (`feat`, `feat!`) should.
- Errors in adopter configuration must surface at config-validation time, not silently at release time.

### A2. AI agent swarms producing concurrent PRs at scale

Constraint: agents are cheap and many. Tens to hundreds of concurrent open PRs against the same branch is the steady state, not a spike.

Implications:
- Per-PR human attention is structurally impossible — Flywheel must encode the review policy in `.flywheel.yml`, not in human approvals.
- Per-PR CI cost cannot grow with concurrent open PR count, or the economics of the swarm collapse (see N1).
- Agents will mis-format PR titles, target wrong branches, attempt to mint version tags, and reuse merged branches. Flywheel must catch and either correct or reject these failure modes without human intervention.
- A single broken PR cannot block the queue or create state Flywheel must remember between runs.

### A3. Maintainers with a small operational surface to manage

Constraint: Flywheel itself is maintained by a small team. Adopter onboarding, upgrade, and diagnosis must be self-serve.

Implications:
- Setup must converge in minutes via a single script for the common case.
- Diagnosis must be runnable by adopters without maintainer involvement (`doctor.sh`).
- Upgrades cannot break adopter repos; the version contract is per major version.

---

## Functional requirements

What Flywheel must do, organized by capability.

### F1. Convention enforcement

- **F1.1** Every PR targeting a managed branch MUST have a Conventional Commits-formatted title (`type(scope)!?: description`).
- **F1.2** Malformed PR titles MUST be rewritten in place to a normalized form when the type is recoverable, or fail a check otherwise.
- **F1.3** Breaking-change indicators (`!` in title or `BREAKING CHANGE:` footer in any commit body on the branch) MUST be detected and surfaced.
- **F1.4** Skip-CI markers in any of GitHub's six recognized forms MUST be blocked at PR check time, since they silently suppress release workflows on squash-merge.

### F2. Auto-merge routing

- **F2.1** PRs whose computed match key (`type` or `type!`) is in the target branch's `auto_merge` list MUST be labeled `flywheel:auto-merge` and have native auto-merge enabled.
- **F2.2** PRs whose match key is not in the list MUST be labeled `flywheel:needs-review` with auto-merge disabled.
- **F2.3** Routing decisions MUST update on every `synchronize` event — a PR's eligibility can change as its title changes.
- **F2.4** Listing `type` in `auto_merge` MUST NOT imply `type!` is also allowed; breaking variants are explicit.

### F3. Multi-branch promotion

- **F3.1** Branch relationships MUST be expressible as ordered streams in a single config file (`.flywheel.yml`); no out-of-band coupling.
- **F3.2** A push to a non-terminal branch in a stream MUST upsert exactly one open promotion PR to the next branch in the stream.
- **F3.3** The promotion PR title's commit type MUST be derived from the most impactful pending commit, with the same auto-merge evaluation as any other PR.
- **F3.4** Each branch MUST belong to exactly one stream; cross-stream references MUST fail validation.
- **F3.5** Streams MUST be independent: failures, releases, or queue stalls in one stream MUST NOT affect another.

### F4. Versioning

- **F4.1** Versions MUST be computed at push time, not at PR-open time. Predicted versions on open PRs are wrong as soon as merge order is non-deterministic, which is always under concurrent PRs.
- **F4.2** Within a stream, the base version MUST be coherent across all branches (`v1.3.0-dev.2`, `v1.3.0-rc.1`, `v1.3.0` represent the same logical release).
- **F4.3** Across streams, version computation MUST be independent and tag namespaces MUST be disjoint (no two streams may collide on a tag string).
- **F4.4** Non-bumping commits (`chore`, `style`, etc. without `!`) MUST accumulate silently and contribute to the next qualifying release's changelog.
- **F4.5** Version artifacts produced MUST include: a git tag, a `CHANGELOG.md` entry, and a GitHub Release (or platform equivalent).

### F5. Release artifact decoupling

- **F5.1** Build and publish workflows MUST react to the released version asynchronously, not be invoked synchronously by Flywheel.
- **F5.2** A long-running build (e.g. 30-minute mobile build) MUST NOT block any Flywheel pipeline step.
- **F5.3** Build/publish MUST be language- and destination-agnostic; Flywheel produces the version + tag + release object and nothing else.

### F6. Bot identity

- **F6.1** All Flywheel writes (PR creation, label changes, semantic-release commits, back-merges) MUST originate from a single identity that is distinguishable from human contributors.
- **F6.2** That identity MUST be capable of triggering downstream workflows on PRs and pushes it creates (rules out `GITHUB_TOKEN`-equivalent default identities).
- **F6.3** The credential lifecycle MUST be short-lived (per-run installation token), not a long-lived PAT.
- **F6.4** Permission scope MUST be validated at run start and fail with an actionable error if insufficient.

### F7. Stateless operation

- **F7.1** Flywheel MUST hold no state between runs. The repository (branches, tags, PRs, labels, rulesets) is the only state machine.
- **F7.2** A failed run MUST be safe to retry. No partial-write recovery logic; idempotency comes from the state machine being the repo itself.
- **F7.3** Configuration MUST live entirely in the adopter repo (`.flywheel.yml` + workflow files); nothing in Flywheel-side databases or per-adopter configuration.

### F8. Configuration validation

- **F8.1** `.flywheel.yml` MUST be validated on every run. Errors MUST fail the action with a descriptive check.
- **F8.2** Validation MUST catch the structurally impossible cases at config time (cross-stream branch reuse, suffix collisions, cross-stream tag collisions, non-terminal `release: production`, etc.) — these cannot be allowed to surface at release time.
- **F8.3** Validation MUST be cheap (millisecond-scale) so it runs unconditionally before any other action work.

### F9. Diagnostics

- **F9.1** Adopters MUST have a self-serve diagnostic tool (`doctor.sh`) that detects common misconfigurations (App not installed, ruleset missing, App not a bypass actor, quality workflows missing `merge_group:`, etc.).
- **F9.2** Diagnostic output MUST point to remediation, not just describe symptoms.

---

## Non-functional requirements

Cross-cutting properties the system must satisfy.

### N1. Cost-effective at swarm scale

- **N1.1** Per-merge CI cost MUST NOT grow with concurrent open PR count. The acceptable shape is O(1) per merge; O(N) is an economic failure mode at swarm scale (see issue #106 for the math).
- **N1.2** Long-running build/publish workflows MUST be billed once per release artifact, not once per PR.
- **N1.3** Flywheel's own action runtime MUST be small (seconds, not minutes) — it runs on every PR event and every push to managed branches.
- **N1.4** Adopters operating outside the platform's free CI tier MUST have a documented cost-control story (currently: GitHub merge queue; see #107 for alternatives).

### N2. Latency

- **N2.1** Time from PR open to Flywheel labeling decision MUST be measured in seconds.
- **N2.2** Time from merge to promotion PR upsert MUST be measured in seconds.
- **N2.3** Release latency is dominated by user-defined build/publish workflows and is out of scope for Flywheel itself.

### N3. Reliability

- **N3.1** A single Flywheel run failure MUST NOT corrupt repo state. Retrying MUST converge.
- **N3.2** Flywheel MUST degrade gracefully when optional features are unavailable (e.g. native auto-merge mutation refused → fall through to direct REST merge → label-only fallback).
- **N3.3** A misconfigured or stalled queue MUST NOT prevent Flywheel itself from updating PR titles, labels, or promotion PRs.

### N4. Security and permissions

- **N4.1** Flywheel MUST operate with minimum sufficient permissions (currently five App scopes, all read/write only where unavoidable).
- **N4.2** Bypass-actor scope MUST be narrow: split across multiple rulesets so the App can push release commits and back-merges without bypassing destruction protection.
- **N4.3** Tag namespace MUST be writable only by the App, not by agents or human contributors. Prevents arbitrary `v*` tag creation that would break version computation.
- **N4.4** Secrets MUST be limited to the App private key. No long-lived tokens, no cross-repo credentials.

### N5. Adopter ergonomics

- **N5.1** Setup time for a fresh repo MUST be minutes, not hours. A single `init.sh` invocation MUST cover the common case.
- **N5.2** Day-2 changes (adding a stream, changing auto-merge rules) MUST be a single `.flywheel.yml` edit + PR; no script re-runs, no manual ruleset updates.
- **N5.3** Adopters MUST never edit generated config (`.releaserc.json`). Anything that would require it is a Flywheel feature gap, not an adopter responsibility.

### N6. Maintainer ergonomics

- **N6.1** Flywheel MUST be a single bundled artifact (`dist/index.cjs`) executable directly by GitHub Actions with no install step at runtime.
- **N6.2** The bundled artifact MUST be verifiable against source on every PR (`verify-dist`) so drift between source and shipped code fails CI.
- **N6.3** Adopter-facing surface (config schema, action inputs, label names, ruleset names) MUST be stable per major version.

### N7. Portability ceiling

- **N7.1** Flywheel is GitHub-specific by design today, but its **requirements** (this document) MUST remain platform-neutral so alternative substrates can be evaluated honestly.
- **N7.2** Substrate dependencies MUST be enumerated explicitly (see §Substrate requirements) so when one is unavailable on a given plan/platform, the gap is visible.

---

## Substrate requirements

What Flywheel needs from its host platform. Currently GitHub satisfies all of these; this enumeration exists so alternatives can be evaluated against the same checklist.

### S1. Event-driven webhooks

- **S1.1** Webhook delivery for `pull_request` lifecycle events (opened, synchronize, reopened, edited, ready_for_review).
- **S1.2** Webhook delivery for `push` events on configured branches.
- **S1.3** Webhook delivery for `release` and `workflow_run` events to drive the build/publish chain.

### S2. Pull request primitives

- **S2.1** PR title and body are server-side editable by an authenticated bot.
- **S2.2** Labels are first-class, server-side, and addable/removable by a bot.
- **S2.3** Auto-merge can be enabled on a PR by a bot identity such that the merge fires when required checks pass and the queue (if any) admits it.
- **S2.4** Required status checks block merge until satisfied.

### S3. Cost-effective batched merging

- **S3.1** A queue or equivalent that batches merges so required checks run O(1) per batch, not O(open_PRs) per base-branch advance.
- **S3.2** Queue must test each candidate against the predicted post-batch combined state (correctness guarantee).
- **S3.3** Queue must not require human intervention to admit individual PRs.

> Currently provided by GitHub merge queue, which is plan-gated (issue #106). Issue #107 tracks supporting third-party alternatives (Mergify/Aviator) for adopters on plans that don't include native queue.

### S4. Bot identity with bypass

- **S4.1** A bot identity that is distinct from human contributors and from the default workflow token.
- **S4.2** The identity can be granted bypass on specific protection rules without bypassing all of them (split-ruleset model).
- **S4.3** The identity's writes trigger downstream workflows (rules out GitHub's default `GITHUB_TOKEN`).
- **S4.4** Credential lifecycle is short-lived (installation token, not PAT).

### S5. Branch protection / rulesets

- **S5.1** Per-branch rules for: PR-required, status-check-required, force-push-blocked, deletion-blocked.
- **S5.2** Tag-namespace protection (only specific identities may create tags matching a pattern).
- **S5.3** Programmatic ruleset configuration (so `apply-rulesets.sh` can bootstrap them).

### S6. CI execution

- **S6.1** Workflow execution triggered by webhooks.
- **S6.2** Per-job concurrency groups (so PR-event workflows can collapse rapid edits).
- **S6.3** Cross-workflow event chaining (`workflow_run`) so build → publish doesn't need orchestration.
- **S6.4** Reasonable per-run runtime ceiling (compatible with multi-minute build steps without timeouts).

### S7. Release artifacts

- **S7.1** A first-class "release" object the platform exposes (so build workflows can react to `release: published`).
- **S7.2** Tags addressable as immutable refs.

---

## Operational requirements

The lifecycle around running Flywheel.

### O1. Adoption

- **O1.1** Single-script bootstrap for new repos (`init.sh`).
- **O1.2** Documented audit-and-cleanup path for existing repos with prior version tags or branch protection.
- **O1.3** No required forks or vendoring; reference Flywheel via the marketplace action.

### O2. Day-2 operations

- **O2.1** All ongoing config changes are PRs against `.flywheel.yml`.
- **O2.2** Ruleset drift is detected and reconciled at runtime where possible.
- **O2.3** Diagnostics (`doctor.sh`) is runnable on demand without modifying repo state.

### O3. Upgrade

- **O3.1** Major version pinning (`@v2`) with documented breaking-change policy.
- **O3.2** Patch and minor releases must not require adopter action.
- **O3.3** Deprecations must be surfaced in `doctor.sh` output before becoming breaking.

---

## Non-goals (anti-requirements)

What Flywheel deliberately does NOT do. These are constraints on the design, not gaps.

### NG1. Quality check execution

Flywheel does not run tests, lint, type-check, security scan, or any other quality check. Adopters wire those as separate workflows that register as required status checks. Reason: scope creep — every project's quality bar is different, and embedding any subset would be an opinion that doesn't belong in an orchestration layer.

### NG2. Build and publish orchestration

Flywheel does not build artifacts, publish to package registries, deploy, or notify. Adopters react to `release: published` and `workflow_run: [Build] completed` events. Reason: keeps Flywheel language- and destination-agnostic and avoids "double billing" (synchronous waiting on multi-minute builds).

### NG3. Long-running orchestration state

Flywheel never holds state between runs. No external database, no persistent scheduler, no in-memory cache. Reason: the repo (branches, tags, PRs, labels, rulesets) is already a sufficient state machine; an external store creates split-brain failure modes and operational burden.

### NG4. Per-PR predicted versions

Flywheel does not predict and display the post-merge version on open PRs. Increment type (major/minor/patch) is shown instead. Reason: the predicted version is wrong for any PR not first to merge under concurrent open PRs, which is normal in agent swarms. Wrong predictions are worse than no prediction.

### NG5. Manual orchestration affordances

Flywheel does not provide comment commands (`/merge`, `bors r+`, etc.), manual queue admission, or per-PR overrides. Reason: agents shouldn't need to comment-trigger their own merges; humans express override intent by editing `.flywheel.yml` (durable) or by approving the `flywheel:needs-review` PR (one-shot).

### NG6. Branch hierarchy assumptions

Flywheel does not assume `main`, `develop`, or any specific branch exists or has any specific role. Stream membership in `.flywheel.yml` is the only source of truth. Reason: a single-branch repo and a six-stream multi-customer repo must use the same system without special cases.

### NG7. Cross-repo coordination

Flywheel does not coordinate releases across multiple repos. Each adopter repo is an independent installation with its own `.flywheel.yml` and its own version history. Reason: multi-repo coordination requires durable cross-system state (NG3) and adopter-specific topology that doesn't generalize.

### NG8. Workflow templating beyond the two thin entrypoints

Flywheel ships `flywheel-pr.yml` and `flywheel-push.yml` as templates and nothing else. It does not generate `quality.yml`, `build.yml`, or `publish.yml`. Reason: those are adopter-owned (NG1, NG2) and templating them would re-introduce the language/destination opinions Flywheel exists to avoid.

### NG9. Migration from non-Flywheel-shaped repos

Flywheel does not auto-migrate repos with custom release tooling, non-conventional commits, or non-stream-based branching. Adopters must do the migration; Flywheel provides the audit checklist (`docs/adopter/setup.md §0`). Reason: the migration shape depends on what's already there, and a wrong auto-migration is worse than a manual one.

---

## Constraint provenance

A traceability index for the requirements above. When a requirement looks arbitrary, this section identifies the audience constraint or substrate idiosyncrasy that drove it.

| Requirement | Driven by | Constraint |
|---|---|---|
| F1.4 (skip-CI block) | A2 swarms | Squash-merge silently propagates skip-CI markers from PR commits, suppressing the release workflow with no error surface. |
| F2.4 (`type` ≠ `type!`) | A1 humans + A2 swarms | Breaking changes must be opt-in even for otherwise-auto-mergeable types. |
| F3.5 (stream independence) | A2 swarms | One stream's stalled queue must not throttle another's release cadence. |
| F4.1 (JIT versioning) | A2 swarms | Predicted versions are wrong under concurrent merges, which is the steady state. |
| F4.3 (disjoint tag namespaces) | A1 + git | Git tags are repo-global; collision is a hard failure with no recovery path. |
| F6.2 (downstream trigger) | GitHub | `GITHUB_TOKEN`-created PRs do not trigger downstream workflows; substrate-specific. |
| F7 (statelessness) | NG3 | External state would create split-brain modes the repo itself doesn't have. |
| N1.1 (O(1) per merge) | A2 swarms | O(N) merge cost makes swarms uneconomic regardless of agent capability. |
| N4.2 (split bypass scope) | GitHub + N4.1 | Single combined ruleset would force overly broad bypass; split-ruleset model is GitHub-specific (#81). |
| S3 (batched queue) | A2 swarms + N1.1 | The substrate must provide queue semantics or an equivalent; this is the requirement issue #107 is structured around. |
| NG4 (no predicted versions) | A2 swarms + F4.1 | Wrong predictions cause more confusion than absent ones. |
| NG5 (no comment commands) | A2 swarms | Agents shouldn't need to comment-drive their own merges; humans express intent durably via config. |

---

## How to evolve this document

- **New requirement surfaces from a bug or adopter request**: add it under the appropriate section, link the issue/PR in the Constraint provenance table.
- **A requirement turns out to be wrong**: amend or remove it here, then update `spec.md` in the same PR.
- **A non-goal stops being a non-goal**: move it from §Non-goals to §Functional requirements with a brief note explaining what changed.
- **A new substrate is being evaluated** (different forge, queue backend, CI system): walk §Substrate requirements top-to-bottom and document which items the substrate satisfies, which it doesn't, and what the workaround is for the gaps.
