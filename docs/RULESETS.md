# Rulesets

These rulesets make it structurally impossible (not just policy-impossible)
for agents or humans to bypass pipeline conventions. There are three
rulesets in total — two applied by default (managed branches, version
tags) and one opt-in (feature-branch naming). Create them during initial
setup even if only `develop` is active — they are inert for branches
that don't yet exist and become active the moment those branches appear.

GitHub Rulesets are preferred over classic branch protection because they
support per-actor bypasses, tag pattern targets, and JSON export. If your
GitHub plan does not support rulesets, fall back to classic branch protection
with equivalent settings — the pipeline does not depend on the ruleset format
itself, only on the protections being in place.

## Quick setup (recommended)

A helper script applies the rulesets in one command. The swarmflow GitHub
App must already be installed on the target repo (see `docs/install-app/`).

```sh
./scripts/setup-rulesets.sh --repo your-org/your-repo --app-id 12345
```

This applies the two default rulesets: managed branches and version tags.

`--app-id` takes the numeric App id (NOT the slug, NOT the installation id).
Find it on the App settings page — the top shows "App ID: 12345". You may
already have the same value stored as the `APP_ID` repo secret.

To also apply the optional feature-branch naming ruleset, pass `--with naming`:

```sh
./scripts/setup-rulesets.sh --repo your-org/your-repo --app-id 12345 --with naming
```

To skip one of the defaults, pass `--skip <name>` (`managed` or `tags`).
Run with `--help` for the full options list.

The default template does NOT include a merge_queue rule (see "Merge
queue (optional, manual setup)" below). If you want one and your plan
supports it, add it via the GitHub UI after the script runs.

## Manual setup (UI or curl)

The rulesets live as JSON templates under `templates/rulesets/`:

- `managed-branches.json` — protect `main`/`staging`/`develop` (default)
- `version-tags.json` — protect `v*` tags (default)
- `feature-branch-naming.json` — enforce branch-name pattern (opt-in)

Each template has `<APP_INSTALLATION_ACTOR_ID>` as a placeholder for your
installed App's id (visible in the ruleset UI's "Bypass list" search, or via
`gh api repos/<owner>/<repo>/installation --jq '.app_id'`). Substitute, then
import via either:

- UI: Settings → Rules → Rulesets → New ruleset → Import
- API: `gh api repos/<owner>/<repo>/rulesets -X POST --input <file>`

(`feature-branch-naming.json` has `bypass_actors: []` and needs no
substitution.)

## Managed branches ruleset

`templates/rulesets/managed-branches.json`. Highlights:

- Pull request required for any change (no direct pushes, even by the bot
  outside its bypass)
- PR conversation hygiene: required-review-thread-resolution and
  dismiss-stale-reviews-on-push are folded in via the `pull_request`
  rule's parameters
- One required status check: **`orchestrate / run`** — the swarmflow
  orchestrator's job. If you rename the `orchestrate` job in your
  entrypoint workflows, update this context.
- Linear history required (squash or rebase only)
- Bypass for the swarmflow App so its push during promote/release works

**Merge queue (optional, manual setup):** the default template does NOT
include a merge_queue rule because the API requires a long parameters block
(merge_method, grouping_strategy, timeouts, etc.) and many adopters won't
need it. To enable: in the GitHub UI, edit the "swarmflow / managed
branches" ruleset and add a "Merge queue" rule — the UI auto-fills sensible
defaults. The pipeline auto-detects merge queue at runtime via the
GitHub API and routes to the enqueue API instead of native auto-merge
when it's active.

## Version tag ruleset

`templates/rulesets/version-tags.json`. Prevents anyone but the App from
creating, updating, or deleting tags matching `v*`.

## Feature branch naming ruleset (optional, opt-in)

`templates/rulesets/feature-branch-naming.json`. Forces feature branches
to start with a conventional-commit type prefix (`feat/`, `fix/`, etc.).
Optional but recommended for swarm environments — makes branch intent
machine-readable and prevents agents from creating untyped branches.

The `branch_name_pattern` rule type is not accepted by every plan/repo
combination through the REST API (some return HTTP 422 with no detail).
The setup script does NOT apply this ruleset by default; opt in with
`--with naming`:

```sh
./scripts/setup-rulesets.sh --repo your-org/your-repo --app-id 12345 --with naming
```

If the API still rejects, configure the rule via the GitHub UI instead
(Settings → Rules → Rulesets → New ruleset → "Restrict branch names"),
which auto-fills the parameters correctly.

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
