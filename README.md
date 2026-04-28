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

| Path                  | Contents                                                                |
|-----------------------|-------------------------------------------------------------------------|
| `action.yml`          | Root action — single `node20` entry, dispatches on the `command` input  |
| `src/`                | TypeScript source (commands, core modules, GitHub adapters)             |
| `dist/`               | `ncc`-bundled action (`dist/index.js`); committed, regenerated on build |
| `.github/workflows/`  | Reusable workflows (orchestrator, pr-lifecycle, promote, release) + CI  |
| `templates/`          | Files adopters copy into their repo                                     |
| `scripts/e2e/`        | E2e harness helpers (internal, not adopter-facing)                      |
| `docs/`               | `ONBOARDING.md`, `CONFIG.md`, `RULESETS.md`, `E2E.md`, `adr/`           |
| `spec.md`             | Source of truth for the design                                          |

## Design

The full design is in [`spec.md`](./spec.md). The TypeScript-rewrite rationale
is in [`docs/adr/0001-typescript-rewrite.md`](./docs/adr/0001-typescript-rewrite.md).
Highlights:

- **Single bundled action.** All logic lives in `dist/index.js`; reusable
  workflows are thin (~25 lines each) and do `actions/checkout@v4` of
  swarmflow at the pinned ref + one `uses: ./.swarmflow` step. This avoids
  the cross-repo composite-resolution problem that defeated the bash
  prototype (see ADR for details).
- **JIT versioning.** Versions are computed at push time, never at PR-open
  time, so they always reflect what actually landed.
- **Bot identity.** All write actions go through a GitHub App installation
  token. `GITHUB_TOKEN` is intentionally not used because it can't trigger
  downstream workflow runs.

## Running tests locally

```sh
npm install
npm test          # vitest, ~120 unit tests including all 12 hard-won learnings
npm run build     # ncc bundle; dist/ must be committed
npm run lint      # eslint
```

## License

[MIT](./LICENSE.md).
