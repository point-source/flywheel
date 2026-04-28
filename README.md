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

> **Status:** the TypeScript rewrite has not been tagged `v1` yet. Until
> it is, the workflow templates' `@v1` ref will not resolve. Track
> [ADR-0001](./docs/adr/0001-typescript-rewrite.md) for context, and pin
> to a stable branch or SHA in the meantime.

## Quick start

1. Install the swarmflow GitHub App on your repo (the easiest path is
   `docs/install-app/index.html` — open it from a checkout to use the
   one-click manifest installer). Store `APP_ID` and `APP_PRIVATE_KEY`
   as repo secrets.
2. Copy `templates/on-pr.yml` and `templates/on-push.yml` into
   `.github/workflows/` **verbatim** — these files are identical across
   adopters and should not be edited.
3. Copy `templates/pipeline.yml.example` to `.pipeline.yml` and adjust the
   `branches` flags. Default is `develop: true` only.
4. Create your `pipeline-build.yml` and `pipeline-publish.yml` from the
   templates. Replace the `# TODO` lines with your real build/publish steps.
5. Apply the rulesets — easiest via the helper script:
   `./scripts/setup-rulesets.sh --repo <owner>/<repo> --app-id <numeric-app-id>`.
   See [`docs/RULESETS.md`](./docs/RULESETS.md) for manual setup.

Full instructions in [`docs/ONBOARDING.md`](./docs/ONBOARDING.md).

## What's in this repo

| Path                  | Contents                                                                |
|-----------------------|-------------------------------------------------------------------------|
| `action.yml`          | Root action — single `node20` entry, dispatches on the `command` input  |
| `src/`                | TypeScript source (commands, core modules, GitHub adapters)             |
| `dist/`               | `ncc`-bundled action (`dist/index.js`); committed, regenerated on build |
| `.github/workflows/`  | Reusable orchestrator (dispatches pr-lifecycle/promote/release internally) + CI + e2e |
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
npm test          # vitest unit tests, encoding the bash-prototype learnings catalogued in ADR-0001
npm run build     # ncc bundle; dist/ must be committed
npm run lint      # eslint
```

## License

[MIT](./LICENSE.md).
