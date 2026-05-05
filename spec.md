# Flywheel — specification

## What it is

Flywheel is a lightweight GitHub Actions-native CI/CD orchestration layer for teams and AI agent swarms. It automates the journey from conventional commit to versioned release artifact without prescribing how you build, what you publish, or how your branches relate to each other.

Flywheel is not a long-running orchestrator. It is a collection of short-lived, single-purpose event reactions. The repository itself — its branches, tags, PRs, and labels — is the state machine.

---

## Design principles

**Stateless and event-driven.** No workflow waits for another. Each workflow reacts to one event, does one job, and exits. Long-running build and publish steps are fully decoupled and run independently.

**No double billing.** Build and publish workflows are triggered by events Flywheel produces (tags, releases), not called synchronously by the pipeline. A 30-minute mobile build incurs no waiting cost on the pipeline side.

**Language and destination agnostic.** Flywheel produces a version, a changelog, and a tag. What you do with those is entirely up to your own build and publish workflows.

**No assumed branch hierarchy.** Branch relationships are defined by stream membership and branch order within a stream. Flywheel makes no assumptions about which branches exist or how streams relate to each other. A project with one stream containing one branch and a project with six parallel customer streams use the same system.

**Version numbers are stream-scoped.** Within a stream, the base version is consistent across all branches — `v1.3.0-dev.2`, `v1.3.0-rc.1`, and `v1.3.0` all represent the same logical release. Across streams, versions are computed independently and may collide if streams share a publish destination. See the versioning section for implications and guidance.

**Minimal permissions footprint.** A single GitHub App installation token does all the work. Adopters store the App's `app-id` and `app-private-key` as repo secrets; the action mints a short-lived installation token internally and validates the granted permissions before doing anything. The default workflow `GITHUB_TOKEN` isn't sufficient — a bot-created PR opened with `GITHUB_TOKEN` does not trigger downstream workflows, and native auto-merge enabled with `GITHUB_TOKEN` does not propagate to the merge-queue.

**One config file.** `.flywheel.yml` in the adopting repo is the single source of truth for branch topology, auto-merge rules, and pipeline behavior. Flywheel derives everything else — including semantic-release configuration — from it at runtime.

---

## Components

### 1. `pr-conductor` (Flywheel's only custom code)

A TypeScript GitHub Action, published to the GitHub Actions marketplace as `point-source/flywheel@v2`. Authored in TypeScript and bundled to a single `dist/index.cjs` via esbuild; runs on the `node24` Action runtime. See "Implementation sketch" below.

Reacts to `pull_request` events and `push` events on managed branches. It is stateless — reads `.flywheel.yml`, reads/writes the PR or repo state, and exits. Holds no state between runs.

Responsibilities:

- Parse PR title as a conventional commit
- Rewrite PR title and body with changelog fragment and increment type
- Evaluate auto-merge eligibility against `.flywheel.yml` for the target branch
- Apply `flywheel:auto-merge` or `flywheel:needs-review` label
- Enable GitHub's native auto-merge when eligible; if the GraphQL mutation refuses (typically because the PR is in clean state and the repo has no required checks), fall through to a direct REST merge so adopters without required checks aren't stuck
- On push to a non-terminal branch in a stream, upsert the promotion PR to the next branch in the stream
- Mint its own short-lived installation token from the App credentials passed in (`app-id` + `app-private-key` inputs); validate that the granted permissions cover what Flywheel needs and fail fast with a friendly error otherwise

### 2. semantic-release

Handles version computation, changelog generation, git tagging, and GitHub Release creation. Runs as a step in `flywheel-push.yml` on push to any managed branch. `pr-conductor` generates `.releaserc.json` at runtime from `.flywheel.yml` — adopters never configure semantic-release directly.

### 3. GitHub merge queue

Serializes parallel PRs without manual rebasing. When multiple agent-opened PRs target the same branch, the merge queue tests each against the state that will exist when it is their turn. Flywheel enables auto-merge into the queue; it never bypasses it.

