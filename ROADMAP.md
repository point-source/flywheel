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

## Release CI budget

### §road:classify-dogfood

Gate flywheel's own `push`-triggered quality workflows on
`derived_release_commit` — adding the `point-source/flywheel/classify`
composite step to `.github/workflows/integration.yml` and `verify-dist.yml`
alongside their existing `dorny/paths-filter` step, and a preceding
`classify` job feeding `governance-lint.yml` via `needs:` — switch
`scripts/templates/quality.yml` to invoke the composite while preserving the
inline `startsWith` form as a documented fallback comment, and document the
stable public-surface guarantee for the commit-message prefixes and
`: promote ` PR title in `CONTRIBUTING.md`. Coordinate with
§road:composite-action-adoption, which also rewrites these workflow files and
`quality.yml` — sequence after it or rebase to avoid conflicts. Implements
§spec:release-ci-budget.

**Verify:** On a scratch branch, add `uses: point-source/flywheel/classify@<ref>`
as a step in a throwaway workflow and push two commits: one ordinary, one
authored as `github-actions[bot]` with a `chore(release): 9.9.9` message.
Confirm the step's `derived_release_commit` output is `'false'` then `'true'`,
and `promotion_pr` is `'false'` on both. Then on `point-source/flywheel`,
push a synthetic `github-actions[bot]` commit whose message begins
`chore: back-merge ` and confirm `integration.yml`, `verify-dist.yml`, and
`governance-lint.yml` each report their required-check name as a successful
no-op (heavy steps skipped), while an ordinary push still runs the full
suite. The end-to-end real-world confirmation is the next vX.Y.Z release:
the `chore(release):` and `chore: back-merge` pushes it generates produce one
green fan-out per workflow without running the heavy steps, versus the prior
two-to-three.
