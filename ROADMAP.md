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

## Sandbox test budget

### §road:e2e-polling-discipline

Raise the default `intervalMs` in `tests/e2e/helpers/poll-until.ts` to a
value high enough that no scenario exceeds its share of the shared
sandbox installation's per-run API budget, and audit existing call sites
in `tests/e2e/scenarios/` and `tests/e2e/helpers/` for any assertion whose
correctness depends on a fast default — those receive an explicit
`intervalMs` override at the call site rather than relying on the default.
Implements §spec:sandbox-test-budget.

### §road:doc-only-path-filter

Add an in-job `dorny/paths-filter` early-exit to
`.github/workflows/integration.yml` and `.github/workflows/verify-dist.yml`
so documentation-only changes (files under `docs/`, `*.md` at the
repository root, and `.github/ISSUE_TEMPLATE/`) skip the sandbox-driven
test step and the bundle rebuild step respectively while continuing to
report each workflow's existing check name as a successful no-op, keeping
required-check rules satisfied. Implements §spec:sandbox-test-budget.

**Verify:** Open a PR whose only change is `README.md` (or a file under
`docs/`). Both the `Integration tests` and `Verify dist` checks report
success, and neither workflow's logs show a sandbox installation token
mint or a bundle rebuild step running to completion. Open a separate PR
that modifies `src/`, `scripts/`, or a non-documentation workflow file;
both checks run their full pipelines unchanged. Trigger
`workflow_dispatch` on `e2e.yml` against `develop` after
§road:e2e-polling-discipline merges; the suite still passes against
`point-source/flywheel-sandbox`, and the run consumes materially fewer
API requests than a baseline `git show <pre-change>:tests/e2e/helpers/poll-until.ts`
default would have permitted. Installation separation remains a contingent
follow-up — only opened if a subsequent typical development week still
produces rate-limit-induced failures on the sandbox.

## Release gate

### §road:release-gate

Set `release_as_draft: true` on the `main` branch in `.flywheel.yml` and
add `.github/workflows/release-gate.yml`, which triggers on production
version tag pushes (`v[0-9]+.[0-9]+.[0-9]+` without a prerelease suffix),
checks out the tagged SHA, runs the existing `npm run test:e2e` suite
against `point-source/flywheel-sandbox` using the `flywheel-build-e2e` App
credentials, and on a green result calls GitHub's Update Release API with
`draft: false` using the main `FLYWHEEL_GH_APP_ID` credentials — also
removing the `push: branches: ["develop"]` auto-trigger from
`.github/workflows/e2e.yml` (retaining only `workflow_dispatch`) and
updating the *flywheel's own releases* paragraph in
§spec:immutable-release-support to reference this section.
Depends on §road:e2e-polling-discipline and §road:doc-only-path-filter
being in place so the structural change ships into a sandbox with budget
headroom. Implements §spec:release-gate.

**Verify:** Cut a `develop → main` promotion. `flywheel-push.yml` runs
`semantic-release`, which creates the production release as an unpublished
draft visible in the repository's releases list and pushes the version
tag. `release-gate.yml` fires on that tag push, runs the e2e suite, and
on green calls the Update Release API to publish the draft — at which
point `release-major-tag.yml` fires on the resulting `release: published`
event and advances `@v1` to the new version. Force a red gate by running
`release-gate.yml` via `workflow_dispatch` against a tag whose SHA fails
e2e (or temporarily breaking the sandbox credential for one run); confirm
the draft stays unpublished, `@v1` stays at the prior release, and
adopters pinned to `@v1` continue to consume the previous green release.
Re-run the gate against the same tag once the underlying issue is
resolved and confirm the publish step succeeds idempotently; running it
again after publish is a no-op. Push a commit to `develop` and confirm
`e2e.yml` no longer auto-triggers (only `integration.yml` and
`verify-dist.yml` run on develop pushes), but `workflow_dispatch` on
`e2e.yml` still runs the suite for manual investigation.

