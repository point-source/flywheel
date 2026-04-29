# Adopter setup

Step-by-step guide to wiring Flywheel into your repository.

## Prerequisites

- A GitHub repository where you have admin access (required to create secrets, branch rulesets, and enable merge queue).
- GitHub Actions enabled.
- Familiarity with [Conventional Commits](https://www.conventionalcommits.org/) — Flywheel rewrites every PR title against this grammar.
- Optional: GitHub merge queue enabled on managed branches. Flywheel does not require it, but if multiple PRs target the same branch concurrently (typical with agent swarms), the queue serializes them safely.

## Quick start (one command)

If you have `gh`, `jq`, and `yq` installed and you're in your repo with `gh auth login` already done, the steps below collapse to:

```bash
curl -fsSL https://raw.githubusercontent.com/point-source/flywheel/v1/scripts/init.sh | bash
```

`init.sh` picks a `.flywheel.yml` preset, writes both adopter workflow files, prompts for your GitHub App credentials, and optionally applies the branch + tag rulesets. Then validate with:

```bash
curl -fsSL https://raw.githubusercontent.com/point-source/flywheel/v1/scripts/doctor.sh | bash
```

The rest of this document is the manual walkthrough — useful if you want to understand what `init.sh` writes, or if you're retrofitting an existing setup.

## 1. Create a GitHub App

Flywheel uses a GitHub App installation token. Personal Access Tokens are not supported — they don't reliably propagate the cross-workflow trigger semantics Flywheel relies on (in particular, native auto-merge enable and downstream workflow firing on bot-created PRs).

Follow GitHub's [Creating a GitHub App](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/creating-a-github-app) guide. Required permissions:

- **Contents: read and write** — tag creation, `.releaserc.json` write
- **Pull requests: read and write** — PR creation, body updates, auto-merge
- **Issues: read and write** — adding / removing the `flywheel:*` labels on PRs
- **Checks: read and write** — posting the `flywheel/conventional-commit` check
- **Metadata: read**

Install the App on your repo. Then store its credentials as repo secrets:

- `APP_ID` — the numeric App ID (visible on the App's settings page).
- `APP_PRIVATE_KEY` — the PEM-format private key downloaded from the App settings.

Each Flywheel workflow mints a short-lived installation token at the start of the job via [`actions/create-github-app-token`](https://github.com/actions/create-github-app-token); see the workflow YAML in §3 below.

## 2. Add `.flywheel.yml`

Place at the root of your repo. Start from one of these.

**Minimal viable** — single stream, single branch, immediate releases:

```yaml
flywheel:
  streams:
    - name: main-line
      branches:
        - name: main
          auto_merge: [fix, chore, docs]
  merge_strategy: squash
  initial_version: 0.1.0
```

A single-branch stream releases on every qualifying push and creates no promotion PRs. This is the simplest valid configuration.

**Three-stage promotion** — `develop` → `staging` → `main`:

```yaml
flywheel:
  streams:
    - name: main-line
      branches:
        - name: develop
          prerelease: dev
          auto_merge: [fix, fix!, feat, chore, refactor, perf, style, test, docs]
        - name: staging
          prerelease: rc
          auto_merge: [fix, chore, style, test, docs]
        - name: main
          auto_merge: []   # all PRs require human approval
  merge_strategy: squash
  initial_version: 0.1.0
```

A multi-stream example with a customer variant:

```yaml
flywheel:
  streams:
    - name: main-line
      branches:
        - name: develop
          prerelease: dev
          auto_merge: [fix, feat, chore]
        - name: main
          auto_merge: []
    - name: customer-acme
      branches:
        - name: customer-acme
          prerelease: acme
          auto_merge: [fix, fix!, chore]
  merge_strategy: squash
  initial_version: 0.1.0
```

## 3. Add the Flywheel workflows

Both files reference `point-source/flywheel@v1` — a floating major tag that picks up bug-fix and feature releases automatically. Pin to an exact version like `point-source/flywheel@v1.2.3` if you need fully reproducible runs.

Create `.github/workflows/flywheel-pr.yml`:

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
      - uses: actions/create-github-app-token@v1
        id: app-token
        with:
          app-id: ${{ secrets.APP_ID }}
          private-key: ${{ secrets.APP_PRIVATE_KEY }}
      - uses: actions/checkout@v4
      - uses: point-source/flywheel@v1
        with:
          event: pull_request
          token: ${{ steps.app-token.outputs.token }}
```

Create `.github/workflows/flywheel-push.yml`:

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
      - uses: actions/create-github-app-token@v1
        id: app-token
        with:
          app-id: ${{ secrets.APP_ID }}
          private-key: ${{ secrets.APP_PRIVATE_KEY }}
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          token: ${{ steps.app-token.outputs.token }}
      - uses: point-source/flywheel@v1
        id: flywheel
        with:
          event: push
          token: ${{ steps.app-token.outputs.token }}
      - name: Run semantic-release
        if: steps.flywheel.outputs.managed_branch == 'true'
        run: npx semantic-release@24
        env:
          GITHUB_TOKEN: ${{ steps.app-token.outputs.token }}
```

## 4. Add your build and publish workflows

These react to events Flywheel produces. Flywheel does not call them.

`build.yml`:

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
      - uses: actions/create-github-app-token@v1
        id: app-token
        with:
          app-id: ${{ secrets.APP_ID }}
          private-key: ${{ secrets.APP_PRIVATE_KEY }}
      - name: Upload artifact
        uses: softprops/action-gh-release@v2
        with:
          files: ./dist/your-artifact
        env:
          GITHUB_TOKEN: ${{ steps.app-token.outputs.token }}
```

`publish.yml`:

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
        run: # download from the release assets via gh api
      - name: Publish
        run: ./your-publish-script.sh
```

## 5. Set up branch protection

Flywheel does not invoke or wait for your quality checks — register them yourself as required status checks.

**Critical:** any workflow used as a required status check **must include both** `pull_request` and `merge_group` triggers. Without `merge_group`, the merge queue stalls waiting for a check that never fires.

```yaml
name: Quality
on:
  pull_request:
  merge_group:    # required for merge queue compatibility
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: ./your-test-script.sh
```

### Recommended rulesets

1. **Protect managed branches** — target every branch listed in `.flywheel.yml`. Require PRs, require status checks (your quality check names), block force push, block deletion, require linear history. Bypass actor: your Flywheel GitHub App.
2. **Merge queue** on managed branches. Stricter branches (`main`) use group size 1; `develop`-style branches can batch up to 5.
3. **Protect `v*` tag namespace** — only the bot may create or delete version tags. Prevents agents from minting arbitrary version tags.
4. **Branch naming (optional)** — require feature branches to match `(feat|fix|chore|refactor|perf|style|test|docs|build|ci|revert)/.*`.

The first and third rulesets can be applied in one command:

```bash
scripts/apply-rulesets.sh <owner/repo> --required-checks "Quality" --app-id <your-app-id>
```

(Or via `curl -fsSL https://raw.githubusercontent.com/point-source/flywheel/v1/scripts/apply-rulesets.sh | bash -s -- <owner/repo>` if you don't have the Flywheel repo checked out.)

## 6. Verify

Run the doctor script — it validates everything the prior steps configured without needing a real PR:

```bash
curl -fsSL https://raw.githubusercontent.com/point-source/flywheel/v1/scripts/doctor.sh | bash
```

`doctor.sh` confirms `.flywheel.yml` parses, every managed branch exists, `APP_ID` + `APP_PRIVATE_KEY` are set, `Allow auto-merge` is on, both Flywheel workflow files exist with App-token plumbing, a ruleset covers each managed branch, and the `v*` tag namespace is protected. Anything red is annotated with the script you should run to fix it.

Then open a small PR titled `chore: smoke test`. Confirm:

- The PR title and body get rewritten.
- A `flywheel:auto-merge` or `flywheel:needs-review` label is applied.
- Native auto-merge is enabled (if eligible).

Merge the PR. On the resulting push, confirm:

- A new tag is cut (e.g. `v0.1.1-dev.1`).
- A GitHub Release is published.
- Your `build.yml` fires.

## 7. Troubleshooting

**PR title wasn't rewritten.** Open the `Flywheel — PR` workflow run and look at the `conduct` job log. Common causes: the PR is still a draft (`flywheel-pr.yml` skips drafts), the target branch isn't listed in any stream in `.flywheel.yml`, or the title isn't a recognized Conventional Commit type.

**Got `flywheel:needs-review` but expected `flywheel:auto-merge`.** Compare the PR's commit type (with `!` if breaking) against the target branch's `auto_merge` list. `fix!` only matches if `fix!` is listed explicitly — listing `fix` doesn't imply `fix!`.

**Native auto-merge wasn't enabled even though the PR got `flywheel:auto-merge`.** Either the branch doesn't have native auto-merge enabled (check **Settings → General → Pull Requests → Allow auto-merge**), the App lacks **Pull requests: write**, or the workflow is reading `secrets.GITHUB_TOKEN` instead of an App installation token. `doctor.sh` flags all three.

**Promotion PR didn't appear after merging to a non-terminal branch.** Either the branch is the terminal (last) branch in its stream — terminal branches release but don't promote — or the pending commits are all non-bumping types (`chore`, `style`, `docs`, `test`, `ci`, `build`, `refactor`). Promotion PRs only open when something with release significance is ready to move forward; the non-bumping commits will be included in the next promotion.

**`semantic-release` ran and said no release was published.** Same root cause: the commits since the last tag are all non-bumping. This is intentional — no tag, no Release, no `build.yml` trigger.

**Tag collision error from `semantic-release`.** Two streams produced the same tag string. Flywheel scopes tags per stream automatically (e.g. `customer-acme/v1.0.1` for non-primary streams), so if you see this, please file an issue with your `.flywheel.yml`.

**PR opened by Flywheel doesn't trigger your quality checks.** Make sure your check workflows include `merge_group:` as well as `pull_request:` — without it, the merge queue stalls waiting for a check that never fires (see the snippet above).
