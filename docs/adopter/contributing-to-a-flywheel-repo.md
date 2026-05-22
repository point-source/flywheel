# Contributing to a repo that uses Flywheel

You arrived here because a project you want to contribute to uses [Flywheel](https://github.com/point-source/flywheel) to orchestrate its PRs and releases, and you want to know what that means for you in five minutes — not how it works under the hood.

This doc is intentionally generic. The repo you're contributing to should have a `CONTRIBUTING.md`, `CLAUDE.md`, or `AGENTS.md` with the same instructions and the repo-specific values filled in (the maintainer is expected to install [the snippet from §6 of the adopter setup guide](./setup.md#6-brief-your-contributors-human-and-ai)). If they haven't, this doc tells you what to ask for.

> **Contributing to Flywheel itself?** Read [the repo's `CONTRIBUTING.md`](https://github.com/point-source/flywheel/blob/main/CONTRIBUTING.md) instead. This doc is for repos that *use* Flywheel as adopters.

## The mental model in three sentences

1. **You don't cut releases.** A release happens automatically when you land a PR whose title says it should — `feat:` (minor), `fix:` / `perf:` (patch), or anything `!`-suffixed (major). There is no manual release step, no `git tag`, no "release please" button.
2. **You don't promote between branches.** If the repo has multiple managed branches (e.g. `develop → staging → main`), Flywheel opens and updates the promotion PRs itself. You always target the first one — the integration branch — and let your change flow downstream.
3. **The PR title is load-bearing.** It determines the version bump, the changelog entry, and whether your PR auto-merges or waits for review. Get it right first time and CI doesn't have to re-run.

## The five things you need from the repo

These values are repo-specific. If the repo's `CONTRIBUTING.md` / `CLAUDE.md` / `AGENTS.md` doesn't spell them out, ask a maintainer or read them from the sources below.

| What you need                                | Where it lives                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Target branch** for your PR                | First branch under the first stream in `.flywheel.yml` at the repo root                                 |
| **Other managed branches** (do not target)   | Every other `branches[].name` in `.flywheel.yml`                                                        |
| **Auto-merge eligibility** for your PR title | The `auto_merge:` array on your target branch in `.flywheel.yml`                                        |
| **Required status checks**                   | The branch ruleset on the target branch (GitHub UI → Settings → Rules → Rulesets), or `gh ruleset list` |
| **Local equivalent of CI** (run before push) | The `quality.yml` workflow, or whatever workflow exposes the required check                             |

## How to contribute a change

1. **Branch off the target branch.** Use `<type>/<short-kebab-description>` — e.g. `feat/login-rate-limit`, `fix/null-deref-on-empty-list`. Some repos enforce this via ruleset; pushes that don't match are rejected.
2. **Make your change.** One logical change per PR — Flywheel derives the version bump from the title, so a `feat` and a `fix` rolled together loses the fix in the release notes.
3. **Run the required checks locally** before pushing. Every re-push to fix a failing check costs CI minutes.
4. **Open the PR against the target branch** with a [Conventional Commits](https://www.conventionalcommits.org/) title:
   ```
   <type>[(<scope>)][!]: <description>
   ```
   Recognized types: `feat`, `fix`, `chore`, `refactor`, `perf`, `style`, `test`, `docs`, `build`, `ci`, `revert`. Append `!` for breaking changes. Flywheel will rewrite a malformed title, but the rewrite + re-run round-trip is wasted CI.
5. **If your PR fixes a tracked issue, add a `Closes #N` trailer to the PR body** (`Fixes #N` / `Resolves #N` also work, case-insensitive). Flywheel preserves these trailers when it rewrites the body, and the promotion PR onto the production branch aggregates them so the issues auto-close when the release lands. The trailing `(#N)` GitHub appends to a squash-merge title is **not** a closing reference — without an explicit keyword, the issue stays open.
6. **Open the PR only when it's ready to merge.** A branch is private work-in-progress; a PR is a request to merge. Once open and eligible, Flywheel auto-merges as soon as required checks pass — there is no "ready for review" gate to flip.

After it merges, the branch is done — cut a new one off the target branch for your next change. Reusing a branch after its commits have landed produces phantom rebase conflicts because the squashed upstream commit has a different patch-id than your originals.

## How to make a new release

You don't, directly. You land a PR whose title type bumps the version:

| Commit title                                       | Bump  | When the release happens                                     |
| -------------------------------------------------- | ----- | ------------------------------------------------------------ |
| `feat!: …` or `feat: …!` (or `BREAKING CHANGE:` footer) | major | On merge to a release branch                                 |
| `feat: …`                                          | minor | On merge to a release branch                                 |
| `fix: …`, `perf: …`                                | patch | On merge to a release branch                                 |
| `chore: …`, `style: …`, `docs: …`, `test: …`, `ci: …`, `build: …`, `refactor: …` | none  | Accumulates silently; included in the next qualifying release |

"Release branch" means whichever branch in the stream is configured to publish — usually the last one (`main`), but a prerelease branch (`develop`) may also publish a prerelease (e.g. `v1.3.0-dev.4`). Check `.flywheel.yml` for the `release:` field on each branch.

If your change is genuinely a release-bumping fix or feature, just title the PR that way and merge it. If it's not — and you're being asked to ship a release *because of timing*, not because of a code change — talk to the maintainer; some repos have a `chore(release): trigger` convention or similar escape hatch, but that's repo-specific and not part of Flywheel.

## Things you must not do

These are config-independent. Doing any of them either breaks the release pipeline or wastes CI minutes:

- **Do not push to or force-push any managed branch.** They are protected; the push will be rejected.
- **Do not create version tags** (`v1.2.3`, etc.) or any tag matching the project's release namespace. Only Flywheel's GitHub App may mint them — your tag push will be rejected, and if it somehow lands, it confuses `semantic-release`.
- **Do not edit a PR's title or body after Flywheel has rewritten them.** Push a new commit with the corrected conventional-commit message instead; Flywheel re-derives both on the next event.
- **Do not open promotion PRs by hand.** If a promotion PR is missing or stale, the upstream merge probably hasn't landed yet — wait, or check the `flywheel-push` workflow run on the upstream branch.
- **Do not reuse a branch after its commits have landed.** Cut a new one off the latest base.

## If your PR was labeled `flywheel:needs-review` and you expected `flywheel:auto-merge`

The title's commit type isn't in the target branch's `auto_merge` list — or you used a breaking variant (`feat!`) when only the non-breaking variant (`feat`) is listed. Check `.flywheel.yml` for the target branch's `auto_merge:` array. Either retitle the PR (push a commit with an amended message) or wait for a human approval.

## If a release didn't happen after your PR merged

Most likely your commit type doesn't bump the version (`chore`, `style`, `docs`, `test`, `ci`, `build`, `refactor`). Those accumulate silently until a qualifying commit lands. Check the `flywheel-push` workflow run on the target branch — if it ran and the `semantic-release` step said "no release was published," that's the explanation. The next `feat:` / `fix:` will sweep yours into the release notes.

## Where to read more

- **[`.flywheel.yml`](#) at the repo root** — the source of truth for branch topology and auto-merge rules.
- **The repo's `CONTRIBUTING.md` / `CLAUDE.md` / `AGENTS.md`** — same rules as this doc, with this repo's values filled in.
- **[Flywheel's adopter setup guide](./setup.md)** — what the maintainer of this repo configured. You shouldn't need it to contribute, but §6 is the source of the snippet your repo's `CONTRIBUTING.md` was generated from.
- **[Flywheel's spec](../design/spec.md)** — authoritative behavior. Read this if a Flywheel decision surprised you and the docs don't explain why.
