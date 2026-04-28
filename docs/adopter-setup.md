# Adopter setup

Step-by-step guide to wiring Flywheel into your repository.

## Prerequisites

- A GitHub repository where you have admin access (required to create secrets, branch rulesets, and enable merge queue).
- GitHub Actions enabled.
- Familiarity with [Conventional Commits](https://www.conventionalcommits.org/) — Flywheel rewrites every PR title against this grammar.
- Optional: GitHub merge queue enabled on managed branches. Flywheel does not require it, but if multiple PRs target the same branch concurrently (typical with agent swarms), the queue serializes them safely.

## 1. Create a token

Flywheel needs a token with these scopes:

- **Contents: read and write** — tag creation, `.releaserc.json` write
- **Pull requests: read and write** — PR creation, body/label updates, auto-merge
- **Metadata: read**

Either:

- **Personal Access Token (classic)** — quickest path. Create one with `repo` + `workflow` scope and store it as repo secret `GH_PAT`. The samples below use this.
- **GitHub App installation token** — recommended for production. Create a GitHub App with the same scopes, install it on your repo, and store its `APP_ID` + `APP_PRIVATE_KEY` as secrets. Use [`actions/create-github-app-token`](https://github.com/actions/create-github-app-token) at the start of each workflow to mint a short-lived installation token, then pass that to `flywheel-ci/flywheel`. See GitHub's [Creating a GitHub App](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/creating-a-github-app) docs.

`GITHUB_TOKEN` works for most operations but cannot trigger downstream workflows from PRs it creates — promotion PRs opened with `GITHUB_TOKEN` will not fire your `flywheel-pr.yml`. Use a PAT or App token for the dogfooded promotion flow.

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

Both files reference `flywheel-ci/flywheel@v1` — a floating major tag that picks up bug-fix and feature releases automatically. Pin to an exact version like `flywheel-ci/flywheel@v1.2.3` if you need fully reproducible runs.

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
      - uses: actions/checkout@v4
      - uses: flywheel-ci/flywheel@v1
        with:
          event: pull_request
          token: ${{ secrets.GH_PAT }}
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
        if: steps.flywheel.outputs.managed_branch == 'true'
        run: npx semantic-release@24
        env:
          GITHUB_TOKEN: ${{ secrets.GH_PAT }}
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
      - name: Upload artifact
        uses: softprops/action-gh-release@v2
        with:
          files: ./dist/your-artifact
        env:
          GITHUB_TOKEN: ${{ secrets.GH_PAT }}
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

1. **Protect managed branches** — target every branch listed in `.flywheel.yml`. Require PRs, require status checks (your quality check names), block force push, block deletion, require linear history. Bypass actor: GitHub App / PAT only.
2. **Merge queue** on managed branches. Stricter branches (`main`) use group size 1; `develop`-style branches can batch up to 5.
3. **Protect `v*` tag namespace** — only the bot may create or delete version tags. Prevents agents from minting arbitrary version tags.
4. **Branch naming (optional)** — require feature branches to match `(feat|fix|chore|refactor|perf|style|test|docs|build|ci|revert)/.*`.

## 6. Verify

Open a small PR titled `chore: smoke test`. Confirm:

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

**Native auto-merge wasn't enabled even though the PR got `flywheel:auto-merge`.** The token can't enable auto-merge: either you used `GITHUB_TOKEN` (which can't trigger downstream workflows on PRs it creates) or the branch doesn't have native auto-merge enabled. Check **Settings → General → Pull Requests → Allow auto-merge**.

**Promotion PR didn't appear after merging to a non-terminal branch.** Either the branch is the terminal (last) branch in its stream — terminal branches release but don't promote — or the pending commits are all non-bumping types (`chore`, `style`, `docs`, `test`, `ci`, `build`, `refactor`). Promotion PRs only open when something with release significance is ready to move forward; the non-bumping commits will be included in the next promotion.

**`semantic-release` ran and said no release was published.** Same root cause: the commits since the last tag are all non-bumping. This is intentional — no tag, no Release, no `build.yml` trigger.

**Tag collision error from `semantic-release`.** Two streams produced the same tag string. Flywheel scopes tags per stream automatically (e.g. `customer-acme/v1.0.1` for non-primary streams), so if you see this, please file an issue with your `.flywheel.yml`.

**PR opened by Flywheel doesn't trigger your quality checks.** Make sure your check workflows include `merge_group:` as well as `pull_request:` — without it, the merge queue stalls waiting for a check that never fires (see the snippet above).
