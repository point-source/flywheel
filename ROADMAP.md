# flywheel — Roadmap

## Composite-action distribution

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

