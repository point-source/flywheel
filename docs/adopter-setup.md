# Adopter setup

Step-by-step guide to wiring Flywheel into your repository.

## 1. Create a token

Flywheel needs a token with these scopes:

- **Contents: read and write** — tag creation, `.releaserc.json` write
- **Pull requests: read and write** — PR creation, body/label updates, auto-merge
- **Metadata: read**

Either:

- A **Personal Access Token (classic)** with `repo` + `workflow` scope, stored as `GH_PAT`.
- A **GitHub App** installation token, computed in workflow from `APP_ID` + `APP_PRIVATE_KEY` repo secrets.

`GITHUB_TOKEN` is sufficient for most cases but cannot trigger downstream workflows from PRs it creates.

## 2. Add `.flywheel.yml`

Place at the root of your repo. Minimal three-stage example:

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
