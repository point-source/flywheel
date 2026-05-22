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

## Immutable release support

### §road:release-as-draft-config

Add the repository-wide `release_as_draft` boolean to the `.flywheel.yml`
schema and release-config generation — `src/types.ts`, `src/config.ts`
(top-level key allow-list and boolean validation), and `src/release-rc.ts`
(emit `@semantic-release/github` with `draftRelease: true` when set,
unchanged otherwise) — with `test-fixtures/` cases plus unit coverage in
`tests/config.test.ts` and `tests/release-rc.test.ts`, and a rebuilt
`dist/index.cjs`. Implements §spec:immutable-release-support.

### §road:draft-release-e2e

Add an end-to-end scenario under `tests/e2e/scenarios` that runs a release
with `release_as_draft` enabled, asserts the GitHub Release is created
unpublished with its git tag present, and asserts that two releases cut
back-to-back — the first left as an unpublished draft — receive correct
consecutive versions. Depends on §road:release-as-draft-config. Implements
§spec:immutable-release-support.

### §road:draft-build-docs

Document the `release_as_draft` opt-in and the draft release workflow in
`docs/adopter/setup.md` — a release-tag `push`-triggered build that attaches
its artifact to the unpublished draft and publishes the draft as its final
step, shown alongside the existing immediate-publish `build.yml` example —
keeping every `.flywheel.yml` snippet valid for `tests/docs-examples.test.ts`.
Depends on §road:release-as-draft-config. Implements §spec:immutable-release-support.

**Verify:** In a sandbox adopter repo with `release_as_draft: true` in
`.flywheel.yml`, merge a release-triggering change and confirm the GitHub
Release for the new tag is created as an unpublished **draft**, the git tag
is present, and the `chore(release)` back-merge still lands; cut a second
release before publishing the first draft and confirm it computes the next
version correctly. Remove `release_as_draft` (or set it `false`) and confirm
a release publishes immediately, exactly as before. With immutable releases
enabled on the repository, publish a draft and confirm its tag and assets
freeze while the release notes remain editable.
