# Maintainer setup

This file documents the one-time steps required to operate the Flywheel repository itself.

## Required secrets

Flywheel uses a GitHub App installation token. Personal Access Tokens are not supported.

- `FLYWHEEL_GH_APP_ID` — numeric ID of the GitHub App installed on this repo.
- `FLYWHEEL_GH_APP_PRIVATE_KEY` — PEM-format private key for that App.

The App needs:

- **Contents: read and write** (tag creation, `.releaserc.json` write)
- **Pull requests: read and write** (PR creation, body updates, auto-merge)
- **Issues: read and write** (label add/remove on PRs)
- **Checks: read and write** (posting the `flywheel/conventional-commit` check)
- **Metadata: read**

Each workflow mints a short-lived installation token via [`actions/create-github-app-token`](https://github.com/actions/create-github-app-token); see the templates in `scripts/templates/`.

`GITHUB_TOKEN` is insufficient for the dogfooded self-adoption case — it cannot trigger downstream workflows from PRs it creates.

## Branch protection rulesets

Flywheel protects its own `main` branch with the four rulesets from spec §Branch protection.

### Ruleset 1 — Protect `main`
- Target: `main`
- Require pull request before merging
- Require status checks: `verify`, plus any future quality checks
- Block force pushes
- Block deletions
- Require linear history (incompatible with merge commits — squash only)
- Bypass actor: the Flywheel GitHub App only

### Ruleset 2 — Merge queue on `main`
- Group size 1 (strict)
- Required for the action repo since each merge triggers a release

### Ruleset 3 — Protect `v*` tag namespace
- Only the bot may create or delete tags matching `v*`
- Prevents accidental or malicious version-tag minting

### Ruleset 4 — Branch naming (optional)
- Require feature branches to match `(feat|fix|chore|refactor|perf|style|test|docs|build|ci|revert)/.*`

## Quality check workflows

The `verify-dist` workflow (see `.github/workflows/verify-dist.yml`) runs typecheck + tests + bundle-drift detection on every PR and push. It must remain a required status check.

When adding new quality check workflows, include **both** triggers:

```yaml
on:
  pull_request:
  merge_group:
```

Without `merge_group`, the merge queue stalls waiting for a check that never fires.

## Bootstrap order for self-adoption

The action references itself once published. Until the first release, workflows use `uses: ./` (local checkout). The flip:

1. Land Phase 5 with workflows still on `uses: ./`.
2. Open `rewrite/flywheel → main` PR. Merge.
3. semantic-release fires on the push to `main` and cuts `v1.0.0`. GitHub Release published.
4. Manually move the floating `v1` tag to that commit (Phase 6's `release-major-tag.yml` automates this going forward).
5. Open a follow-up PR flipping `flywheel-pr.yml` and `flywheel-push.yml` from `uses: ./` to `uses: point-source/flywheel@v1`. From here on, flywheel consumes itself from the marketplace.

## Marketplace listing

After the first release, list the action on the GitHub Actions marketplace via the GitHub UI on the v1.0.0 release page. Required: `action.yml` with `name`, `description`, and `branding` (already present).
