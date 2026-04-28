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

The exportable JSON for each ruleset is below. Apply via the GitHub UI
(Settings → Rules → Rulesets → New ruleset → Import) or the API
(`POST /repos/{owner}/{repo}/rulesets`).

## Ruleset 1 — Protect managed branches

Replace `<APP_INSTALLATION_ACTOR_ID>` with your installed App's actor id
(visible in the ruleset UI's "Bypass list" search).

```json
{
  "name": "swarmflow / managed branches",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": {
      "include": ["refs/heads/main", "refs/heads/staging", "refs/heads/develop"],
      "exclude": []
    }
  },
  "bypass_actors": [
    { "actor_id": <APP_INSTALLATION_ACTOR_ID>, "actor_type": "Integration", "bypass_mode": "always" }
  ],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "update" },
    { "type": "required_linear_history" },
    {
      "type": "pull_request",
      "parameters": {
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_approving_review_count": 0,
        "required_review_thread_resolution": true
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [
          { "context": "orchestrate / run" }
        ]
      }
    },
    { "type": "merge_queue" }
  ]
}
```

## Ruleset 2 — PR conversation hygiene

This is folded into the `pull_request` rule above; no separate ruleset is
required unless you want the configuration to be reviewable in isolation.

## Ruleset 3 — Protect the version tag namespace

```json
{
  "name": "swarmflow / version tags",
  "target": "tag",
  "enforcement": "active",
  "conditions": {
    "ref_name": { "include": ["refs/tags/v*"], "exclude": [] }
  },
  "bypass_actors": [
    { "actor_id": <APP_INSTALLATION_ACTOR_ID>, "actor_type": "Integration", "bypass_mode": "always" }
  ],
  "rules": [
    { "type": "creation" },
    { "type": "update" },
    { "type": "deletion" }
  ]
}
```

## Ruleset 4 — Restrict feature branch naming (optional)

```json
{
  "name": "swarmflow / feature branch naming",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": {
      "include": ["~ALL"],
      "exclude": ["refs/heads/main", "refs/heads/staging", "refs/heads/develop"]
    }
  },
  "bypass_actors": [],
  "rules": [
    {
      "type": "creation",
      "parameters": {
        "name_pattern": "^(feat|fix|chore|refactor|perf|style|test|docs)/.+$"
      }
    }
  ]
}
```

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
