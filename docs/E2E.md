# End-to-end test setup

`.github/workflows/e2e.yml` drives a **separate sandbox repo** through the
full pipeline — pr-lifecycle, promote, release — and asserts the outcomes.
It's run manually via `workflow_dispatch`; it is **not** part of gating CI
because each run takes minutes and mutates a live GitHub repo.

The rest of this doc is the setup checklist.

## 1. Create the sandbox repo

One-time. The sandbox exists only to host e2e runs.

```sh
gh repo create PointSource/swarmflow-e2e-sandbox --private --clone
cd swarmflow-e2e-sandbox
```

Copy in the adopter files from this repo's `templates/`:

```sh
mkdir -p .github/workflows
cp ../swarmflow/templates/on-pr.yml       .github/workflows/
cp ../swarmflow/templates/on-push.yml     .github/workflows/
cp ../swarmflow/templates/pipeline.yml.example .pipeline.yml
```

Open `.pipeline.yml` and enable every branch — the e2e test wants to
exercise promote and release, not just develop:

```yaml
pipeline:
  branches:
    develop: true
    staging: true
    main: true
```

Add **no-op adopter workflows** so the pipeline's dispatch-and-wait steps
have something that returns 0:

```yaml
# .github/workflows/pipeline-build.yml
name: Build
on:
  workflow_dispatch:
    inputs: { version: {type: string}, environment: {type: string},
              changelog: {type: string}, artifact_path: {type: string} }
jobs:
  build:
    runs-on: ubuntu-latest
    steps: [ { run: 'echo build $INPUTS', env: { INPUTS: '${{ toJson(inputs) }}' } } ]
```

Do the same for `pipeline-publish.yml` and `pipeline-quality.yml` (the
quality one takes `pr_number` + `sha` inputs). Commit everything to `main`.

## 2. Pin a baseline tag

The e2e workflow resets `develop`, `staging`, and `main` to this tag
before every run — that's what makes each run deterministic.

```sh
git checkout main
git tag e2e-baseline
git push origin e2e-baseline
git push origin main:develop
git push origin main:staging
```

If the sandbox layout ever changes, move the tag:

```sh
git tag -f e2e-baseline && git push -f origin e2e-baseline
```

## 3. Install the swarmflow GitHub App on the sandbox

Same App you'd install on any adopter. It needs:

- Contents: write (push, tag, CHANGELOG)
- Pull requests: write (open, edit, merge)
- Actions: write (dispatch build/publish/quality)
- Metadata: read

## 4. Configure rulesets (or turn them off)

The sandbox needs rulesets loose enough for the App bot to merge PRs. Two
options:

- **Copy** `docs/RULESETS.md` into the sandbox but add the App as a bypass
  actor on `main`, `staging`, `develop`.
- **Simpler**: skip rulesets entirely on the sandbox. It's not production.

## 5. Add the secrets and variable in *this* repo

These live on swarmflow, not the sandbox — the e2e workflow runs here.

Secrets (Settings → Secrets and variables → Actions → Secrets):

- `E2E_APP_ID` — App ID
- `E2E_APP_PRIVATE_KEY` — App private key (PEM)

Repository variables (same page, Variables tab):

- `E2E_SANDBOX_REPO` — e.g. `PointSource/swarmflow-e2e-sandbox`
- `E2E_TEST_RELEASE` — `true` to also exercise the release-on-main path.
  Omit or set `false` to stop after promote.

## 6. Run it

```sh
gh workflow run e2e.yml --repo PointSource/swarmflow
gh run watch --repo PointSource/swarmflow
```

Or from the Actions tab. To test an unmerged branch, pass `ref`:

```sh
gh workflow run e2e.yml -f ref=my-feature-branch
```

## What the test asserts

| Stage | Fixture | Expected outcome |
|-------|---------|------------------|
| pr-lifecycle | `fix:` commit, PR to develop | PR auto-merged; title/body rewritten |
| promote | merge lands on develop | `v*-dev.N` pre-release tag appears |
| pr-lifecycle | `feat!:` breaking commit | PR stays OPEN (human gate) |
| release | `fix:` commit on main (opt-in) | Semver tag + GitHub Release created |

`feat:` (non-breaking) is intentionally not exercised as an auto-merge
case — the spec gates every `feat:` on human review, so the assertion
overlaps with the breaking-change row above. `fix:` is the canonical
auto-merge path.

## Idempotency guarantees

Every run:

1. **Pre-cleans** stale `e2e-*` branches, PRs, tags, and releases from
   prior aborted runs (`|| true` so first run works).
2. **Resets** `develop`, `staging`, `main` to `e2e-baseline` via
   force-push — so two consecutive runs start identically even if the
   previous one merged commits or wrote to `CHANGELOG.md`.
3. **Namespaces** everything it creates with `e2e-$RUN_ID` — branches,
   commit messages, PR titles — so parallel runs (should they ever happen)
   can't collide on names.
4. **Tears down** under `if: always()` — success or failure, branches are
   deleted, tags/releases wiped, managed branches reset.

The `concurrency` group prevents parallel runs against the same sandbox,
but the namespacing is still there as belt-and-braces.

## Troubleshooting

- **"no run found for on-pr.yml"** — the App likely isn't installed on the
  sandbox, so the PR open event never triggered the workflow. Check
  Settings → GitHub Apps on the sandbox.
- **Breaking-PR assertion fails because it merged** — `auto_merge_types`
  in the sandbox's `.pipeline.yml` probably includes `feat`. It shouldn't;
  the default set excludes `feat` and all breakers.
- **Release assertion fails with no tag** — confirm `main: true` is in the
  sandbox's `.pipeline.yml` and `E2E_TEST_RELEASE=true` is set on this
  repo's variables.
- **Baseline reset fails** — the App needs `contents: write` on the
  sandbox *and* the App must be listed as a bypass actor if the sandbox
  has branch protection on `main`.
