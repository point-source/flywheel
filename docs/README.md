# Flywheel docs

This directory holds all Flywheel documentation. Top-level files at the repo root (`README.md`, `CONTRIBUTING.md`, `CLAUDE.md`, `LICENSE.md`, `CHANGELOG.md`) follow GitHub conventions and stay where they are.

## Layout

```
docs/
├── adopter/      ← what adopters read to use Flywheel in their repo
├── maintainer/   ← what Flywheel maintainers read to operate the project
└── design/       ← what Flywheel is and why (spec, requirements, ADRs)
```

## Adopter

For anyone adopting Flywheel into their own repo.

- **[adopter/setup.md](./adopter/setup.md)** — full setup walkthrough: GitHub App, secrets, workflow files, `.flywheel.yml`, branch rulesets, contributor brief.
- **[adopter/recipes.md](./adopter/recipes.md)** — canonical `release_files:` recipes per ecosystem (Flutter, Cargo, .NET, Gradle, etc.).

## Maintainer

For Flywheel contributors and maintainers.

- **[maintainer/setup.md](./maintainer/setup.md)** — operating Flywheel itself: GitHub Apps, ruleset bootstrapping, dogfood loop.
- **[maintainer/release-process.md](./maintainer/release-process.md)** — cutting a Flywheel release; the `v1` floating tag.
- **[maintainer/sandbox-setup.md](./maintainer/sandbox-setup.md)** — provisioning the `flywheel-sandbox` repo that backs Layer 2 / Layer 3 tests.

## Design

What Flywheel is, what it must achieve, and the decisions that got it there.

- **[design/spec.md](./design/spec.md)** — authoritative product specification. The source of truth when docs disagree.
- **[design/requirements.md](./design/requirements.md)** — the requirements the spec serves. Platform-neutral; the right place to evaluate alternative substrates against.
- **[design/testing-strategy.md](./design/testing-strategy.md)** — three-layer testing architecture (unit / integration / e2e).
- **[design/decisions/](./design/decisions/)** — Architecture Decision Records for choices that deserve their own write-up.
