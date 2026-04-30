# Adopter setup

Step-by-step guide to wiring Flywheel into your repository.

## Prerequisites

- A GitHub repository where you have admin access (required to create secrets, branch rulesets, and enable merge queue).
- GitHub Actions enabled.
- Familiarity with [Conventional Commits](https://www.conventionalcommits.org/) — Flywheel rewrites every PR title against this grammar.
- **Strongly recommended:** GitHub merge queue enabled on managed branches. Flywheel works without it, but agent-swarm repos with high PR volume pay a steep GHA-minute tax on `pull_request: synchronize` retriggers without the queue's `merge_group:` batching. See [Cost control under high PR volume](#cost-control-under-high-pr-volume) in §5.

## Quick start (one command)

If you have `gh`, `jq`, and `python3` (with `PyYAML`) installed and you're in your repo with `gh auth login` already done, the steps below collapse to:

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

Pass these straight into the Flywheel action via the `app-id` and `app-private-key` inputs (see the workflow YAML in §3). The action mints its own short-lived installation token internally and validates that the App's granted permissions match the list above — if anything is missing it fails fast with a friendly error pointing you at the App settings. You do not need a separate `actions/create-github-app-token` step.

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
      - uses: actions/checkout@v4
      - uses: point-source/flywheel@v1
        with:
          event: pull_request
          app-id: ${{ secrets.APP_ID }}
          app-private-key: ${{ secrets.APP_PRIVATE_KEY }}
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
          # Don't persist the workflow's default GITHUB_TOKEN as a git
          # extraheader — it would shadow the App installation token that
          # semantic-release embeds in its push URL, and the workflow's
          # token only has read scope here.
          persist-credentials: false
      - uses: point-source/flywheel@v1
        id: flywheel
        with:
          event: push
          app-id: ${{ secrets.APP_ID }}
          app-private-key: ${{ secrets.APP_PRIVATE_KEY }}
      - name: Run semantic-release
        if: steps.flywheel.outputs.managed_branch == 'true'
        # Plugins must be co-installed; npx will not resolve them from the
        # generated .releaserc.json on its own (else MODULE_NOT_FOUND).
        run: |
          npx --yes \
            -p semantic-release@24 \
            -p @semantic-release/commit-analyzer \
            -p @semantic-release/release-notes-generator \
            -p @semantic-release/changelog \
            -p @semantic-release/git \
            -p @semantic-release/github \
            semantic-release
        env:
          GITHUB_TOKEN: ${{ steps.flywheel.outputs.token }}
```

Both files are also available verbatim under [`scripts/templates/`](../scripts/templates/) in the Flywheel repo — `init.sh` writes them for you in the quick-start path.

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

1. **Protect managed branches** — target every branch listed in `.flywheel.yml`. Require PRs, require status checks (your quality check names), block force push, block deletion, require linear history. **Bypass actor: your Flywheel GitHub App, in `bypass_mode: always` — required.** Without this, `semantic-release` cannot push the version commit + tag back to the managed branch (the PR-only rule rejects it) and every release fails with `EGITNOPERMISSION`.
2. **Merge queue** on managed branches. Stricter branches (`main`) use group size 1; `develop`-style branches can batch up to 5.
3. **Protect `v*` tag namespace** — only the bot may create or delete version tags. Prevents agents from minting arbitrary version tags. The App is added as a bypass actor here too so it can mint the release tag.
4. **Branch naming (optional)** — require feature branches to match `(feat|fix|chore|refactor|perf|style|test|docs|build|ci|revert)/.*`.

### Cost control under high PR volume

Flywheel is designed for repos where agent swarms produce dozens or hundreds of open PRs concurrently. A few configuration knobs matter more than they would in a low-throughput repo:

- **Treat the merge queue as mandatory, not optional.** When PRs are required to be up-to-date with their base before merging, the merge queue's `merge_group:` events run required checks **once per merged batch** instead of once per PR. With group size 5 on a `develop` branch, that's up to a 5× reduction in quality-check minutes. Without the queue, every merge to base triggers `pull_request: synchronize` on rebase candidates and you pay for each individually.
- **Do NOT enable "Always suggest updating pull request branches"** (Settings → General → Pull Requests). This setting auto-rebases every open PR every time the base advances. With 100 open PRs, every merge fires 100 `synchronize` events, each running every `pull_request:`-subscribed workflow. Let the merge queue freshen branches at queue time instead — it's the same correctness guarantee at a tiny fraction of the GHA-minute cost.
- **Don't subscribe heavy workflows to `pull_request: synchronize` if you can avoid it.** Lint and unit tests are fine — they're seconds, not minutes. Reserve full integration / e2e suites for `merge_group:` only. Adopters who put expensive workflows on both triggers pay double.
- **Use `concurrency: cancel-in-progress: true` on PR-triggered workflows** so rapid edits collapse to one surviving run per PR. The Flywheel templates already do this; mirror it for your own workflows.

The first and third rulesets can be applied in one command. **Pass `--app-id` — it's mandatory**, not optional:

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

**Native auto-merge wasn't enabled even though the PR got `flywheel:auto-merge`.** Either the branch doesn't have native auto-merge enabled (check **Settings → General → Pull Requests → Allow auto-merge**), the App lacks **Pull requests: write**, or you're passing a `secrets.GITHUB_TOKEN` somewhere instead of the App credentials (`app-id` / `app-private-key`). `doctor.sh` flags all three. Note: if your repo has no required status checks, the GraphQL `enableAutoMerge` mutation refuses with "Pull request is in clean status" — Flywheel falls through to a direct REST merge, so the PR still merges; the label stays applied.

**Release job failed with `EGITNOPERMISSION` / "denied to github-actions[bot]".** Two distinct causes:
- The branch ruleset doesn't list the App as a bypass actor — re-run `scripts/apply-rulesets.sh <owner/repo> --app-id <id>`.
- `actions/checkout@v4` was invoked without `persist-credentials: false`. The default behavior writes the workflow's GITHUB_TOKEN into git's `extraheader`, which shadows the App token semantic-release embeds in its push URL. Use the workflow YAML in §3 verbatim — the flag is already set.

**Release job failed with `MODULE_NOT_FOUND` for `@semantic-release/changelog` (or similar).** `npx semantic-release@24` alone doesn't auto-resolve plugins from the generated `.releaserc.json`. The §3 YAML co-installs them with `npx -p` flags — copy it verbatim.

**Promotion PR didn't appear after merging to a non-terminal branch.** Either the branch is the terminal (last) branch in its stream — terminal branches release but don't promote — or the pending commits are all non-bumping types (`chore`, `style`, `docs`, `test`, `ci`, `build`, `refactor`). Promotion PRs only open when something with release significance is ready to move forward; the non-bumping commits will be included in the next promotion.

**`semantic-release` ran and said no release was published.** Same root cause: the commits since the last tag are all non-bumping. This is intentional — no tag, no Release, no `build.yml` trigger.

**Tag collision error from `semantic-release`.** Two streams produced the same tag string. Flywheel scopes tags per stream automatically (e.g. `customer-acme/v1.0.1` for non-primary streams), so if you see this, please file an issue with your `.flywheel.yml`.

**PR opened by Flywheel doesn't trigger your quality checks.** Make sure your check workflows include `merge_group:` as well as `pull_request:` — without it, the merge queue stalls waiting for a check that never fires (see the snippet above).
