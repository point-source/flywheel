# `.pipeline.yml` reference

The pipeline reads `.pipeline.yml` at the root of the adopting repo on every
invocation. Changes take effect on the next PR or push without modifying any
workflow files.

```yaml
pipeline:
  branches:
    develop: <bool>          # default: true
    staging: <bool>          # default: false
    main:    <bool>          # default: false

  merge_strategy: <enum>     # squash | merge | rebase. default: squash
  merge_queue:    <enum>     # auto | true | false.    default: auto

  auto_merge_types:          # default: [fix, chore, refactor, perf, style, test]
    - <conventional commit type>

  publish_on_develop: <bool> # default: true
  publish_on_staging: <bool> # default: true

  workflows:
    build:   <path>          # default: pipeline-build.yml
    publish: <path>          # default: pipeline-publish.yml
    quality: <path>          # default: '' (skip quality gate)

initial_version: <semver>    # default: 0.1.0
```

## Field semantics

### `branches.{develop, staging, main}`

Whether each branch is part of the active promotion chain. The chain order is
fixed (`develop → staging → main`); these flags determine which branches
participate.

Adopters typically grow this over time:

- Day 1: `develop: true` only — preview/pre-release builds, no production.
- Day N: enable `main: true` — promotion PRs from develop to main start
  appearing automatically.
- Later: insert `staging: true` for an RC validation gate.

### `merge_strategy`

How auto-merged PRs land on the target branch. `squash` is recommended (and
the default) because it produces one conventional commit per PR, which is
exactly what version computation expects.

### `merge_queue`

When the target branch has GitHub's native merge queue enabled, the pipeline
should enqueue PRs rather than merging them directly.

- `auto` (default) — query the branch's ruleset configuration at runtime.
  Works correctly when the queue is added or removed without redeploy.
- `true` — always enqueue (override auto-detection).
- `false` — always merge directly (override auto-detection).

### `auto_merge_types`

Conventional-commit types that auto-merge without human review (provided
quality checks pass). The default list is `[fix, chore, refactor, perf, style,
test]`. `feat` is intentionally NOT in the default list — features are the
human-review gate.

**Breaking-change override:** any commit with a `!` suffix or a
`BREAKING CHANGE:` footer ALWAYS requires human review, regardless of this
list. This is not configurable.

### `publish_on_develop` / `publish_on_staging`

Whether to dispatch the build/publish chain on every push to that branch. Set
to `false` if you want pre-release versioning but no actual artifact upload
on lower environments.

`main` always publishes — there's no `publish_on_main` flag.

### `workflows.{build, publish, quality}`

Paths (relative to `.github/workflows/`) of the adopter-supplied workflows.
Override these only if you need to avoid filename collisions with existing
workflows. `quality` defaults to empty string, which means "no quality gate" —
the pipeline will not attempt to dispatch a quality workflow.

### `initial_version`

The fallback version when no `v*` tags exist in the repo. The version
computation logic adds bumps on top of this. Use a `0.x` version if you want
pre-1.0 semantics where breaking changes don't auto-bump major.

## Quality workflow contract

If `workflows.quality` is set, the pipeline dispatches that workflow via
`workflow_dispatch` with these inputs:

| Input        | Type    | Notes                                        |
|--------------|---------|----------------------------------------------|
| `pr_number`  | string  | The PR being checked                         |
| `sha`        | string  | The PR head commit                           |

The pipeline waits up to 5 minutes for the run to complete and passes/fails
based on the run's `conclusion`.

## Build/publish workflow contract

| Input           | Required | Notes                                       |
|-----------------|----------|---------------------------------------------|
| `version`       | yes      | Full semver (e.g. `1.2.0-dev.3` or `1.2.0`) |
| `environment`   | yes      | `develop` \| `staging` \| `production`      |
| `changelog`     | yes      | Markdown changelog fragment                 |
| `artifact_path` | no       | Defaults to `dist/`                         |

The publish workflow MUST accept the same four inputs. The build workflow is
expected to dispatch the publish workflow on success — see
`templates/pipeline-build.yml.example` for the pattern.
