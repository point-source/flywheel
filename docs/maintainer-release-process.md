# Maintainer release process

How releases of Flywheel itself are cut and how the marketplace listing stays current.

## How releases happen

Flywheel is dogfooded — every push to `main` runs through Flywheel, which runs `semantic-release`. That tags the release and creates a GitHub Release with the auto-generated changelog.

You don't need to run anything manually. To cut a release, merge a PR with a conventional commit title that bumps the version:

- `feat: ...` → minor
- `fix: ...` or `perf: ...` → patch
- `feat!: ...` or any title with `!` or a `BREAKING CHANGE:` footer → major (requires human review per `.flywheel.yml`)

Non-bumping types (`chore`, `style`, `test`, `docs`, `ci`, `build`, `refactor`) accumulate silently until a qualifying commit lands.

## Major-tag floating

The `release-major-tag.yml` workflow runs on `release: published` and re-points the floating major tag (`v1`, `v2`, …) to the new release SHA. This is the standard marketplace pattern — adopters reference `flywheel-ci/flywheel@v1` and get the latest 1.x release on every workflow run.

You should not need to touch this. It runs automatically. The only manual case is the **first** release, before the workflow exists or before `v1` exists at all — see "First-release bootstrap" below.

## First-release bootstrap

The first release of Flywheel cannot use the marketplace listing because the listing doesn't exist yet. The bootstrap order is:

1. **Land the dogfood commit** with workflows still on `uses: ./` (local action ref).
2. **Open and merge a PR `rewrite/flywheel → main`.** semantic-release runs on the push to `main`, cuts `v1.0.0`, creates the GitHub Release.
3. **Manually create the floating `v1` tag** pointing at `v1.0.0`:

   ```bash
   git tag -a v1 v1.0.0 -m "Flywheel v1 (floating)"
   git push origin v1
   ```

4. **Submit to the marketplace** via the GitHub UI on the v1.0.0 release page. Required: `action.yml` with `name`, `description`, `branding` (already present).
5. **Open a follow-up PR** flipping `flywheel-pr.yml` and `flywheel-push.yml` from `uses: ./` to `uses: flywheel-ci/flywheel@v1`. From here on, swarmflow consumes itself from the marketplace, and the `release-major-tag.yml` workflow keeps `v1` floating automatically.

## Versioning across streams

Flywheel currently has a single stream (`main-line`) with a single branch (`main`). If a customer-variant stream is ever added, its tags would be prefixed (e.g. `customer-acme/v1.2.3`) and the major-float workflow handles both formats — see the regex in `.github/workflows/release-major-tag.yml`.

## Rolling back

If a release ships broken:

1. Identify the previous good `vX.Y.Z` tag.
2. Move the floating `v1` tag back manually:

   ```bash
   git tag -fa v1 vX.Y.Z -m "Roll v1 back to vX.Y.Z"
   git push origin v1 --force
   ```

3. Open a PR with a `fix:` commit that addresses the issue. semantic-release will cut a new `vX.Y.Z+1` and `release-major-tag.yml` will move `v1` forward again.

Do not delete the broken release tag — keep the audit trail.
