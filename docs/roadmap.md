# Roadmap

Items captured for later investigation. Not commitments.

## Reusable workflow for the adopter surface

Adopters currently paste two complete YAML files into `.github/workflows/` (`flywheel-pr.yml` and `flywheel-push.yml`). They could instead reference a single reusable workflow:

```yaml
# .github/workflows/flywheel-pr.yml — adopter side, ~6 lines
name: Flywheel — PR
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
jobs:
  conduct:
    uses: point-source/flywheel/.github/workflows/pr.yml@v1
    secrets:
      app-id: ${{ secrets.APP_ID }}
      app-private-key: ${{ secrets.APP_PRIVATE_KEY }}
```

### Why investigate

- Removes ~16 lines of copy-paste-prone YAML per adopter workflow.
- Bug fixes in the reusable workflow propagate via the floating `@v1` tag, no adopter PR needed for the boilerplate.
- The doc burden in `docs/adopter-setup.md` shrinks substantially.

### Open questions / known sharp edges

- **Permissions intersection.** A called workflow's `permissions:` block is intersected with the caller's. The adopter caller workflow needs to grant enough scope (`pull-requests: write`, `contents: write`) for the called workflow's needs to materialize. We'd need to document this and probably surface it in `init.sh`.
- **Token plumbing.** App-token minting via `actions/create-github-app-token` works inside reusable workflows, but the secrets must be passed via the `secrets:` block on the caller side. Verify behavior end-to-end against `flywheel-sandbox` before committing to this surface.
- **Adopter override knobs.** Today adopters can edit their workflow YAML to add steps before/after the Flywheel action (e.g. extra checkout depth, custom labels for telemetry). A reusable workflow forecloses that. Decide whether we accept the loss or expose extension points (`pre-steps`, `post-steps` inputs — historically a foot-gun in actions).
- **Testing in the sandbox.** Pre-merge e2e of arbitrary SHAs requires the `swarmflow_repo` / `swarmflow_ref` override pattern from ADR 0001 (rewrite #2). Re-introducing it for rewrite #3 is mechanical but adds a non-trivial input to the reusable-workflow contract.
- **History.** ADR 0001 (rewrite #2) describes a viable side-load + `uses: ./.swarmflow` pattern for reusable workflows. Rewrite #3 simplified past that. Re-introducing reusable workflows means we're partly rolling back rewrite #3's simplification — worth being explicit about the trade.

### What rejecting it preserves

- Single source of truth (one bundled action), no per-event reusable workflow files in this repo's adopter surface.
- Adopters can read their entire Flywheel surface in two short YAML files in their own repo — no `@v1`-pinned indirection.

Status: open. Revisit after `init.sh` / `doctor.sh` adoption telemetry exists, so the decision is informed by which step in `docs/adopter-setup.md` adopters actually trip on.

## Migrate dogfood workflows from `GH_PAT || GITHUB_TOKEN` to App tokens

`.github/workflows/flywheel-pr.yml`, `flywheel-push.yml`, and `release-major-tag.yml` still reference `secrets.GH_PAT || secrets.GITHUB_TOKEN`. The repo has neither `GH_PAT` nor `APP_ID` / `APP_PRIVATE_KEY` set, so these run on the `GITHUB_TOKEN` fallback today.

### What's needed before migration

- A dedicated GitHub App (separate from `flywheel-build-e2e`, which is provisioned for sandbox testing) installed on `point-source/flywheel` with Contents r/w, Pull requests r/w, Metadata r.
- `APP_ID` and `APP_PRIVATE_KEY` set as repo secrets.
- A scratch verification: open a `chore: smoke test` PR after migration, confirm release fires on merge.

### Why it matters

- `doctor.sh` currently flags this repo's own setup as misconfigured. A self-hosted Flywheel that fails its own doctor is a credibility tax.
- `GITHUB_TOKEN` cannot trigger downstream workflows from PRs it creates. The dogfood happens to work today because the simple single-branch config never opens a promotion PR — but if we ever add a `develop`-style branch to the dogfood, the missing App token immediately breaks the promotion-PR fan-out.

Status: blocked on App provisioning. Mechanical change once the secrets exist.
