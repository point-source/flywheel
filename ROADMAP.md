# flywheel — Roadmap

## Composite-action distribution

### §road:composite-action-core

Restructure the root `action.yml` into a composite action that checks out
the adopter repository, runs the dispatch logic as a nested `core/`
JavaScript action, and on push events runs `semantic-release` and the
`github.action_path`-located release scripts — dropping the `scripts_dir`
output — across `action.yml`, `core/`, the esbuild/`verify-dist` build
pipeline, and the affected unit tests. Implements §spec:action-version-lockstep.

### §road:composite-action-adoption

Migrate the adopter surface to the composite action — rewriting
`scripts/templates/flywheel-pr.yml`/`flywheel-push.yml` and flywheel's own
dogfood workflows to the `runs-on`/`steps` `uses: point-source/flywheel@<ref>`
form, updating `scripts/init.sh` and the `tests/e2e` fixtures, deleting the
`.github/workflows/pr.yml` and `push.yml` reusable workflows, retiring
`tests/workflow-template-parity.test.ts`, and revising `README.md`,
`docs/adopter/setup.md`, and `docs/maintainer/release-process.md` for the
breaking v2 migration. Depends on §road:composite-action-core. Implements
§spec:action-version-lockstep.

**Verify:** Run the updated `scripts/init.sh`; the generated callers use
`runs-on`/`steps` with `uses: point-source/flywheel@<ver>` and no longer
reference `pr.yml`/`push.yml`. In an adopter repo on those callers, open and
merge a PR from a non-default branch — flywheel runs on `pull_request` and
`push`, executing the action and `scripts/` from the pinned ref, and
`.github/workflows/pr.yml`/`push.yml` are absent from `point-source/flywheel`.
Re-scaffold pinned at an exact `@vX.Y.Z` and confirm every flywheel file runs
at that version.

## Per-branch release_as_draft

### §road:per-branch-release-as-draft

Move `release_as_draft` from a repo-wide top-level boolean to a per-branch
boolean valid on `release: prerelease` and `release: production` branches —
across `src/types.ts` (field migrates from `FlywheelConfig` to `Branch`),
`src/config.ts` (per-branch parse, non-boolean error, rejection on
`release: none` branches, top-level rejection error naming the per-branch
replacement and the release branches that would need it), `src/release-rc.ts`
(branch-targeted lookup in `generateReleaseRc`), `scripts/lint-flywheel-config.py`
(parallel Python validator), `test-fixtures/flywheel.release-as-draft.yml`
(moved to per-branch) plus new fixtures for the top-level rejection and the
`release: none` rejection, `tests/config.test.ts`, `tests/release-rc.test.ts`,
`tests/e2e/scenarios/11-release-as-draft.test.ts` (splice under the target
branch, not at `flywheel:` top level), `docs/adopter/setup.md` (rewrite the
"Variant: immutable releases" section for per-branch and mixed-mode), and a
refreshed `dist/index.cjs`. Implements §spec:immutable-release-support.

**Verify:** In an adopter repo on a development build of flywheel, set
`release_as_draft: true` under only the `main` branch in `.flywheel.yml`
(leave `develop` unset). Merge a `feat:` change into `develop` and confirm
the resulting `vX.Y.Z-dev.N` release publishes immediately (no draft badge
in the Releases list, `release: published` event fires). Merge `develop →
main` and confirm the resulting `vX.Y.Z` release exists as an unpublished
draft (Draft badge visible, `release: published` event not fired, tag
created). Move `release_as_draft: true` from under `main` to the top level
under `flywheel:` and re-run flywheel — the run halts with a configuration
error naming the per-branch replacement and listing every release branch
in the file. Re-run `npx vitest run tests/docs-examples.test.ts` after the
`docs/adopter/setup.md` rewrite to confirm every embedded `flywheel:` YAML
block still parses through `loadConfig`.
