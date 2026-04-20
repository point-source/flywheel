# swarmflow

Reusable GitHub Actions workflows that turn an adopting repository into an
autonomous release pipeline. Designed for AI-agent-dominant development
where human review gates are triggered by **change type**, not branch
position.

Adopters supply only their build, publish, and (optional) quality workflows
plus a small `.pipeline.yml`. swarmflow handles:

- Conventional-commit parsing and validation
- Semver computation (with `dev`/`rc` pre-releases per branch)
- Changelog generation
- PR title/body rewriting
- Auto-merge for low-risk change types (configurable)
- Branch promotion through `develop → staging → main`
- Tagging, GitHub Release creation, and production build dispatch

## Quick start

1. Install the swarmflow GitHub App on your repo. Store `APP_ID` and
   `APP_PRIVATE_KEY` as repo secrets.
2. Copy `templates/on-pr.yml` and `templates/on-push.yml` into
   `.github/workflows/`.
3. Copy `templates/pipeline.yml.example` to `.pipeline.yml` and adjust the
   `branches` flags. Default is `develop: true` only.
4. Create your `pipeline-build.yml` and `pipeline-publish.yml` from the
   templates. Replace the `# TODO` lines with your real build/publish steps.
5. Apply the rulesets in `docs/RULESETS.md`.

Full instructions in [`docs/ONBOARDING.md`](./docs/ONBOARDING.md).

## What's in this repo

| Path                     | Contents                                              |
|--------------------------|-------------------------------------------------------|
| `.github/workflows/`     | Reusable workflows (orchestrator, pr-lifecycle, promote, release) plus self-CI |
| `.github/actions/`       | Composite actions used by the workflows               |
| `scripts/`               | Bash helpers (`commit-parse.sh`, `version-bump.sh`, etc.) |
| `tests/bats/`            | Bash unit tests                                       |
| `templates/`             | Files adopters copy into their repo                   |
| `docs/`                  | `ONBOARDING.md`, `CONFIG.md`, `RULESETS.md`           |
| `spec.md`                | Source of truth for the design                        |

## Design

The full design is in [`spec.md`](./spec.md). Highlights:

- **Pure YAML + bash + `gh` CLI.** No Node, no `dist/`, no compiled actions.
  Composite actions are used as small wrappers when an inline `run:` block
  would exceed ~30 lines.
- **JIT versioning.** Versions are computed at push time, never at PR-open
  time, so they always reflect what actually landed.
- **Bot identity.** All write actions go through a GitHub App installation
  token. `GITHUB_TOKEN` is intentionally not used because it can't trigger
  downstream workflow runs.

## Running tests locally

```sh
brew install bats-core jq    # macOS
sudo apt install bats jq     # Debian/Ubuntu
bats tests/bats/
```

## License

[MIT](./LICENSE.md).
