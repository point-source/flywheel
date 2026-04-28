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

**Minimal permissions footprint.** Most operations use `GITHUB_TOKEN`. A GitHub App or PAT is required only for creating PRs that trigger downstream workflows and pushing tags from workflow context.

**One config file.** `.flywheel.yml` in the adopting repo is the single source of truth for branch topology, auto-merge rules, and pipeline behavior. Flywheel derives everything else — including semantic-release configuration — from it at runtime.

---

## Components

### 1. `pr-conductor` (Flywheel's only custom code)

A TypeScript GitHub Action, published to the GitHub Actions marketplace as `flywheel-ci/flywheel@v1`. Implemented with Deno for native TypeScript execution without a compilation step.

Reacts to `pull_request` events and `push` events on managed branches. It is stateless — reads `.flywheel.yml`, reads/writes the PR or repo state, and exits. Holds no state between runs.

Responsibilities:

- Parse PR title as a conventional commit
- Rewrite PR title and body with changelog fragment and increment type
- Evaluate auto-merge eligibility against `.flywheel.yml` for the target branch
- Apply `flywheel:auto-merge` or `flywheel:needs-review` label
- Enable GitHub's native auto-merge when eligible
- On push to a non-terminal branch in a stream, upsert the promotion PR to the next branch in the stream

### 2. semantic-release

Handles version computation, changelog generation, git tagging, and GitHub Release creation. Runs as a step in `flywheel-push.yml` on push to any managed branch. `pr-conductor` generates `.releaserc.json` at runtime from `.flywheel.yml` — adopters never configure semantic-release directly.

### 3. GitHub merge queue

Serializes parallel PRs without manual rebasing. When multiple agent-opened PRs target the same branch, the merge queue tests each against the state that will exist when it is their turn. Flywheel enables auto-merge into the queue; it never bypasses it.

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
  └── create GitHub Release                               ├── check type against target's auto_merge
        │                                                 ├── eligible   → create/update PR + flywheel:auto-merge
        ▼                                                 └── ineligible → create/update PR + flywheel:needs-review
on: release published
  └── user build workflow fires independently
        │
        ▼
on: workflow_run build completed
  └── user publish workflow fires independently
```

**Important:** The release flow and the promotion PR flow are independent reactions to the same push event. A branch that is last in its stream (the terminal branch) still releases — being last means no promotion PR is created, not that no release occurs. Releases happen on every push to any managed branch where semantic-release computes a new version. A single-branch stream releases immediately on every qualifying push with no promotion step.

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
          # Optional. Semver pre-release identifier.
          # Absent or false = production release (no suffix).
          # Must be unique across streams if using a shared publish destination.
          prerelease: dev

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
          prerelease: rc
          auto_merge:
            - fix
            - chore
            - style
            - test
            - docs

        - name: main
          # prerelease absent = production release, no suffix
          auto_merge: [] # all PRs require human approval

    # A second stream for a customer variant — independent version history
    - name: customer-acme
      branches:
        - name: customer-acme
          prerelease: acme
          auto_merge:
            - fix
            - fix!
            - chore

  # Merge strategy: squash (default) | rebase
  # Note: 'merge' is intentionally omitted. The recommended branch ruleset
  # requires linear history, which is incompatible with merge commits.
  # If you need merge commits, disable the linear history ruleset requirement.
  merge_strategy: squash

  # Initial version if no tags exist in the repo.
  initial_version: 0.1.0
```

### Branch config fields

| Field        | Required | Default | Description                                                                                  |
| ------------ | -------- | ------- | -------------------------------------------------------------------------------------------- |
| `name`       | Yes      | —       | Git branch name                                                                              |
| `prerelease` | No       | `false` | Semver pre-release identifier, or `false` / absent for production release                    |
| `auto_merge` | Yes      | —       | List of commit types (with optional `!`) that auto-merge. Empty list = all need human review |

### Valid `auto_merge` entries

Any conventional commit type, with or without `!`:

`feat`, `feat!`, `fix`, `fix!`, `chore`, `chore!`, `refactor`, `refactor!`, `perf`, `perf!`,
`style`, `style!`, `test`, `test!`, `docs`, `docs!`, `build`, `build!`, `ci`, `ci!`, `revert`, `revert!`

A `fix!` entry matches PRs of type `fix` with a breaking change — indicated by `!` in the title or a `BREAKING CHANGE:` footer in any commit body on the branch. Listing `fix` and `fix!` independently allows breaking fixes through while still gating non-breaking fixes if desired.

### Validation

`pr-conductor` validates `.flywheel.yml` on every run and posts a failing check with a descriptive error if:

- A branch appears in more than one stream — each branch may belong to exactly one stream.
- More than one branch within the same stream has `prerelease: false` or absent — only the last branch in a stream should be the production release branch.
- More than one stream has a terminal branch (last branch) with `prerelease: false` and the streams share a publish destination — version collision is likely. A warning (not an error) is emitted with guidance to use distinct `prerelease` identifiers.
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

The first (or only) stream with a terminal `prerelease: false` branch uses the default `v${version}` tag format. All other streams use a prefixed format derived from their stream name. Flywheel generates this automatically — adopters do not configure `tagFormat` directly.