The queue is also Flywheel's primary cost-control mechanism in high-PR-volume repos. Required checks subscribed to `merge_group:` run **once per merged batch** rather than per-PR. Without the queue, every base-branch advance fires `pull_request: synchronize` on rebase candidates, multiplying GHA-minute spend. Adopters with agent swarms should treat the queue as mandatory and avoid GitHub's "Always suggest updating pull request branches" setting (which auto-rebases all open PRs on every base advance, defeating the queue's batching).

### 4. User-defined build and publish workflows

Plain GitHub Actions workflows in the adopting repo. Not called by Flywheel — they react to events Flywheel produces:

- Build workflow triggers on `release: published`
- Publish workflow triggers on `workflow_run: [Build] completed`

Version and changelog are available from the GitHub Release object. No Flywheel-specific inputs required.

---

## Event chain

```
agent / developer pushes a branch
        │
        ▼
pull_request opened against a managed branch
        │
        ▼
pr-conductor fires  (pull_request: opened / synchronize / reopened)
  ├── parse PR title → type, scope, description, breaking flag
  ├── compute increment type  (major / minor / patch / none)
  ├── rewrite PR title + body
  ├── check .flywheel.yml auto_merge list for target branch
  ├── eligible   → apply flywheel:auto-merge label, enable native auto-merge
  └── ineligible → apply flywheel:needs-review label

        │  quality check workflows fire independently via on: pull_request
        │  merge queue serializes concurrent PRs, re-runs checks against combined state
        ▼
PR merges → push to managed branch
        │
        ├──────────────────────────────────────────────────────────┐
        ▼                                                          ▼
semantic-release fires                                  pr-conductor fires
(flywheel-push.yml)                                     (promotion PR upsert)
  ├── generate .releaserc from .flywheel.yml              ├── find stream + position of pushed branch
  ├── compute version from landed commits                 ├── if absent → exit (no promotion PR)
  ├── generate CHANGELOG.md fragment                      ├── collect commits not yet in target
  ├── create git tag  e.g. v1.2.0-dev.3                  ├── determine most impactful commit type
  ├── create GitHub Release                               ├── check type against target's auto_merge
  └── back-merge tag + chore(release) commit              ├── eligible   → create/update PR + flywheel:auto-merge
      into upstream branches in the same stream           └── ineligible → create/update PR + flywheel:needs-review
        │
        ▼
on: release published
  └── user build workflow fires independently
        │
        ▼
on: workflow_run build completed
  └── user publish workflow fires independently
```

**Important:** The release flow and the promotion PR flow are independent reactions to the same push event. A branch that is last in its stream (the terminal branch) still releases — being last means no promotion PR is created, not that no release occurs. Releases happen on every push to any managed branch where semantic-release computes a new version. A single-branch stream releases immediately on every qualifying push with no promotion step.

**Back-merge.** Whenever a release lands on a non-head branch in its stream (e.g. `main` in a `develop → staging → main` stream), Flywheel back-merges the new tag and the `chore(release)` commit into every upstream branch (`staging`, `develop`) before the workflow exits. This keeps the release tag in each upstream branch's ancestry — required for semantic-release on those branches to compute the next prerelease version correctly — and keeps `CHANGELOG.md` in sync. The back-merge push retriggers `flywheel-push.yml` on the upstream branch; that re-run is intentional and a no-op in steady state — semantic-release sees the freshly back-merged tag at HEAD and exits without publishing. Flywheel deliberately does **not** mark the merge commit `[skip ci]`: that token is a workflow-level commit-message filter and would leave required status checks `Pending` on any promotion PR tracking the upstream branch (per GitHub's [required-status-checks docs](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks#handling-skipped-but-required-checks)). Adopters who want to skip CI work on back-merge / release commits should use a job-level `if:` in their quality workflows — a job-level skip reports `success` to the required-checks rule and clears the gate. The App must be a bypass actor on each upstream branch's ruleset (already required by Flywheel's spec for the release push itself); without it, the back-merge push is rejected by the linear-history rule. Single-branch streams have no upstream branches and skip this step.

---

## `.flywheel.yml` reference

```yaml
# .flywheel.yml
# Place in the root of the adopting repo.

flywheel:
  # A stream is a group of branches that share a version history and move
  # releases through stages toward a common production target.
  # Each stream is an independent version domain with its own semantic-release config.
  # Branch order within a stream defines the promotion chain: first = least stable,
  # last = most stable (production target). Promotion PRs flow in array order.
  # A branch may belong to only one stream.
  streams:
    - name: main-line
      branches:
        - name: develop
          # Required. One of: none | prerelease | production.
          #   none       — branch is in the promotion chain but does NOT run
          #                semantic-release (no tag, no GitHub Release).
          #   prerelease — branch releases a prerelease tag; requires `suffix`.
          #   production — branch releases a production tag (no suffix).
          release: prerelease

          # Required iff release: prerelease. Semver pre-release identifier
          # (becomes the `-<suffix>.N` part of the version). Must be unique
          # across all prerelease branches in the repo.
          suffix: dev

          # Required. Commit types that auto-merge into this branch without human review.
          # Use conventional commit type, optionally suffixed with ! for breaking changes.
          # A type listed without ! does not imply the ! variant is also allowed.
          # Empty list = all PRs require human approval.
          auto_merge:
            - fix
            - fix! # breaking fixes auto-merge; breaking feats do not
            - feat
            - chore
            - refactor
            - perf
            - style
            - test
            - docs

        - name: staging
          release: prerelease
          suffix: rc
          auto_merge:
            - fix
            - chore
            - style
            - test
            - docs

        - name: main
          release: production
          auto_merge: [] # all PRs require human approval

    # A second stream for a customer variant — independent version history
    - name: customer-acme
      branches:
        - name: customer-acme
          release: prerelease
          suffix: acme
          auto_merge:
            - fix
            - fix!
            - chore

  # Merge strategy: squash (default) | rebase
  # Note: 'merge' is intentionally omitted. The recommended branch ruleset
  # requires linear history, which is incompatible with merge commits.
  # If you need merge commits, disable the linear history ruleset requirement.
  merge_strategy: squash
```

### Branch config fields

| Field        | Required           | Default | Description                                                                                                |
| ------------ | ------------------ | ------- | ---------------------------------------------------------------------------------------------------------- |
| `name`       | Yes                | —       | Git branch name                                                                                            |
| `release`    | Yes                | —       | One of `none`, `prerelease`, `production` — see release modes below                                        |
| `suffix`     | If `prerelease`    | —       | Semver pre-release identifier (e.g. `dev`, `rc`). Required iff `release: prerelease`; forbidden otherwise. |
| `auto_merge` | Yes                | —       | List of commit types (with optional `!`) that auto-merge. Empty list = all need human review               |

#### Release modes

- **`none`** — the branch is in the promotion chain (auto-promotion PRs are still upserted to and from it) but pushes do **not** run semantic-release. No tag is created, no GitHub Release is published, no `.releaserc.json` is written. Use this when an integration branch should accumulate work and auto-promote without producing its own release artifacts. The terminal branch of a stream cannot be `release: none` (validation error).
- **`prerelease`** — pushes release a prerelease tag using `suffix` as the identifier (e.g. `v1.3.0-dev.4`). Each `suffix` must be unique across all prerelease branches in the repo (otherwise tags collide).
- **`production`** — pushes release a production tag (e.g. `v1.3.0`). At most one production branch is allowed per stream, and it must be the terminal branch.

### Valid `auto_merge` entries

Any conventional commit type, with or without `!`:

`feat`, `feat!`, `fix`, `fix!`, `chore`, `chore!`, `refactor`, `refactor!`, `perf`, `perf!`,
`style`, `style!`, `test`, `test!`, `docs`, `docs!`, `build`, `build!`, `ci`, `ci!`, `revert`, `revert!`

A `fix!` entry matches PRs of type `fix` with a breaking change — indicated by `!` in the title or a `BREAKING CHANGE:` footer in any commit body on the branch. Listing `fix` and `fix!` independently allows breaking fixes through while still gating non-breaking fixes if desired.

### Validation

`pr-conductor` validates `.flywheel.yml` on every run and posts a failing check with a descriptive error if:

- A branch appears in more than one stream — each branch may belong to exactly one stream.
- More than one branch within the same stream has `release: production` — only the last branch in a stream should be the production release branch.
- More than one stream has a terminal branch (last branch) with `release: production` — tag collision is unavoidable in a single repo. Give all but one stream a prerelease terminal branch.
- The terminal branch of a stream has `release: none` — the terminal branch must be `release: prerelease` or `release: production`, otherwise the stream never produces a release.
- A `suffix` is set without `release: prerelease`, or `release: prerelease` is set without a `suffix`.
- The same `suffix` is used by more than one prerelease branch — tags would collide.
- An `auto_merge` entry is not a recognized conventional commit type (with or without `!`).
- A stream contains only one branch — a single-branch stream is valid (immediate release, no promotion) but `pr-conductor` emits an info notice so the user can confirm this is intentional.

---

## Versioning

### Version numbers are stream-scoped

Within a stream, versions are coherent across all branches. The base version (`1.3.0`) is the same on `develop`, `staging`, and `main` — only the pre-release suffix differs. This makes `v1.3.0-dev.2` recognizably the same release as `v1.3.0-rc.1` and eventually `v1.3.0`. Version drift between stages is structurally prevented.

Across streams, versions are computed independently. **Two streams with similar commit histories can produce the same version string.**

Example: if `main` (stream: main-line) and `customer-acme` (stream: customer-acme) both descend from a `v1.0.0` tag and each receives one `fix` commit, both independently compute and release `v1.0.1`. The artifacts are different; the version strings are identical.

**Tag collision across streams is always a hard error, regardless of publish destination.** Git tags are repository-global. Two streams in the same repo that both produce `v1.0.1` will cause the second semantic-release run to fail with a tag collision error — Git will refuse to create a tag that already exists at a different commit.

Flywheel handles this by generating a stream-scoped `tagFormat` for every stream's `.releaserc.json`. Each stream uses its stream name as a tag prefix:

```
main-line stream:      v1.0.1          (tagFormat: v${version})
customer-acme stream:  customer-acme/v1.0.1   (tagFormat: customer-acme/v${version})
```

The first (or only) stream with a terminal `release: production` branch uses the default `v${version}` tag format. All other streams use a prefixed format derived from their stream name. Flywheel generates this automatically — adopters do not configure `tagFormat` directly.

This means the "harmless collision" framing in earlier versions of this spec was incorrect. There is no safe scenario where two streams in the same repo produce the same tag string. The tag format scoping is mandatory and non-optional.

Flywheel emits a validation **error** (not warning) if multiple streams have terminal branches with `release: production` and no tag format disambiguation can be inferred. In practice this means: at most one stream may have the "primary" `v${version}` tag format. All other streams are automatically prefixed.

### JIT computation

Version is computed on push to a managed branch, never at PR-open time. PR titles and bodies show the **increment type** (major / minor / patch) not a predicted version number. The predicted version would be wrong for any PR that is not the first to merge when multiple PRs are open simultaneously, which is the normal state in an agent swarm.

### Version scheme

Within a stream, the base version is consistent across all branches — only the pre-release suffix differs. This means `v1.3.0-dev.4` on `develop`, `v1.3.0-rc.1` on `staging`, and `v1.3.0` on `main` all represent the same logical release moving through stages. The `develop` and `staging` versions are not independent counters racing ahead of `main` — they are anchored to the same next version that `main` will eventually release.

```
develop  →  1.3.0-dev.1,  1.3.0-dev.2, ...
staging  →  1.3.0-rc.1,   1.3.0-rc.2,  ...
main     →  1.3.0
```

This is enforced by declaring stream branches to semantic-release as an ordered sequence. semantic-release computes pre-release versions relative to the stream's production branch tag history, not independently per branch. The version drift problem (`develop` at `23.4.3-dev.1` while `main` is at `3.6.5`) is structurally impossible within a stream.

The pre-release identifier comes from the `suffix` field in `.flywheel.yml` (set when `release: prerelease`). The counter increments automatically via semantic-release's tag inspection.

### Increment rules

| Commit type                                                 | Increment |
| ----------------------------------------------------------- | --------- |
| Any type with `!` or `BREAKING CHANGE:` footer              | major     |
| `feat`                                                      | minor     |
| `fix`, `perf`                                               | patch     |
| `chore`, `refactor`, `style`, `test`, `docs`, `build`, `ci` | none      |

Non-bumping commits accumulate silently until a qualifying commit lands. They are included in the changelog of the next real release. No tag or GitHub Release is created for a push that contains only non-bumping commits.

### `.releaserc.json` generation

`pr-conductor` writes `.releaserc.json` to the workspace before semantic-release runs, derived from `.flywheel.yml`. Adopters never manually configure semantic-release.

**Plugin config:** Flywheel always generates an explicit plugin list, never relying on semantic-release defaults. The default plugin set includes `@semantic-release/npm` which breaks non-Node projects. Flywheel's generated config uses:

```json
{
  "plugins": [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    "@semantic-release/changelog",
    "@semantic-release/exec",
    ["@semantic-release/git", { "assets": ["CHANGELOG.md"] }],
    "@semantic-release/github"
  ]
}
```

No npm plugin. `@semantic-release/exec` is loaded but no-op when no `release_files:` are declared. When `release_files:` are present (see **Release file management** below), Flywheel synthesizes a `prepareCmd` for the exec plugin and extends `@semantic-release/git`'s `assets` list. Adopters never edit `.releaserc.json` directly — a committed `.releaserc.json` is overwritten on every push.

**Release file management:** Many ecosystems carry the version in a checked-in file (Flutter's `pubspec.yaml`, Cargo's `Cargo.toml`, .NET `.csproj`, Gradle, etc.). Adopters declare these in `.flywheel.yml` under `release_files:`; Flywheel turns the entries into `@semantic-release/exec` `prepareCmd` invocations and adds each path to `@semantic-release/git`'s `assets` so the bumped file is committed alongside the changelog.

```yaml
flywheel:
  release_files:
    - path: pubspec.yaml
      pattern: '^version: .*'
      replacement: 'version: ${version}+${build}'
    - path: pyproject.toml
      cmd: |
        python bump.py "${version}"
```

Each entry is a tagged union: either a declarative `{ pattern, replacement }` pair (Flywheel emits a `sed -i.bak -E` invocation) or a freeform `{ cmd }` (Flywheel runs the shell string verbatim after placeholder substitution). Exactly one form per entry; mixing both is a parse-time error. The sed delimiter is `|`, so `pattern` and `replacement` may not contain a literal `|`.

Three placeholders are available in `replacement` and `cmd`:

| Placeholder  | Substituted to                       | Notes                                                                                              |
| ------------ | ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `${version}` | `${nextRelease.version}`             | Full semver string (e.g. `1.2.3`, `1.2.3-rc.1`).                                                   |
| `${channel}` | `${nextRelease.channel \|\| ''}`     | Prerelease channel (`rc`, `dev`, …); empty string on production releases.                          |
| `${build}`   | `${BUILD}` (shell variable)          | Monotonic integer = `$(git tag --list 'v*' \| wc -l) + 1`. Required for Play Store / App Store.    |

All entries share a single `prepareCmd` that begins `BUILD=$(( $(git tag --list 'v*' | wc -l) + 1 ))` and `&&`-chains every entry. Failure of any step aborts the release. Plugin order is preserved — `@semantic-release/exec` runs after `@semantic-release/changelog` and before `@semantic-release/git`, so file edits land in the same release commit as the changelog.

The build number is **tag-count-based**: it counts existing `v*` tags repo-wide and adds one. This is monotonic across rc and prod releases (a property the Play Store and App Store require) but is not a "build number per branch" — every release, regardless of channel, increments it. Adopters who need a different scheme should use the `cmd` form to compute their own.

**Branch config:** For each stream, Flywheel generates a `branches` array in stream order. This ordered declaration anchors pre-release versions to the stream's shared version history:

```json
{
  "tagFormat": "v${version}",
  "branches": [
    { "name": "develop", "prerelease": "dev", "channel": "dev" },
    { "name": "staging", "prerelease": "rc", "channel": "rc" },
    { "name": "main" }
  ]
}
```

**Tag format scoping:** Each stream gets a unique `tagFormat` to prevent repo-global tag collisions. The primary stream (first stream defined, or only stream with `release: production` terminal branch) uses `v${version}`. All other streams use `{stream-name}/v${version}`:

```json
{
  "tagFormat": "customer-acme/v${version}",
  "branches": [{ "name": "customer-acme" }]
}
```

**Single-branch streams:** semantic-release requires at least one non-pre-release branch in its config (`ERELEASEBRANCHES` error otherwise). A stream whose only branch is `release: prerelease` (e.g. `customer-acme` with `suffix: acme`) is treated by Flywheel as a release branch — the `suffix` field in `.flywheel.yml` controls the tag format prefix, not semantic-release's `prerelease` flag. The branch is declared as a normal release branch with a scoped tag format.

**`release: none` branches:** branches with `release: none` are filtered out of the generated `.releaserc.json` `branches` array entirely. They don't appear in any stream's release config and pushes to them skip the semantic-release step (no `.releaserc.json` is written). They still participate in promotion PRs as a normal stream member, and they still receive back-merges from downstream releases (so `CHANGELOG.md` stays in sync).

For repositories with multiple streams, `pr-conductor` detects which stream the current branch belongs to and generates the appropriate `.releaserc.json` scoped to that stream. Each stream runs semantic-release independently.

### Why semantic-release over release-please

Both tools handle conventional commit parsing and changelog generation. semantic-release is the better fit for Flywheel for three reasons:

**Multi-branch pre-release channels.** semantic-release natively models N branches with independent pre-release identifiers and handles version ordering and conflict detection between them. release-please is fundamentally single-branch and requires workarounds for this pattern.

**Event-driven model compatibility.** semantic-release runs as a CLI step and exits. It doesn't own PRs or drive the merge flow — it just computes and tags. This composability is exactly what the Flywheel event-driven model requires. release-please wants to be the orchestrator.

**Monorepo path.** When monorepo support is added, semantic-release's manifest mode supports N independently versioned packages with per-package tag prefixes (`pkg-a/v1.2.0`, `pkg-b/v3.0.0`). This composes with Flywheel's model without structural changes.

---

## PR title and body

`pr-conductor` owns and rewrites the PR title and body for all PRs targeting managed branches. Reviewers use comments for human notes — not the body.

### Title format

```
<type>[(<scope>)][!]: <description>
```

Examples:

```
fix(auth): handle token refresh race condition
feat!: drop support for API v1
chore: update dependencies
```

### Body format

```markdown
## Summary

<description>

## Changes

### fix

- handle token refresh race condition (abc1234)

### chore

- update dependencies (def5678)

---

**Increment type:** patch
**Target branch:** develop
**Status:** ✅ flywheel:auto-merge — fix is in auto_merge list for develop
**Quality checks:** ⏳ pending
```

For human review required:

```markdown
---

**Increment type:** minor
**Target branch:** main
**Status:** 👀 flywheel:needs-review — feat not in auto_merge list for main
**Quality checks:** ✅ passed
```

### Labels

Every PR targeting a managed branch receives exactly one Flywheel label:

| Label                   | Meaning                                                               |
| ----------------------- | --------------------------------------------------------------------- |
| `flywheel:auto-merge`   | Eligible for auto-merge per branch config. Native auto-merge enabled. |
| `flywheel:needs-review` | Requires human approval before merge. Auto-merge not enabled.         |

Labels are updated on every `synchronize` event (new commit pushed to PR). A PR that was `needs-review` becomes `auto-merge` if the author amends the title to a qualifying type.

### Promotion PR format

When `pr-conductor` upserts a promotion PR (e.g. `develop → staging`, the next branch in the stream):

**Title:**

```
<most-impactful-type>[!]: promote develop → staging
```

Where `<most-impactful-type>` is derived from the highest-precedence commit type in the pending commits, using this order:

`feat!` > `fix!` > `<any other>!` > `feat` > `fix` > `perf` > `refactor` > `chore` / `style` / `test` / `docs` > `build` / `ci`

This determines whether the promotion PR itself gets `flywheel:auto-merge` or `flywheel:needs-review` against the target branch's `auto_merge` list — using the same evaluation logic as any other PR.

**Body:** Accumulated changelog of all commits pending in this promotion, formatted as a CHANGELOG.md fragment. Recomputed on every push to the source branch.

---

## Distribution and adopter setup

### Distribution

Flywheel is published to the GitHub Actions marketplace as `point-source/flywheel@v2`. Adopters reference it directly — no forking required. The marketplace Action contains `pr-conductor` (TypeScript/Deno). The two thin entrypoint workflow files (`flywheel-pr.yml`, `flywheel-push.yml`) are copied once into the adopting repo.

### What you need

A GitHub App with:

- Contents: read and write (tag creation, `.releaserc.json` write)
- Pull requests: read and write (PR creation, body/label updates, auto-merge)
- Issues: read and write (label add/remove on PRs)
- Checks: read and write (post the `flywheel/conventional-commit` check)
- Metadata: read (always required)

Store the App credentials as `FLYWHEEL_GH_APP_ID` + `FLYWHEEL_GH_APP_PRIVATE_KEY` repo secrets and pass them straight into the Flywheel action via the `app-id` and `app-private-key` inputs. The action mints its own installation token internally, validates that the granted permissions match the list above, and exposes the token as a step output for downstream steps that need it (e.g. semantic-release). Adopters do **not** add a separate `actions/create-github-app-token` step.

Personal Access Tokens are not supported — they don't reliably propagate the cross-workflow trigger semantics Flywheel relies on (in particular, native auto-merge enable and downstream workflow firing on bot-created PRs).

### Files to add

```
your-repo/
├── .flywheel.yml                    ← you write this
├── .github/
│   └── workflows/
│       ├── flywheel-pr.yml          ← copy from Flywheel docs (thin, rarely changes)
│       ├── flywheel-push.yml        ← copy from Flywheel docs (thin, rarely changes)
│       ├── build.yml                ← you write: on: release published
│       └── publish.yml              ← you write: on: workflow_run
```

### `flywheel-pr.yml` (copy as-is)

```yaml
name: Flywheel — PR
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review, edited]
concurrency:
  group: flywheel-pr-${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  conduct:
    # Only run on 'edited' events when a human triggered the edit.
    # Bot-driven edits (the Flywheel App rewriting titles/bodies, push-flow
    # upserting promotion PR bodies) would otherwise flap conduct ↔ push-flow
    # writes on every promotion-source push.
    if: |
      github.event.pull_request.draft == false &&
      (github.event.action != 'edited' || github.event.sender.type == 'User')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: point-source/flywheel@v2
        with:
          event: pull_request
          app-id: ${{ secrets.FLYWHEEL_GH_APP_ID }}
          app-private-key: ${{ secrets.FLYWHEEL_GH_APP_PRIVATE_KEY }}
```

### `flywheel-push.yml` (copy as-is)

```yaml
name: Flywheel — Push
on:
  push:
    branches: ["**"]
concurrency:
  group: flywheel-push-${{ github.ref_name }}
  cancel-in-progress: false
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
          # Don't persist the workflow's default GITHUB_TOKEN as a git
          # extraheader — it would shadow the App installation token that
          # semantic-release embeds in its push URL, and the workflow's
          # token only has read scope here.
          persist-credentials: false
      - uses: point-source/flywheel@v2
        id: flywheel
        with:
          event: push
          app-id: ${{ secrets.FLYWHEEL_GH_APP_ID }}
          app-private-key: ${{ secrets.FLYWHEEL_GH_APP_PRIVATE_KEY }}
      - name: Run semantic-release
        # Only runs when pr-conductor confirms this is a managed branch and
        # has written a .releaserc.json. Unmanaged branch pushes exit cleanly.
        if: steps.flywheel.outputs.managed_branch == 'true'
        # Plugins must be co-installed; npx will not resolve them from the
        # generated .releaserc.json on its own (else MODULE_NOT_FOUND).
        run: |
          npx --yes \
            -p semantic-release@24 \
            -p @semantic-release/commit-analyzer \
            -p @semantic-release/release-notes-generator \
            -p @semantic-release/changelog \
            -p @semantic-release/exec \
            -p @semantic-release/git \
            -p @semantic-release/github \
            semantic-release
        env:
          GITHUB_TOKEN: ${{ steps.flywheel.outputs.token }}
      - name: Back-merge release into upstream branches
        if: |
          steps.flywheel.outputs.managed_branch == 'true' &&
          steps.flywheel.outputs.back_merge_targets != ''
        shell: bash
        env:
          GITHUB_TOKEN: ${{ steps.flywheel.outputs.token }}
          BACK_MERGE_TARGETS: ${{ steps.flywheel.outputs.back_merge_targets }}
          RELEASED_BRANCH: ${{ github.ref_name }}
        run: |
          set -euo pipefail
          new_tags="$(git tag --points-at HEAD)"
          if [[ -z "$new_tags" ]]; then
            echo "::notice::No tag at HEAD — semantic-release did not publish; skipping back-merge."
            exit 0
          fi
          new_tag="$(echo "$new_tags" | head -n1)"
          git config user.name  'github-actions[bot]'
          git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
          IFS=',' read -ra UPSTREAMS <<< "$BACK_MERGE_TARGETS"
          for upstream in "${UPSTREAMS[@]}"; do
            git fetch origin "$upstream:$upstream"
            git checkout "$upstream"
            if git merge --ff-only "$RELEASED_BRANCH" 2>/dev/null; then
              echo "Fast-forwarded $upstream to $RELEASED_BRANCH."
            else
              git merge --no-ff -m "chore: back-merge $new_tag from $RELEASED_BRANCH into $upstream" "$RELEASED_BRANCH"
            fi
            git push origin "$upstream"
          done
```

`pr-conductor` sets `managed_branch` output to `true` when the pushed branch is found in a stream in `.flywheel.yml`, and writes `.releaserc.json` to the workspace. If the branch is not managed, it sets `managed_branch` to `false` and exits without writing any files — the semantic-release step is skipped entirely.

### `build.yml` (you write this)

```yaml
name: Build
on:
  release:
    types: [published]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/create-github-app-token@v1
        id: app-token
        with:
          app-id: ${{ secrets.FLYWHEEL_GH_APP_ID }}
          private-key: ${{ secrets.FLYWHEEL_GH_APP_PRIVATE_KEY }}
      - name: Build
        run: ./your-build-script.sh
        env:
          VERSION: ${{ github.event.release.tag_name }}
          CHANGELOG: ${{ github.event.release.body }}
      - name: Upload artifact
        # actions/upload-release-asset is archived. Use softprops/action-gh-release
        # or the GitHub CLI instead.
        uses: softprops/action-gh-release@v2
        with:
          files: ./dist/your-artifact
        env:
          GITHUB_TOKEN: ${{ steps.app-token.outputs.token }}
```

### `publish.yml` (you write this)

```yaml
name: Publish
on:
  workflow_run:
    workflows: [Build]
    types: [completed]
jobs:
  publish:
    if: github.event.workflow_run.conclusion == 'success'
    runs-on: ubuntu-latest
    steps:
      - name: Download artifact
        run: # download from release assets
      - name: Publish
        run: ./your-publish-script.sh
```

---

## Branch protection and rulesets

Quality checks are **not configured in `.flywheel.yml`**. Define them as normal GitHub Actions workflows and register their check names as required status checks in branch protection. Flywheel does not invoke or wait for them.

**Critical:** workflows that serve as required status checks must include **both** `pull_request` and `merge_group` triggers. Without `merge_group`, the check will not run when a PR enters the merge queue, causing the queue to stall waiting for a check that never fires.

```yaml
# Example quality check workflow
name: Quality
on:
  pull_request:
  merge_group: # required for merge queue compatibility
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - run: ./your-test-script.sh
```

The check name registered in branch protection must match the job name exactly (e.g. `test` in the example above).

### Ruleset 1 — Protect managed branches

Target all branches listed in `.flywheel.yml`. Enable: require PRs, require status checks (add your quality check names), block force push, block deletion, require linear history. **Bypass actor: the Flywheel GitHub App, in `bypass_mode: always` — required.** Without this, two pushes are rejected: semantic-release's `chore(release)` commit + tag (rejected by "changes must be made through a pull request" → `EGITNOPERMISSION`) and the back-merge merge commit into upstream branches (rejected by linear-history). `scripts/apply-rulesets.sh --app-id <id>` writes this for you and applies it to every managed branch in the stream.

### Ruleset 2 — Merge queue

Enable on all managed branches.

- `develop`-style branches: batch up to 5, minimum group 1
- Stricter branches (`main`, etc.): group size 1

### Ruleset 3 — Protect `v*` tag namespace

Only the GitHub App bot may create or delete version tags. Prevents agents from minting arbitrary version tags and breaking version computation.

### Ruleset 4 — Branch naming (optional)

Require feature branches to match `(feat|fix|chore|refactor|perf|style|test|docs|build|ci|revert)/.*`.

---

## `pr-conductor` implementation sketch

TypeScript, compiled to a single bundled JavaScript file for distribution. Published as a marketplace Action via `action.yml` with `runs.using: node24`. The build step uses `esbuild` to bundle the compiled output and all dependencies into a single `dist/index.cjs` — the standard approach for all marketplace actions. Source is TypeScript; the compiled bundle is what GitHub executes.

### On `pull_request` event

1. Read and validate `.flywheel.yml` — emit failing check and exit on validation errors
2. Find branch entry matching `github.base_ref` — exit silently if not a managed branch
3. Parse PR title: `type(scope)!: description` — fail check if not valid conventional commit
4. Detect breaking flag: `!` in title OR `BREAKING CHANGE:` footer in any commit body on branch
5. Determine increment type: breaking → major, feat → minor, fix/perf → patch, else → none
6. Rewrite PR title to normalized format
7. Rewrite PR body with changelog fragment, increment type, auto-merge status
8. Construct match key: `type` or `type!` if breaking
9. Check if match key is in branch `auto_merge` list
10. If eligible: apply `flywheel:auto-merge` label and call GraphQL `enablePullRequestAutoMerge`. If the mutation refuses (typical when the PR is in clean state because the repo has no required checks), fall through to a direct REST `pulls.merge` so the PR still merges. If both fail, leave the label applied, log a warning, and exit cleanly — the PR remains queryable for manual action.
11. If not eligible: apply `flywheel:needs-review` label, remove `flywheel:auto-merge` label if present, disable native auto-merge on the PR

### On `push` event — release flow (always runs)

1. Read `.flywheel.yml` — exit silently if pushed branch not in any stream
2. Find the stream containing the pushed branch
3. Generate `.releaserc.json` from that stream's branch array, in order
4. Exit — semantic-release runs as the next step in `flywheel-push.yml` and picks up the generated config

### On `push` event — promotion PR flow (independent of release flow)

1. Read `.flywheel.yml` — find which stream contains the pushed branch
2. If pushed branch is the last branch in its stream — exit (terminal branch; no promotion PR; does not affect whether a release occurs)
3. Identify next branch in stream array as the promotion target
4. Collect pending commits using commit message matching rather than SHA ancestry. Because the default `merge_strategy: squash` produces new SHAs on the target branch, SHA-based ancestry (`git log target..source`) will incorrectly show already-promoted commits as pending. Instead, Flywheel compares commit messages (conventional commit title lines) between source and target, excluding messages already present in target branch history since the last Flywheel promotion tag.
5. If no qualifying commits (only non-bumping types since last promotion) — exit without creating or updating the promotion PR. This is intentional: chore/style/docs/etc. commits have no release significance on their own and will be included in the next promotion PR when a qualifying commit joins them. The promotion PR is a signal that something worth releasing is ready to move forward.
6. Determine most impactful commit type from pending commits using precedence order
7. Generate accumulated changelog from pending commits
8. Construct promotion PR title using most impactful type
9. Check if most impactful type is in target branch `auto_merge` list
10. Check for existing open PR from source → target
11. If none: create PR, apply `flywheel:auto-merge` or `flywheel:needs-review` label
12. If exists: update title, body, and label

---

## Open questions / deferred decisions

- **Monorepo support:** Multiple independently versioned packages in one repo. The stream model maps directly — each package gets its own stream with an optional `path` field scoping it to a subdirectory. semantic-release manifest mode is the underlying mechanism. Deferred to v2 but the config structure is designed to accommodate it without breaking changes: `path` is simply added as an optional stream-level field.
- **Cross-stream version collision:** Documented above as a known property of independent streams. Validation errors when multiple streams have `release: production` terminal branches. Deeper tooling (e.g. a publish destination uniqueness check) is out of scope for v1.
- **Commit message validation on feature branches:** Flywheel validates PR titles (which become squash commit messages). Individual commit messages on feature branches are not validated. A `commitlint` pre-commit hook or push-triggered check in the adopting repo fills this gap if needed.
- **Notification hooks:** Out of scope for v1. Implement as steps in user-defined `publish.yml`.
- **TypeScript compilation:** `pr-conductor` is authored in TypeScript and compiled to a bundled `dist/index.cjs` via `esbuild` before release. The `runs.using: node24` runtime in `action.yml` executes the bundle directly. The compiled output is committed alongside the source so marketplace consumers don't need a build step; a `verify-dist` CI job checks for drift between source and bundle on every PR.
