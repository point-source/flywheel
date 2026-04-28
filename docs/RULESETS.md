# Rulesets

These rulesets make it structurally impossible (not just policy-impossible)
for agents or humans to bypass pipeline conventions. Create all four during
initial setup even if only `develop` is active — they are inert for branches
that don't yet exist and become active the moment those branches appear.

GitHub Rulesets are preferred over classic branch protection because they
support per-actor bypasses, tag pattern targets, and JSON export. If your
GitHub plan does not support rulesets, fall back to classic branch protection
with equivalent settings — the pipeline does not depend on the ruleset format
itself, only on the protections being in place.

## Quick setup (recommended)

A helper script applies all rulesets in one command. The swarmflow GitHub App
must already be installed on the target repo (see `docs/install-app/`).

```sh
./scripts/setup-rulesets.sh --repo your-org/your-repo --app-id 12345
```

`--app-id` takes the numeric App id (NOT the slug, NOT the installation id).
Find it on the App settings page — the top shows "App ID: 12345". You may
already have the same value stored as the `APP_ID` repo secret.

Skip individual rulesets if not wanted (the feature-branch naming rule is
optional, for example):

```sh
./scripts/setup-rulesets.sh --repo your-org/your-repo --app-id 12345 --skip naming
```

Run with `--help` for the full options list.

If your plan does not support GitHub merge queue, edit
`templates/rulesets/managed-branches.json` and remove the
`{ "type": "merge_queue" }` line before running the script.

## Manual setup (UI or curl)

The four rulesets live as JSON templates under `templates/rulesets/`:

- `managed-branches.json` — Ruleset 1: protect `main`/`staging`/`develop`
- `version-tags.json` — Ruleset 3: protect `v*` tags
- `feature-branch-naming.json` — Ruleset 4: enforce branch-name pattern (optional)

Each template has `<APP_INSTALLATION_ACTOR_ID>` as a placeholder for your
installed App's id (visible in the ruleset UI's "Bypass list" search, or via
`gh api repos/<owner>/<repo>/installation --jq '.app_id'`). Substitute, then
import via either:

- UI: Settings → Rules → Rulesets → New ruleset → Import
- API: `gh api repos/<owner>/<repo>/rulesets -X POST --input <file>`

(Ruleset 4 has `bypass_actors: []` and needs no substitution.)

## Ruleset 1 — Protect managed branches

`templates/rulesets/managed-branches.json`. Highlights:

- Pull request required for any change (no direct pushes, even by the bot
  outside its bypass)
- One required status check: **`orchestrate / run`** — the swarmflow
  orchestrator's job. If you rename the `orchestrate` job in your
  entrypoint workflows, update this context.
- Linear history required (squash or rebase only)
- Merge queue rule included; remove if your plan does not support it
- Bypass for the swarmflow App so its push during promote/release works

## Ruleset 2 — PR conversation hygiene

Folded into the `pull_request` rule above; no separate ruleset needed.

## Ruleset 3 — Protect the version tag namespace

`templates/rulesets/version-tags.json`. Prevents anyone but the App from
creating, updating, or deleting tags matching `v*`.

## Ruleset 4 — Restrict feature branch naming (optional)

`templates/rulesets/feature-branch-naming.json`. Forces feature branches
to start with a conventional-commit type prefix (`feat/`, `fix/`, etc.).
Optional but recommended for swarm environments — makes branch intent
machine-readable and prevents agents from creating untyped branches.

## Repository-level settings

These live under **Settings → General** and apply repo-wide:

| Setting                                         | Value                                |
|-------------------------------------------------|--------------------------------------|
| Allow merge commits                             | Disabled                             |
| Allow squash merging                            | Enabled                              |
| Allow rebase merging                            | Enabled                              |
| Default squash commit message                   | "Pull request title and description" |
| Automatically delete head branches              | Enabled                              |
| Allow auto-merge                                | Enabled                              |

The `Allow auto-merge` toggle is required for the bot to call
`enablePullRequestAutoMerge`. On private repos it requires a paid plan
(GitHub Pro / Team / Enterprise); on public repos it works on any plan.
