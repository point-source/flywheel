# ADR 0002 — Each adopter creates their own private GitHub App

- **Status:** Accepted
- **Date:** 2026-05-06

## Decision

Flywheel adopters create their own private GitHub App (scoped to "Only on this account") and supply its `app-id` + `app-private-key` to the action. Flywheel does **not** ship a centrally hosted public App that adopters install from a Marketplace listing.

`scripts/init.sh` automates the create flow — it opens GitHub's App-creation page pre-populated with the required permissions, captures the credentials on a localhost callback, and writes them into the adopter's repo as a Variable + Secret. The adopter's organization holds the private key; Flywheel maintainers never see it.

## Context

When creating a GitHub App, GitHub asks "Where can this GitHub App be installed?" with two options:

- **Only on this account** — private, only the creating account can install it.
- **Any account** — public, any GitHub user/org can click "Install" on the App's public page and add it to their repos. The App's owner holds a single shared private key that all installations authenticate against.

The natural-sounding pitch for "Any account" is one-click onboarding: adopters skip App creation entirely, just install ours, done. This ADR records why we rejected that model.

## Why per-adopter private Apps

1. **No central trust anchor.** A public App means every installation grants `contents: write`, `pull-requests: write`, `actions: read`, etc. to a key controlled by the Flywheel maintainers. A leaked private key compromises every adopter simultaneously. Per-adopter keys contain blast radius to a single org and make rotation an org-local operation.

2. **No central operational burden.** Flywheel has no backend. The action runs entirely inside the adopter's Actions runner; the App exists only to mint a short-lived installation token *inside that runner* with permissions the default `GITHUB_TOKEN` lacks (see `spec.md:23`). A public App would force someone to own the shared key — rotation, incident response, security disclosures, abuse reports against installations — without any corresponding architectural benefit.

3. **Identity matches accountability.** Promotion PRs, back-merge merge commits, and `chore(release):` tags should be authored by *the adopter's* bot. Their audit log, their bot identity, their org's commit signing policy. A shared `flywheel[bot]` author across every adopter's repo confuses provenance and cross-contaminates audit trails.

4. **Permissions stay adopter-controlled.** Public Apps freeze permissions to whatever the App owner declared; permission changes prompt every installation to re-consent. With per-adopter Apps, an adopter can audit, narrow, or extend permissions on their own App without coordinating with us. The action's permission-precheck (`spec.md:45`) gives a friendly error if anything is missing, which makes the customization safe.

5. **Onboarding is already automated.** The "you save adopters work" argument for a public App assumes manual App creation is the friction. `init.sh` reduces it to ~30 seconds: browser-based consent, localhost callback, credentials written automatically. The remaining manual step (clicking "Install" to scope to a repo) exists in both models.

## What a public App would buy us

For honesty:

- **One-click install** instead of the ~30-second `init.sh` flow.
- **Centralized permission upgrades.** If we add a permission requirement, public-App installations get a single re-consent prompt; per-adopter Apps require each adopter to add the permission to their own App manifest. The action's permission-precheck softens this — adopters get a fail-fast message naming the missing permission — but it is still adopter-side work.
- **A Marketplace listing** as a discovery surface.

None of these outweigh the trust, operational, and identity costs above for a tool that does not need a hosted backend.

## When this would be worth revisiting

If Flywheel ever grows a hosted component — a webhook receiver that does work outside the Actions runner, a cross-repo dashboard, anything that requires *us* to hold a token — the calculus changes. At that point the central-trust cost is already being paid, and a public App becomes the natural distribution model. Until then, per-adopter Apps are the right shape.
