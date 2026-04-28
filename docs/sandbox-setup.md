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
     - **Repository → Workflows**: write (Layer 3 only)
     - **Repository → Metadata**: read (always required)
   - **Install** the App on `point-source/flywheel-sandbox` (and only that
     repo — don't grant org-wide access).

6. **Store the App credentials as repo secrets** on `point-source/flywheel`
   (Settings → Secrets and variables → Actions):
   - `E2E_APP_ID` — the `flywheel-build-e2e` App ID (numeric).
   - `E2E_APP_PRIVATE_KEY` — the App's private key, PEM format including
     the `BEGIN/END` lines.

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

## When to use a different sandbox

Don't. One sandbox repo is enough — test isolation is enforced via per-test
branch naming, not per-test repos. Adding more sandboxes splits state and
multiplies App-installation overhead.
