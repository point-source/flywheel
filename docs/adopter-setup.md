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
curl -fsSL https://raw.githubusercontent.com/point-source/flywheel/main/scripts/init.sh | bash
```

`init.sh` picks a `.flywheel.yml` preset, writes both adopter workflow files, prompts for your GitHub App credentials, and optionally applies the branch + tag rulesets. Then validate with:

```bash
curl -fsSL https://raw.githubusercontent.com/point-source/flywheel/main/scripts/doctor.sh | bash
```

The rest of this document is the manual walkthrough — useful if you want to understand what `init.sh` writes, or if you're retrofitting an existing setup.

## 1. Create a GitHub App

Flywheel uses a GitHub App installation token. Personal Access Tokens are not supported — they don't reliably propagate the cross-workflow trigger semantics Flywheel relies on (in particular, native auto-merge enable and downstream workflow firing on bot-created PRs).

**Fastest path: let `init.sh` do it.** The quick-start command (§Quick start) opens a browser to GitHub's App-creation page pre-populated with the required permissions, captures the credentials on a localhost callback, and writes them as repo secrets — about 30 seconds end to end. The only remaining manual step is clicking "Install" on the resulting App page to scope it to your repo. If that's all you need, skip the rest of this section.

If you'd rather create the App by hand: follow GitHub's [Creating a GitHub App](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/creating-a-github-app) guide with these permissions:

- **Contents: read and write** — tag creation, `.releaserc.json` write
- **Pull requests: read and write** — PR creation, body updates, auto-merge
- **Issues: read and write** — adding / removing the `flywheel:*` labels on PRs
- **Checks: read and write** — posting the `flywheel/conventional-commit` check
- **Metadata: read**

Install the App on your repo. Then store its credentials as repo secrets:

- `FLYWHEEL_GH_APP_ID` — the numeric App ID (visible on the App's settings page).
- `FLYWHEEL_GH_APP_PRIVATE_KEY` — the PEM-format private key downloaded from the App settings.

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

Both files reference `point-source/flywheel@v2` — a floating major tag that picks up bug-fix and feature releases automatically. Pin to an exact version like `point-source/flywheel@v2.0.0` if you need fully reproducible runs.

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
      - uses: actions/checkout@v6
      - uses: point-source/flywheel@v2
        with:
          event: pull_request
          app-id: ${{ secrets.FLYWHEEL_GH_APP_ID }}
          app-private-key: ${{ secrets.FLYWHEEL_GH_APP_PRIVATE_KEY }}
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
      - name: Back-merge release into upstream branches
        # When a release lands on a non-head branch (e.g. main in a develop →
        # staging → main stream), back-merge the new tag and chore(release)
        # commit into each upstream branch so semantic-release on those
        # branches sees the tag in its ancestry. Single-branch streams skip
        # this step (back_merge_targets is empty).
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
              git merge --no-ff -m "chore: back-merge $new_tag from $RELEASED_BRANCH into $upstream [skip ci]" "$RELEASED_BRANCH"
            fi
            git push origin "$upstream"
          done
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
      - uses: actions/checkout@v6
      - name: Build
        run: ./your-build-script.sh
        env:
          VERSION: ${{ github.event.release.tag_name }}
          CHANGELOG: ${{ github.event.release.body }}
      - uses: actions/create-github-app-token@v1
        id: app-token
        with:
          app-id: ${{ secrets.FLYWHEEL_GH_APP_ID }}
          private-key: ${{ secrets.FLYWHEEL_GH_APP_PRIVATE_KEY }}
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

A copy-paste starter ships at [`scripts/templates/quality.yml`](https://github.com/point-source/flywheel/blob/v1/scripts/templates/quality.yml) — fetch it directly into your repo:

```bash
mkdir -p .github/workflows
curl -fsSL https://raw.githubusercontent.com/point-source/flywheel/main/scripts/templates/quality.yml \
  -o .github/workflows/quality.yml
# then edit the run line to call your real test command
```

Or write it inline:

```yaml
name: Quality
on:
  pull_request:
  merge_group:    # required for merge queue compatibility
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - run: ./your-test-script.sh
```

### Recommended rulesets

1. **Protect managed branches** — target every branch listed in `.flywheel.yml`. Require PRs, require status checks (your quality check names), block force push, block deletion, require linear history. **Bypass actor: your Flywheel GitHub App, in `bypass_mode: always` — required on every managed branch.** Without this, two pushes get rejected: `semantic-release`'s version commit + tag (PR-only rule → `EGITNOPERMISSION`) and the back-merge merge commit into upstream branches (linear-history rule). `scripts/apply-rulesets.sh --app-id <id>` configures this for the whole ruleset.
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

(Or via `curl -fsSL https://raw.githubusercontent.com/point-source/flywheel/main/scripts/apply-rulesets.sh | bash -s -- <owner/repo>` if you don't have the Flywheel repo checked out.)

## 6. Brief your AI coding agents

Skip this section if no AI agents (Claude Code, Cursor, Copilot, Codex, internal swarms) open PRs in this repo.