This means the "harmless collision" framing in earlier versions of this spec was incorrect. There is no safe scenario where two streams in the same repo produce the same tag string. The tag format scoping is mandatory and non-optional.

Flywheel emits a validation **error** (not warning) if multiple streams have terminal branches with `prerelease: false` and no tag format disambiguation can be inferred. In practice this means: at most one stream may have the "primary" `v${version}` tag format. All other streams are automatically prefixed.

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

The pre-release identifier comes from the `prerelease` field in `.flywheel.yml`. The counter increments automatically via semantic-release's tag inspection.

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
    ["@semantic-release/git", { "assets": ["CHANGELOG.md"] }],
    "@semantic-release/github"
  ]
}
```

No npm plugin. Adopters who need additional plugins (npm publish, pub.dev, etc.) add them to a `semantic_release_plugins` array in `.flywheel.yml` which gets merged into the generated config.

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

**Tag format scoping:** Each stream gets a unique `tagFormat` to prevent repo-global tag collisions. The primary stream (first stream defined, or only stream with `prerelease: false` terminal branch) uses `v${version}`. All other streams use `{stream-name}/v${version}`:

```json
{
  "tagFormat": "customer-acme/v${version}",
  "branches": [{ "name": "customer-acme" }]
}
```

**Single-branch streams:** semantic-release requires at least one non-pre-release branch in its config (`ERELEASEBRANCHES` error otherwise). A stream whose only branch has a `prerelease` identifier (e.g. `customer-acme` with `prerelease: acme`) is treated by Flywheel as a release branch — the `prerelease` field in `.flywheel.yml` controls the tag format prefix, not semantic-release's `prerelease` flag. The branch is declared as a normal release branch with a scoped tag format.

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

Flywheel is published to the GitHub Actions marketplace as `flywheel-ci/flywheel@v1`. Adopters reference it directly — no forking required. The marketplace Action contains `pr-conductor` (TypeScript/Deno). The two thin entrypoint workflow files (`flywheel-pr.yml`, `flywheel-push.yml`) are copied once into the adopting repo.

### What you need

A GitHub App or PAT with:

- Contents: read and write (tag creation, `.releaserc.json` write)
- Pull requests: read and write (PR creation, body/label updates, auto-merge)
- Metadata: read

Store as `APP_ID` + `APP_PRIVATE_KEY` (GitHub App) or `GH_PAT` (PAT) repo secrets.

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
    types: [opened, synchronize, reopened, ready_for_review]
concurrency:
  group: flywheel-pr-${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  conduct:
    if: github.event.pull_request.draft == false
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: flywheel-ci/flywheel@v1
        with:
          event: pull_request
          token: ${{ secrets.GH_PAT }}
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
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          token: ${{ secrets.GH_PAT }}
      - uses: flywheel-ci/flywheel@v1
        id: flywheel
        with:
          event: push
          token: ${{ secrets.GH_PAT }}
      - name: Run semantic-release
        # Only runs when pr-conductor confirms this is a managed branch and
        # has written a .releaserc.json. Unmanaged branch pushes exit cleanly.
        if: steps.flywheel.outputs.managed_branch == 'true'
        run: npx semantic-release
        env:
          GITHUB_TOKEN: ${{ secrets.GH_PAT }}
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
      - uses: actions/checkout@v4
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
          GITHUB_TOKEN: ${{ secrets.GH_PAT }}
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
      - uses: actions/checkout@v4
      - run: ./your-test-script.sh
```

The check name registered in branch protection must match the job name exactly (e.g. `test` in the example above).

### Ruleset 1 — Protect managed branches

Target all branches listed in `.flywheel.yml`. Enable: require PRs, require status checks (add your quality check names), block force push, block deletion, require linear history. Bypass actor: GitHub App bot only.

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

TypeScript, compiled to a single bundled JavaScript file for distribution. Target ~400–500 lines of source TypeScript. Published as a marketplace Action via `action.yml` with `runs.using: node24`. The build step uses `ncc` or `esbuild` to bundle the compiled output and all dependencies into a single `dist/index.js` — the standard approach for all marketplace actions. Source is TypeScript; the compiled bundle is what GitHub executes. No Deno runtime required.

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
10. If eligible: apply `flywheel:auto-merge` label, call GitHub API to enable auto-merge with configured merge strategy
11. If not eligible: apply `flywheel:needs-review` label, remove `flywheel:auto-merge` label if present

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
- **Cross-stream version collision:** Documented above as a known property of independent streams. Validation warns when multiple streams have `prerelease: false` terminal branches. Deeper tooling (e.g. a publish destination uniqueness check) is out of scope for v1.
- **Commit message validation on feature branches:** Flywheel validates PR titles (which become squash commit messages). Individual commit messages on feature branches are not validated. A `commitlint` pre-commit hook or push-triggered check in the adopting repo fills this gap if needed.
- **Notification hooks:** Out of scope for v1. Implement as steps in user-defined `publish.yml`.
- **TypeScript compilation:** `pr-conductor` is authored in TypeScript and compiled to a bundled `dist/index.js` via `ncc` or `esbuild` before release. The `runs.using: node24` runtime in `action.yml` executes the bundle directly. The compilation step runs in CI on the Flywheel repo itself and the compiled output is committed or attached to the release tag. This is the standard pattern for all marketplace actions.
