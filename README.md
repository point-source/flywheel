# Flywheel

> GitHub Actions-native CI/CD orchestration for teams and AI agent swarms.

Flywheel is a lightweight orchestration layer that automates the journey from a conventional commit to a versioned release artifact — without prescribing how you build, what you publish, or how your branches relate to each other.

It is **not** a long-running orchestrator. It is a collection of short-lived, single-purpose event reactions. The repository itself — its branches, tags, PRs, and labels — is the state machine.

## What it does

- Parses every PR title as a conventional commit. Rewrites the title and body. Applies one of two labels: `flywheel:auto-merge` or `flywheel:needs-review` based on the rules in your `.flywheel.yml`.
- Enables GitHub native auto-merge into the merge queue when eligible.
- On every push to a managed branch, generates `.releaserc.json` and gates a separate `semantic-release` step that computes the version, tags, and creates a GitHub Release.
- On every push to a non-terminal branch in a stream, upserts a single open promotion PR to the next branch in the stream.

Build and publish steps are **not** owned by Flywheel — they are workflows you write that react to the `release: published` and `workflow_run: [Build] completed` events Flywheel produces. A 30-minute mobile build incurs no waiting cost on the Flywheel pipeline side.

## Quick start

Add four files to your repo:

```
your-repo/
├── .flywheel.yml                    ← you write this
└── .github/workflows/
    ├── flywheel-pr.yml              ← copy from docs/adopter-setup.md
    ├── flywheel-push.yml            ← copy from docs/adopter-setup.md
    ├── build.yml                    ← you write: on: release published
    └── publish.yml                  ← you write: on: workflow_run
```

A minimal `.flywheel.yml`:

```yaml
flywheel:
  streams:
    - name: main-line
      branches:
        - name: develop
          prerelease: dev
          auto_merge: [fix, chore, refactor, perf, style, test, docs]
        - name: main
          auto_merge: []
  merge_strategy: squash
  initial_version: 0.1.0
```

See **[docs/adopter-setup.md](./docs/adopter-setup.md)** for the full setup walkthrough including the workflow templates, branch protection rulesets, and required secret scopes.

## How it works

```
agent / developer pushes a branch
        │
        ▼
PR opened against a managed branch
        │
        ▼
flywheel-pr workflow → pr-conductor:
  ├── parse + rewrite title/body
  ├── compute increment (major / minor / patch / none)
  ├── apply flywheel:auto-merge XOR flywheel:needs-review
  └── enable native auto-merge if eligible
        │
        ▼
PR merges → push to managed branch
        │
        ├──────────────────────────────────┐
        ▼                                  ▼
flywheel-push.yml              flywheel-push.yml
(release flow)                 (promotion flow)
  ├── write .releaserc.json      ├── compute pending commits (commit-message-based)
  ├── npx semantic-release       ├── upsert promotion PR to next branch in stream
  ├── tag + GitHub Release       └── label + enable auto-merge if eligible
        │
        ▼
release: published
  └── your build.yml fires
        │
        ▼
workflow_run: build completed
  └── your publish.yml fires
```

## Design properties

- **Stateless and event-driven.** No workflow waits for another. Each workflow reacts to one event, does one job, and exits.
- **No double billing.** Build and publish workflows are triggered by events Flywheel produces, not called synchronously.
- **Language and destination agnostic.** Flywheel produces a version, a changelog, and a tag. What you do with those is up to your build/publish workflows.
- **No assumed branch hierarchy.** Branch relationships are defined by stream membership in `.flywheel.yml`. A project with one stream containing one branch and a project with six parallel streams use the same system.
- **Version numbers are stream-scoped.** Within a stream, the base version is consistent across branches — `v1.3.0-dev.2`, `v1.3.0-rc.1`, and `v1.3.0` all represent the same logical release.
- **One config file.** `.flywheel.yml` is the single source of truth. Flywheel derives semantic-release config from it at runtime; adopters never configure `.releaserc.json` directly.

## Permissions

Flywheel needs a token with:

| Scope          | Purpose                                                        |
| -------------- | -------------------------------------------------------------- |
| Contents: r/w  | Tag creation, `.releaserc.json` write to workspace             |
| Pull req: r/w  | PR creation, body / label updates, native auto-merge enabling  |
| Metadata: read | Required for any token interacting with a repo                 |

Use `secrets.GH_PAT` (a Personal Access Token) or a GitHub App installation token. The default `secrets.GITHUB_TOKEN` works for most cases but cannot trigger downstream workflows from PRs it creates.

## Inputs and outputs

| Input    | Required | Description                                            |
| -------- | -------- | ------------------------------------------------------ |
| `event`  | yes      | `pull_request` or `push`                               |
| `token`  | yes      | A token with the scopes above                          |

| Output           | Description                                                              |
| ---------------- | ------------------------------------------------------------------------ |
| `managed_branch` | `'true'` if the pushed/targeted branch is in a stream; `'false'` otherwise |

## Conventional commit types

Flywheel recognizes the standard conventional commit types: `feat`, `fix`, `chore`, `refactor`, `perf`, `style`, `test`, `docs`, `build`, `ci`, `revert`. Append `!` to indicate a breaking change. The `BREAKING CHANGE:` and `BREAKING-CHANGE:` footers in commit bodies are also detected.

| Commit                                                          | Increment |
| --------------------------------------------------------------- | --------- |
| Any type with `!` or `BREAKING CHANGE:` footer                  | major     |
| `feat`                                                          | minor     |
| `fix`, `perf`                                                   | patch     |
| `chore`, `refactor`, `style`, `test`, `docs`, `build`, `ci`     | none      |

Non-bumping commits accumulate silently until a qualifying commit lands.

## Validation

Flywheel validates `.flywheel.yml` on every run. Validation errors fail the action with a descriptive check and post a failing status. Notable rules:

- A branch may belong to only one stream.
- Only the last branch in a stream may be a production release branch.
- Only one stream may produce the primary `v${version}` tag namespace; all other streams use a stream-prefixed tag format.
- `auto_merge` entries must be recognized conventional commit types (with optional `!`).

See [spec.md §Validation](./spec.md#validation) for the full list.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm run verify-dist   # rebuilds and fails if dist/ drifts from source
```

Source is TypeScript under `src/`; the bundled `dist/index.js` is committed and is what GitHub executes. The `verify-dist` workflow ensures the bundle stays in sync.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full contributor workflow, sandbox testing, and PR conventions.

## License

MIT — see [LICENSE.md](./LICENSE.md).

## Related docs

- **[spec.md](./spec.md)** — full specification
- **[docs/adopter-setup.md](./docs/adopter-setup.md)** — adopter walkthrough
- **[CONTRIBUTING.md](./CONTRIBUTING.md)** — contributor and sandbox-testing guide
- **[docs/maintainer-setup.md](./docs/maintainer-setup.md)** — operating Flywheel itself
- **[docs/maintainer-release-process.md](./docs/maintainer-release-process.md)** — cutting a Flywheel release