If they do, they will produce more compliant PRs if you tell them about Flywheel's rules in their instruction file — typically `CLAUDE.md`, `AGENTS.md`, or `.cursorrules` at the repo root. Without this, agents reliably invent branch names, write free-form PR titles, target the wrong branch, or try to mint their own version tags — and Flywheel dutifully labels every one of those PRs `flywheel:needs-review` until a human untangles it. With dozens or hundreds of concurrent agent-driven PRs, those wasted round-trips also burn GitHub Actions minutes (see [§5 Cost control under high PR volume](#cost-control-under-high-pr-volume)).

Paste the snippet below into your agent instruction file (rename / reformat as your tool expects). The bracketed placeholders split into two groups — three are mechanically derivable from `.flywheel.yml`, two require values that live outside Flywheel's config:

| Placeholder | Source | How to fill it in |
| --- | --- | --- |
| `<DEFAULT_TARGET_BRANCH>` | `.flywheel.yml` | The first branch in the first stream — the entry point of your main-line. In a single-branch config it's just that branch. |
| `<list other managed branches>` | `.flywheel.yml` | Every `branches[].name` across all streams, **excluding** `<DEFAULT_TARGET_BRANCH>`. May be empty for a single-branch single-stream config. |
| `<copy auto_merge list from .flywheel.yml>` | `.flywheel.yml` | The `auto_merge` array for the branch you used as `<DEFAULT_TARGET_BRANCH>`. Copy verbatim, including any `!` variants. |
| `<list required check names>` | repo ruleset | The status checks marked required on your default target branch (e.g. `Quality`). These come from §5 — they aren't in `.flywheel.yml`. |
| `<local commands>` | your `quality.yml` | The local equivalent of whatever `quality.yml` runs in CI (e.g. `npm test`, `pytest`, `./scripts/ci.sh`). |

> **If you are an AI agent reading this doc to configure yourself:** the first three rows above are deterministic — derive them yourself by reading `.flywheel.yml` from the repo root. For the last two, ask the human adopter; they depend on repo configuration outside Flywheel's control.

````markdown
## How this repo handles PRs (Flywheel)

