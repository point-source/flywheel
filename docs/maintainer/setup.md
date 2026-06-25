# Maintainer setup

This file documents the one-time steps required to operate the Flywheel repository itself.

## Required App credentials

Flywheel uses a GitHub App installation token. Personal Access Tokens are not supported.

- `FLYWHEEL_GH_APP_ID` — numeric ID of the GitHub App installed on this repo. Stored as a repo **Variable** (it's not sensitive — visible on the App's settings page).
- `FLYWHEEL_GH_APP_PRIVATE_KEY` — PEM-format private key for that App. Stored as a repo **Secret**.

The App needs:

- **Contents: read and write** (tag creation, `.releaserc.json` write)
- **Pull requests: read and write** (PR creation, body updates, auto-merge)
- **Issues: read and write** (label add/remove on PRs)
- **Checks: read and write** (posting the `flywheel/conventional-commit` check)
- **Metadata: read**

Each workflow mints a short-lived installation token via [`actions/create-github-app-token`](https://github.com/actions/create-github-app-token); see the templates in `scripts/templates/`.

`GITHUB_TOKEN` is insufficient for the dogfooded self-adoption case — it cannot trigger downstream workflows from PRs it creates.

## Branch protection rulesets

Flywheel protects its own `main` branch with the four rulesets from spec §Branch protection.

### Ruleset 1 — Protect `main`
- Target: `main`
- Require pull request before merging
- Require status checks: the PR-gating set (see *Required status checks on `develop` and `main`* below)
- Block force pushes
- Block deletions
- Bypass actor: the Flywheel GitHub App only

(Linear history is intentionally not applied: under hybrid mode, promotion + back-merge produce merge commits, which the rule would reject.)

### Ruleset 2 — Merge queue on `main`
- Group size 1 (strict)
- Required for the action repo since each merge triggers a release

### Ruleset 3 — Protect `v*` tag namespace
- Only the bot may create or delete tags matching `v*`
- Prevents accidental or malicious version-tag minting

### Ruleset 4 — Branch naming (optional)
- Require feature branches to match `(feat|fix|chore|refactor|perf|style|test|docs|build|ci|revert)/.*`

### Required status checks on `develop` and `main` (PR-gating)

These rulesets are applied by `scripts/apply-rulesets.sh`, which adds the
required status checks to the **"Flywheel managed branches — review"** ruleset
(it spans both managed branches, `refs/heads/develop` and `refs/heads/main`).
This is ordinary GitHub branch protection — *not* anything `.flywheel.yml`
configures — and it is scoped to this repository; nothing flywheel configures on
adopter branches changes. See spec §spec:develop-gating-required.

**Why it exists.** Without required checks, flywheel auto-merges a title-type-
eligible PR into `develop` the instant it is mergeable — even with a red gating
check, which ships the violation and strands any in-flight fix. Requiring the
gating checks holds such a PR until the check is green. flywheel's `pr-flow`
still enables GitHub **native auto-merge** on an eligible PR; native auto-merge
then waits for these required checks instead of firing immediately. Accepted
tradeoff: a little less merge speed on flywheel's own development branch in
exchange for the guarantee that a red gating check cannot ship.

**Canonical required-check contexts** (the exact check-run names CI emits — a
wrong context name silently never blocks):

| Context | Workflow / job | Gate |
| --- | --- | --- |
| `flywheel/conventional-commit` | `flywheel-pr.yml` | skip-ci marker / title check |
| `verify` | `verify-dist.yml` job `verify` | `core/dist/` bundle verification |
| `lint` | `governance-lint.yml` job `lint` | governance + Vale prose lint |
| `integration` | `integration.yml` | integration suite |

Do **not** rename those jobs: the check-run context equals the job id, so a
rename silently breaks the required-check reference. `classify` is the sub-second
no-op gating job — it must **not** be a required check. A required job that the
`classify` step skips (a flywheel release/back-merge commit) still reports
success to the required-check rule, so the gate stays honest on every other push.

**Reproduce / re-apply.** The blessed path is the same script adopters use, with
the four contexts passed explicitly (`--app-id` is the App's bypass actor id):

```bash
./scripts/apply-rulesets.sh point-source/flywheel \
  --required-checks "flywheel/conventional-commit,integration,verify,lint" \
  --app-id 3536094
```

Caveat: a full `apply-rulesets.sh` run also flips `delete_branch_on_merge=true`,
which is intentionally **off** on this repo while #60 is open. To change *only*
the required checks without that side effect, PATCH the review ruleset in place
(read it, append the context, PUT it back — preserving the existing contexts,
the `pull_request` rule, and the App bypass actor):

A PUT **replaces the entire ruleset object**, so the read-modify-write below
echoes `conditions` and `bypass_actors` straight back from the live GET. The
`error` guard refuses to proceed if the live ruleset targets no branches — an
empty `conditions.ref_name.include` would otherwise be PUT verbatim and silently
disable protection on both `develop` and `main`:

```bash
RS=16034438   # "Flywheel managed branches — review" ruleset id
gh api repos/point-source/flywheel/rulesets/$RS \
  | jq '
      if (.conditions.ref_name.include | length) == 0
      then error("refusing PUT: live ruleset targets no branches")
      else {name,target,enforcement,conditions,bypass_actors,
            rules: [.rules[]
              | if .type=="required_status_checks"
                then .parameters.required_status_checks
                     |= (. + [{"context":"lint"}] | unique_by(.context))
                else . end]}
      end' \
  | gh api -X PUT repos/point-source/flywheel/rulesets/$RS --input -
```

**Verify (required).** Confirm both the contexts and that both branches are still
targeted — a narrowed `include` is the silent-failure mode this step catches:

```bash
gh api repos/point-source/flywheel/rulesets/$RS --jq '
  "scope: " + (.conditions.ref_name.include | join(", ")),
  "required: " + ([.rules[] | select(.type=="required_status_checks")
                   .parameters.required_status_checks[].context] | join(", "))'
```

## Quality check workflows

The `verify-dist` workflow (see `.github/workflows/verify-dist.yml`) runs typecheck + tests + bundle-drift detection on every PR and push. It must remain a required status check.

When adding new quality check workflows, include **both** triggers:

```yaml
on:
  pull_request:
  merge_group:
```

Without `merge_group`, the merge queue stalls waiting for a check that never fires.

## Bootstrap order for self-adoption

The action references itself once published. Until the first release, workflows use `uses: ./` (local checkout). The flip:

1. Land Phase 5 with workflows still on `uses: ./`.
2. Open `rewrite/flywheel → main` PR. Merge.
3. semantic-release fires on the push to `main` and cuts `v1.0.0`. GitHub Release published.
4. Manually move the floating `v1` tag to that commit (Phase 6's `release-major-tag.yml` automates this going forward).
5. Open a follow-up PR flipping `flywheel-pr.yml` and `flywheel-push.yml` from `uses: ./` to `uses: point-source/flywheel@v2`. From here on, flywheel consumes itself from the marketplace.

## Marketplace listing

After the first release, list the action on the GitHub Actions marketplace via the GitHub UI on the v1.0.0 release page. Required: `action.yml` with `name`, `description`, and `branding` (already present).
