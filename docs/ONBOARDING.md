# Adopter onboarding

Get an existing or new repository onto the swarmflow pipeline.

## Prerequisites

- A GitHub repository you control (with admin access for ruleset setup).
- A **GitHub App** that the pipeline uses as its bot identity. The App
  needs these permissions:

  | Permission     | Level          | Reason                                  |
  |----------------|----------------|-----------------------------------------|
  | Contents       | Read and write | Push tags and CHANGELOG commits         |
  | Pull requests  | Read and write | Create, update, merge, and enqueue PRs  |
  | Checks         | Read and write | Post status checks and quality results  |
  | Actions        | Read and write | Trigger and monitor workflow runs       |
  | Metadata       | Read           | Required by GitHub for all apps         |

  The App must NOT be granted Admin permission. It is a bypass actor only
  in specific rulesets.
- The App's `APP_ID` and a generated `APP_PRIVATE_KEY` PEM.

## Steps

1. **Install the GitHub App** on the adopting repo.

   *Easiest path:* open `docs/install-app/index.html` from a checkout of
   this repo (or the GitHub Pages copy if you've published one). It
   generates a manifest install link that creates the App with the
   correct permissions in one click.

   *Manual path:* register the App yourself with the permissions in the
   table above. Generate a private key on the App settings page.

   Either way, store the credentials as repo secrets on the adopting repo:
   - `APP_ID`
   - `APP_PRIVATE_KEY` (the full PEM, including `-----BEGIN ...` lines)

2. **Copy the entrypoint workflows** from `templates/` into your
   `.github/workflows/`:
   ```
   on-pr.yml
   on-push.yml
   ```
   These are intentionally identical across all adopters — do not modify them.

3. **Create `.pipeline.yml`** at the repo root. Start from
   `templates/pipeline.yml.example`. The minimum config is the `branches` block
   — everything else has sensible defaults. The default (`develop: true,
   staging: false, main: false`) is right for most early-development repos.

4. **Create your build workflow** at `.github/workflows/pipeline-build.yml`
   (or whatever path you set under `pipeline.workflows.build`). Use
   `templates/pipeline-build.yml.example` as a starting point — replace the
   `# TODO` lines with your real build command. The contract is fixed: the
   workflow MUST accept the inputs `version`, `environment`, `changelog`, and
   `artifact_path`.

5. **Create your publish workflow** at `.github/workflows/pipeline-publish.yml`
   following the same pattern. Route on `environment` (develop/staging/production)
   to choose where to publish.

6. *(Optional)* **Create a quality workflow** at
   `.github/workflows/pipeline-quality.yml`. If absent, the quality gate is
   skipped — the pipeline still enforces conventional-commit format and the
   merge-strategy gate.

7. **Configure rulesets and branch protection.** The fastest path is the
   helper script:
   ```sh
   ./scripts/setup-rulesets.sh --repo <owner>/<repo> --app-id <numeric-app-id>
   ```
   This applies the two default rulesets (managed branches + version
   tags). Pass `--with naming` to also apply the optional feature-branch
   naming rule. Create the rulesets even if you've only enabled
   `develop` — the protections are inert for branches that don't exist
   yet, and become active the moment those branches are created. See
   [`RULESETS.md`](./RULESETS.md) for manual setup or details on each
   ruleset.

8. **Tag an initial version** if you have existing code:
   ```sh
   git tag v0.1.0 && git push --tags
   ```
   Otherwise `initial_version` from `.pipeline.yml` is used as the floor.

## What happens next

Open a PR with a conventional-commit-formatted title (e.g.
`fix(api): handle null user`). The pipeline will:

1. Validate the commit format.
2. Rewrite the PR title and body with a generated changelog fragment.
3. Run your quality workflow (if configured).
4. Auto-merge if the commit type is in `auto_merge_types` and there's no
   breaking change; otherwise comment
   `:eyes: Ready for human review — <reason>` (e.g. "change type
   requires approval before merge").
5. After merge, dispatch your build (if `publish_on_<branch>=true`) and
   upsert a promotion PR to the next active branch.
6. On `main`: tag, create a GitHub Release, and dispatch the production build.

## Verifying the install

After step 7, push a trivial `chore:` PR to `develop`. Within ~1 minute you
should see:

- Your `Pipeline — PR` workflow turn green.
- The PR title rewritten by the bot.
- The PR body show a generated `## Changes` section.
- The PR auto-merge into `develop`.
- Your `Pipeline — Push` workflow fire on `develop`.
- A `dev` pre-release tag (e.g. `v0.1.0-dev.1`) appear on the develop branch
  if you have `main: true` enabled (with `main: false`, the dev tag is still
  computed and used in the build dispatch but no GitHub Release is created).

If anything looks off, check the run logs — every step is annotated with
either `::notice::`, `::warning::`, or `::error::` lines.