This repo uses [Flywheel](https://github.com/point-source/flywheel) to orchestrate PRs and releases. Read these rules before opening a PR — non-compliant PRs get labeled `flywheel:needs-review` and stall.

**Target branch.** Open all PRs against `<DEFAULT_TARGET_BRANCH>` unless explicitly asked otherwise. Do **not** PR directly into other managed branches (`<list other managed branches>`) — Flywheel manages branch-to-branch promotion automatically via bot-authored promotion PRs.

**PR title format.** Must be a [Conventional Commit](https://www.conventionalcommits.org/): `<type>(<optional scope>): <description>`. Recognized types: `feat`, `fix`, `chore`, `refactor`, `perf`, `style`, `test`, `docs`, `build`, `ci`, `revert`. Append `!` for breaking changes (e.g. `feat!: rename foo to bar`). Flywheel will rewrite a malformed title, but getting it right first time avoids re-runs.

**One logical change per PR.** Flywheel derives the version bump from the title, so squashing two unrelated `feat`s into one PR loses one of them in the release notes.

**Branch naming.** Use `<type>/<short-kebab-description>` (e.g. `feat/login-rate-limit`, `fix/null-deref-on-empty-list`). Some repos enforce this via ruleset; pushes that don't match are rejected.

**Auto-merge eligibility on `<DEFAULT_TARGET_BRANCH>`.** PRs whose title type is in `[<copy auto_merge list from .flywheel.yml>]` get labeled `flywheel:auto-merge` and enter the merge queue automatically once required checks pass. Any other type — including `feat!` when only `feat` is listed — routes to human review and waits for an approval.

**Required status checks.** Your PR must pass `<list required check names>` before merging. Run them locally before pushing (`<local commands>`) — every re-push to fix a failing required check costs CI minutes.

**Things you must not do:**
- Do not push to or force-push managed branches (`<list>`); they are protected.
- Do not create version tags (`v1.2.3`, etc.) or any tag matching the project's release namespace. Only Flywheel's GitHub App may mint them.
- Do not edit a PR's title or body after Flywheel has rewritten them — push a new commit with the corrected conventional-commit message instead.
- Do not open promotion PRs by hand. If a promotion PR is missing or stale, the upstream merge probably hasn't landed yet.

**If your PR was labeled `flywheel:needs-review` and you expected `flywheel:auto-merge`:** the title's commit type is not in the target branch's `auto_merge` list, or you used a breaking variant (`feat!`) when only the non-breaking variant (`feat`) is allowed. Check `.flywheel.yml`.
````

Worked example using the three-stage promotion config from §2 (`develop` → `staging` → `main`), with `Quality` registered as the required check:

- `<DEFAULT_TARGET_BRANCH>` → `develop` (first branch of the only stream)
- `<list other managed branches>` → `staging, main`
- `<copy auto_merge list from .flywheel.yml>` → `fix, fix!, feat, chore, refactor, perf, style, test, docs`
- `<list required check names>` → `Quality`
- `<local commands>` → `npm test && npm run lint` (whatever your `quality.yml` runs)

If your repo already has a `CLAUDE.md` or equivalent, append the snippet under a new section heading rather than replacing existing content — the instructions are additive and don't conflict with typical "how to navigate this codebase" guidance.

## 7. Verify

Run the doctor script — it validates everything the prior steps configured without needing a real PR:

```bash
curl -fsSL https://raw.githubusercontent.com/point-source/flywheel/main/scripts/doctor.sh | bash
```

`doctor.sh` confirms `.flywheel.yml` parses, every managed branch exists, `FLYWHEEL_GH_APP_ID` + `FLYWHEEL_GH_APP_PRIVATE_KEY` are set, `Allow auto-merge` is on, both Flywheel workflow files exist with App-token plumbing, a ruleset covers each managed branch, and the `v*` tag namespace is protected. Anything red is annotated with the script you should run to fix it.

Then open a small PR titled `chore: smoke test`. Confirm:

- The PR title and body get rewritten.
- A `flywheel:auto-merge` or `flywheel:needs-review` label is applied.
- Native auto-merge is enabled (if eligible).

Merge the PR. On the resulting push, confirm:

- A new tag is cut (e.g. `v0.1.1-dev.1`).
- A GitHub Release is published.
- Your `build.yml` fires.

## 8. Troubleshooting

**PR title wasn't rewritten.** Open the `Flywheel — PR` workflow run and look at the `conduct` job log. Common causes: the PR is still a draft (`flywheel-pr.yml` skips drafts), the target branch isn't listed in any stream in `.flywheel.yml`, or the title isn't a recognized Conventional Commit type.

**Got `flywheel:needs-review` but expected `flywheel:auto-merge`.** Compare the PR's commit type (with `!` if breaking) against the target branch's `auto_merge` list. `fix!` only matches if `fix!` is listed explicitly — listing `fix` doesn't imply `fix!`.

**Native auto-merge wasn't enabled even though the PR got `flywheel:auto-merge`.** Either the branch doesn't have native auto-merge enabled (check **Settings → General → Pull Requests → Allow auto-merge**), the App lacks **Pull requests: write**, or you're passing a `secrets.GITHUB_TOKEN` somewhere instead of the App credentials (`app-id` / `app-private-key`). `doctor.sh` flags all three. Note: if your repo has no required status checks, the GraphQL `enableAutoMerge` mutation refuses with "Pull request is in clean status" — Flywheel falls through to a direct REST merge, so the PR still merges; the label stays applied.

**Release job failed with `EGITNOPERMISSION` / "denied to github-actions[bot]".** Two distinct causes:
- The branch ruleset doesn't list the App as a bypass actor — re-run `scripts/apply-rulesets.sh <owner/repo> --app-id <id>`.
- `actions/checkout@v6` was invoked without `persist-credentials: false`. The default behavior writes the workflow's GITHUB_TOKEN into git's `extraheader`, which shadows the App token semantic-release embeds in its push URL. Use the workflow YAML in §3 verbatim — the flag is already set.

**Release job failed with `MODULE_NOT_FOUND` for `@semantic-release/changelog` (or similar).** `npx semantic-release@24` alone doesn't auto-resolve plugins from the generated `.releaserc.json`. The §3 YAML co-installs them with `npx -p` flags — copy it verbatim.

**Promotion PR didn't appear after merging to a non-terminal branch.** Either the branch is the terminal (last) branch in its stream — terminal branches release but don't promote — or the pending commits are all non-bumping types (`chore`, `style`, `docs`, `test`, `ci`, `build`, `refactor`). Promotion PRs only open when something with release significance is ready to move forward; the non-bumping commits will be included in the next promotion.

**`semantic-release` ran and said no release was published.** Same root cause: the commits since the last tag are all non-bumping. This is intentional — no tag, no Release, no `build.yml` trigger.

**Tag collision error from `semantic-release`.** Two streams produced the same tag string. Flywheel scopes tags per stream automatically (e.g. `customer-acme/v1.0.1` for non-primary streams), so if you see this, please file an issue with your `.flywheel.yml`.

**PR opened by Flywheel doesn't trigger your quality checks.** Make sure your check workflows include `merge_group:` as well as `pull_request:` — without it, the merge queue stalls waiting for a check that never fires (see the snippet above).

**Back-merge step failed pushing to an upstream branch.** Two common causes:
- The App isn't a bypass actor on the upstream branch's ruleset, so its merge commit is rejected by the linear-history rule. Re-run `scripts/apply-rulesets.sh <owner/repo> --app-id <id>` — it covers every managed branch in one go.
- The merge has conflicts (the upstream branch and the released branch both modified the same file in incompatible ways). The step fails loudly with `git merge` output. Resolve manually by opening a PR from the released branch into the upstream branch, fix the conflict, merge it, and re-run the failed step or trigger the next release.
