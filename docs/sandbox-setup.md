# Sandbox repo setup

This file documents the one-time provisioning of `point-source/flywheel-sandbox`,
the repo that backs Flywheel's Layer 2 (integration) and Layer 3 (E2E) tests.
See [`testing_strategy.md`](../testing_strategy.md) for the testing architecture.

## What it is

A public repository (`point-source/flywheel-sandbox`) used exclusively to host
real PRs, real labels, and real auto-merge enablement against the GitHub API.
Tests in `tests/integration/` and (later) `tests/e2e/` run against this repo —
never against `flywheel` itself or any production target.

## Provisioning checklist

1. **Create the repo.**
   - Owner: `point-source` (org).
   - Visibility: public.
   - Initialize with a README.
   - No template, no license required (it's test infrastructure, not user-facing).

2. **Create the long-lived branches**, each off the initial commit:

   | Branch | Purpose |
   |---|---|
   | `e2e-main` | Terminal production branch for the `main-line` stream (Layer 3) |
   | `e2e-staging` | Staging branch for `main-line` (Layer 3) |
   | `e2e-develop` | Development branch for `main-line` (Layer 3) |
   | `e2e-customer-acme` | Terminal branch for the `customer-acme` stream (Layer 3) |
   | `integration-test-base` | PR target for all Layer 2 tests |

3. **Commit the sandbox `.flywheel.yml`** to every branch. The canonical
   contents live in [`testing_strategy.md`](../testing_strategy.md#sandbox-repo-configuration).

4. **Branch protection.**
   - On every branch listed above: block force pushes, block deletions.
   - On `e2e-main`, `e2e-staging`, `e2e-customer-acme`: require linear history
     (squash-only), require a passing PR before merging.
   - Allow auto-merge in repo settings (Settings → General → Pull Requests).

5. **Use the `flywheel-build-e2e` GitHub App for auth.** A single App
   mints short-lived installation tokens; no human-owned PATs to rotate.
   - The App lives under the `point-source` org.
   - Required permissions on the App:
     - **Repository → Contents**: read and write
     - **Repository → Pull requests**: read and write
     - **Repository → Issues**: read and write (for labels)
     - **Repository → Checks**: read and write (for posting `flywheel/conventional-commit`)
     - **Repository → Workflows**: write (Layer 3 only)
     - **Repository → Metadata**: read (always required)
   - **Install** the App on `point-source/flywheel-sandbox` (and only that
     repo — don't grant org-wide access).

6. **Store the App credentials as repo secrets** on `point-source/flywheel`
   (Settings → Secrets and variables → Actions):
   - `FLYWHEEL_E2E_APP_ID` — the `flywheel-build-e2e` App ID (numeric).
   - `FLYWHEEL_E2E_APP_PRIVATE_KEY` — the App's private key, PEM format
     including the `BEGIN/END` lines.

   The `Integration tests` workflow (`.github/workflows/integration.yml`)
   uses [`actions/create-github-app-token`](https://github.com/actions/create-github-app-token)
   to mint a token at job start, scoped to `flywheel-sandbox` only, and
   exports it as `SANDBOX_GH_TOKEN` for the test step.

   Rotate the App's private key per your org's policy. Token rotation is
   automatic — each CI run mints a fresh installation token.

   For local runs, set `SANDBOX_GH_TOKEN` in your shell to a GitHub App
   installation token (mint one with `gh` or via your App's installation
   credentials).

## Daily operating contract

- Tests own their branches. Each test creates a uniquely-named branch
  (`test/<scenario>-<unix-millis>`) and a PR. `afterEach` closes the PR and
  deletes the branch.
- The long-lived branches above are immutable from the test perspective —
  tests target them but never push directly to them.
- If the sandbox accumulates leftover branches (test crash, token expiry,
  cancelled CI run), prune with:

  ```bash
  gh api -X GET /repos/point-source/flywheel-sandbox/branches --jq '.[].name' \
    | grep '^test/' \
    | xargs -I{} gh api -X DELETE /repos/point-source/flywheel-sandbox/git/refs/heads/{}
  ```

## Layer 3 workflow installation

Layer 3 e2e tests trigger the action chain by opening, merging, and pushing
to the long-lived `e2e-*` branches in the sandbox. For the chain to fire,
the sandbox repo must carry its own `flywheel-pr.yml` and `flywheel-push.yml`
workflows, pinned to `point-source/flywheel@develop` (Layer 3 validates
already-merged code).

The adopter templates ship as the canonical source. Run `init.sh` with
`--version develop` so the placeholder gets pinned to the develop branch
instead of the latest released major:

```bash
# From a clone of point-source/flywheel-sandbox (on a feature branch):
/path/to/flywheel/scripts/init.sh --version develop --skip-secrets --skip-rulesets
git add .flywheel.yml .github/workflows && git commit -m "ci: install flywheel workflows for Layer 3"
git push origin <branch>
# Then merge to e2e-main, and forward to e2e-staging, e2e-develop, e2e-customer-acme.
# pull_request events read workflows from the BASE branch — every managed
# branch needs its own copy.
```

Apply the branch + tag rulesets via the helper script (replaces the manual
steps for the new branches):

```bash
/path/to/flywheel/scripts/apply-rulesets.sh point-source/flywheel-sandbox \
  --app-id <flywheel-build-e2e App ID> \
  --branches "e2e-main,e2e-staging,e2e-develop,e2e-customer-acme"
```

Passing `--app-id` adds the App as a bypass actor on **both** rulesets.
The branch ruleset bypass is mandatory — without it, semantic-release's
push of the version commit + tag to a managed branch is rejected by the
"changes must be made through a pull request" rule and every release
fails with `EGITNOPERMISSION`. The tag ruleset bypass lets the App
create the version tag itself.

### Workflow content the e2e suite depends on

`scripts/templates/flywheel-push.yml` carries two adopter-relevant
details that aren't obvious — keep them when copying:

- `actions/checkout@v6` is invoked with `persist-credentials: false`.
  Without this flag, checkout writes the workflow's default
  `GITHUB_TOKEN` into `http.<url>.extraheader`, which shadows the App
  installation token semantic-release embeds in its push URL — the push
  then fails as `github-actions[bot]` even though the App token was
  passed.
- The `Run semantic-release` step co-installs the plugin set inline
  (`@semantic-release/changelog`, `/git`, `/github`,
  `/commit-analyzer`, `/release-notes-generator`) via `npx -p`. Plugins
  referenced in the generated `.releaserc.json` are not auto-resolved
  by `npx semantic-release` alone — the run errors with `MODULE_NOT_FOUND`.

Layer 3 cleanup branches its tests under `e2e/<scenario>-<unix-millis>`
(distinct from Layer 2's `test/...` prefix); the same prune command works:

```bash
gh api -X GET /repos/point-source/flywheel-sandbox/branches --jq '.[].name' \
  | grep '^e2e/' \
  | xargs -I{} gh api -X DELETE /repos/point-source/flywheel-sandbox/git/refs/heads/{}
```

## When to use a different sandbox

Don't. One sandbox repo is enough — test isolation is enforced via per-test
branch naming, not per-test repos. Adding more sandboxes splits state and
multiplies App-installation overhead.
