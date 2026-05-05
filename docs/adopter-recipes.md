# Adopter recipes

Each recipe is a complete `.releaserc.json` for a specific ecosystem where Flywheel's auto-generated config doesn't cover the version-file update. Commit the file at your repo root; Flywheel will use it instead of generating one (see [adopter-setup.md §3 — `.releaserc.json` precedence](./adopter-setup.md#3-add-the-flywheel-workflows)).

You are responsible for keeping the `branches` and `tagFormat` arrays in sync with your `.flywheel.yml`. Two-source-of-truth drift is the main downside of this path. If you add or remove a stream branch in `.flywheel.yml`, update the recipe's `branches` array too.

`@semantic-release/exec` ships in the Flywheel-bundled npx chain — you do not need to add it to your workflow. Reference it from a committed `.releaserc.json` and Flywheel's `flywheel-push.yml` will resolve it on the fly.

## How to use a recipe

1. Pick the recipe matching your project's ecosystem.
2. Copy the JSON into a new `.releaserc.json` at your repo root.
3. Update the `branches` array to match the branches in your `.flywheel.yml` (in declaration order). Update `tagFormat` if your stream isn't the primary one (see [§Versioning in spec.md](../spec.md) for the `<stream-name>/v${version}` convention).
4. Commit `.releaserc.json` and push.

Verify locally before pushing: `jq . < .releaserc.json` should round-trip cleanly.

## sed portability note

All recipes use `sed -i.bak '...' <file> && rm <file>.bak`. This is the portable form — BSD `sed` (macOS) requires a backup-suffix argument; GNU `sed` (Linux, GitHub Actions runners) accepts the same form. The `&& rm` removes the backup file so it doesn't get committed.

---

## Flutter (`pubspec.yaml`)

Updates `version: <semver>+<build>` on every release. `<build>` is the `v*` tag count plus one — monotonically increasing across rc and prod releases, which Flutter requires (Android `versionCode` and iOS `CFBundleVersion` must be monotonic across all uploads of the same package).

`pubspec.yaml` is added to the `@semantic-release/git` `assets` list so the bump rides along in the `chore(release)` commit.

```json
{
  "tagFormat": "v${version}",
  "branches": [
    { "name": "develop", "prerelease": "dev", "channel": "dev" },
    { "name": "staging", "prerelease": "rc",  "channel": "rc"  },
    { "name": "main" }
  ],
  "plugins": [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    "@semantic-release/changelog",
    ["@semantic-release/exec", {
      "prepareCmd": "BUILD=$(( $(git tag --list 'v*' | wc -l) + 1 )) && sed -i.bak -E \"s/^version: .*/version: ${nextRelease.version}+${BUILD}/\" pubspec.yaml && rm pubspec.yaml.bak"
    }],
    ["@semantic-release/git", { "assets": ["CHANGELOG.md", "pubspec.yaml"] }],
    "@semantic-release/github"
  ]
}
```

For a `release: none` `develop` branch (managed but non-publishing), omit the `develop` entry from `branches` — semantic-release should only see branches that release.

## Cargo (`Cargo.toml`)

```json
{
  "tagFormat": "v${version}",
  "branches": [
    { "name": "develop", "prerelease": "dev", "channel": "dev" },
    { "name": "main" }
  ],
  "plugins": [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    "@semantic-release/changelog",
    ["@semantic-release/exec", {
      "prepareCmd": "sed -i.bak -E \"0,/^version = \\\".*\\\"/s//version = \\\"${nextRelease.version}\\\"/\" Cargo.toml && rm Cargo.toml.bak"
    }],
    ["@semantic-release/git", { "assets": ["CHANGELOG.md", "Cargo.toml", "Cargo.lock"] }],
    "@semantic-release/github"
  ]
}
```

The `0,/^version = ".*"/s//version = "${nextRelease.version}"/` form replaces only the *first* `version = "..."` line, which is the one in `[package]`. Workspace-member `Cargo.toml`s in the same repo will need their own `prepareCmd` invocations.

`Cargo.lock` is included in `assets` because `cargo build` after the `Cargo.toml` bump will regenerate it; if your CI runs `cargo build` between the `prepareCmd` and the `git` step, the lockfile change should be committed too. If you don't want the lockfile committed, drop it from `assets`.

## pyproject (`pyproject.toml`)

PEP 621 (`[project]`) and Poetry (`[tool.poetry]`) both use `version = "..."` but in different sections. Pick the section that holds your project's version.

**PEP 621 / setuptools / hatchling:**

```json
{
  "tagFormat": "v${version}",
  "branches": [
    { "name": "develop", "prerelease": "dev", "channel": "dev" },
    { "name": "main" }
  ],
  "plugins": [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    "@semantic-release/changelog",
    ["@semantic-release/exec", {
      "prepareCmd": "python -c \"import re,sys; p='pyproject.toml'; t=open(p).read(); t=re.sub(r'(?m)^(version\\s*=\\s*)\\\"[^\\\"]*\\\"', r'\\1\\\"${nextRelease.version}\\\"', t, count=1); open(p,'w').write(t)\""
    }],
    ["@semantic-release/git", { "assets": ["CHANGELOG.md", "pyproject.toml"] }],
    "@semantic-release/github"
  ]
}
```

Python is used instead of `sed` because TOML's quoting + indentation is awkward to handle correctly with regex on a shell line. The `count=1` argument on `re.sub` ensures only the first `version = "..."` line is replaced (the `[project]` one if it appears before any `[tool.*]` section).

**Poetry — same recipe**, but if your `pyproject.toml` has both `[project]` and `[tool.poetry]` (allowed in Poetry 1.8+), you need to update both. Run the `prepareCmd` twice with different anchors, or rewrite the substitution to match both occurrences (`count=2`, or drop `count`).

## .NET (`.csproj`)

```json
{
  "tagFormat": "v${version}",
  "branches": [
    { "name": "develop", "prerelease": "dev", "channel": "dev" },
    { "name": "main" }
  ],
  "plugins": [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    "@semantic-release/changelog",
    ["@semantic-release/exec", {
      "prepareCmd": "sed -i.bak -E \"s|<Version>[^<]*</Version>|<Version>${nextRelease.version}</Version>|\" YourProject.csproj && rm YourProject.csproj.bak"
    }],
    ["@semantic-release/git", { "assets": ["CHANGELOG.md", "YourProject.csproj"] }],
    "@semantic-release/github"
  ]
}
```

Replace `YourProject.csproj` with your actual project file. If you have multiple `.csproj` files in a solution and want them all bumped, add a `prepareCmd` per file (each as a separate `@semantic-release/exec` plugin entry, since `prepareCmd` accepts a single shell string per entry — or chain them with `&&`).

The recipe assumes `<Version>X.Y.Z</Version>` exists. If your project uses `<VersionPrefix>` + `<VersionSuffix>` instead (NuGet's split form), adjust the `sed` to target `<VersionPrefix>` and let `<VersionSuffix>` come from `nextRelease.channel` if you want prerelease tagging.

## Gradle (`build.gradle` / `build.gradle.kts`)

```json
{
  "tagFormat": "v${version}",
  "branches": [
    { "name": "develop", "prerelease": "dev", "channel": "dev" },
    { "name": "main" }
  ],
  "plugins": [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    "@semantic-release/changelog",
    ["@semantic-release/exec", {
      "prepareCmd": "sed -i.bak -E \"s/^(version\\s*=\\s*).*/\\1\\\"${nextRelease.version}\\\"/\" build.gradle.kts && rm build.gradle.kts.bak"
    }],
    ["@semantic-release/git", { "assets": ["CHANGELOG.md", "build.gradle.kts"] }],
    "@semantic-release/github"
  ]
}
```

The recipe targets `build.gradle.kts` (Kotlin DSL); for Groovy `build.gradle`, the same `sed` works — change the filename and the regex still matches `version = '...'` or `version = "..."`. Multi-module projects need either a per-module `prepareCmd` or a Gradle property file (`gradle.properties`) holding the canonical version (in which case the `sed` targets `gradle.properties` and the modules read from it).

---

## Doesn't fit your ecosystem?

The pattern is `@semantic-release/exec` + a `prepareCmd` that mutates the version string in your file, plus the file in `@semantic-release/git`'s `assets` list. Adapt the `prepareCmd` to your file format. `${nextRelease.version}` and `${nextRelease.channel}` are the placeholders semantic-release substitutes at runtime.

If your build needs to read both the version *and* a build number, the Flutter recipe shows the pattern: shell out to `git tag --list` for a tag-count-based monotonic counter, then bake both into the file.

For ecosystems where this approach doesn't scale (e.g. multi-package monorepos with independent versioning), the override path is workable but awkward; native schema-level support would be cleaner. That's tracked as a future feature — see the deferred R2 item in the adoption-feedback plan.
