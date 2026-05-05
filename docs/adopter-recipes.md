# Adopter recipes

Each recipe is a `release_files:` snippet you paste into your `.flywheel.yml` for ecosystems where the version lives in a checked-in file (Flutter `pubspec.yaml`, Cargo `Cargo.toml`, etc.). Flywheel turns each entry into an `@semantic-release/exec` `prepareCmd` and adds the path to `@semantic-release/git`'s `assets` so the bumped file is committed alongside the changelog.

You never edit `.releaserc.json` — Flywheel overwrites any committed copy on every push. The whole release pipeline is configured from `.flywheel.yml`.

## Schema reference

Each entry is a tagged union: either declarative or exec.

**Declarative form** (preferred for line-oriented formats):

```yaml
release_files:
  - path: <file>
    pattern: <regex>          # extended sed regex; sed delimiter is `|` (no literal `|` allowed)
    replacement: <template>   # supports ${version}, ${channel}, ${build}
```

Flywheel emits `sed -i.bak -E "s|<pattern>|<replacement>|" <path> && rm <path>.bak`.

**Exec form** (for formats where regex is awkward — TOML, XML, multi-line edits):

```yaml
release_files:
  - path: <file>
    cmd: <shell command>      # supports ${version}, ${channel}, ${build}
```

The `path` still drives the `assets` list; the `cmd` is run verbatim after placeholder substitution.

**Placeholders:**

| Placeholder  | Becomes                              | Notes                                                                                              |
| ------------ | ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `${version}` | semver string (e.g. `1.2.3-rc.1`)    | Always present.                                                                                    |
| `${channel}` | `rc`, `dev`, …                       | Empty string on production releases.                                                               |
| `${build}`   | monotonic integer                    | `git tag --list 'v*' \| wc -l + 1`. Counts every prior release (rc and prod). Required by Play/App Store. |

## sed portability

`sed -i.bak ... && rm <file>.bak` is the portable form. BSD `sed` (macOS) requires the backup-suffix argument; GNU `sed` (Linux, GitHub Actions runners) accepts the same form. Flywheel emits this for you; the note matters if you go to debug a `cmd:` entry that wraps `sed` itself.

---

## Flutter (`pubspec.yaml`)

Updates `version: <semver>+<build>` on every release. The `+<build>` segment is what Flutter writes to Android `versionCode` / iOS `CFBundleVersion`; both must increase monotonically across all uploads of the same package.

```yaml
flywheel:
  streams:
    - name: main-line
      branches:
        - { name: develop, release: prerelease, suffix: dev, auto_merge: [fix, feat] }
        - { name: staging, release: prerelease, suffix: rc,  auto_merge: [fix] }
        - { name: main,    release: production,             auto_merge: [] }

  release_files:
    - path: pubspec.yaml
      pattern: '^version: .*'
      replacement: 'version: ${version}+${build}'

  merge_strategy: squash
```

## Cargo (`Cargo.toml`)

```yaml
release_files:
  - path: Cargo.toml
    pattern: '^version = ".*"'
    replacement: 'version = "${version}"'
```

`pattern: '^version = ".*"'` only anchors to start-of-line, so it matches the first `version = "..."` in the file — usually the one in `[package]`. If your repo is a workspace with member crates, add an entry per `Cargo.toml`.

If you want the lockfile committed too, add it to a separate entry that runs `cargo update -p <crate> --precise ${version}` (exec form) — the lockfile is not auto-rewritten by editing `Cargo.toml`.

## pyproject (`pyproject.toml`)

PEP 621 (`[project]`) and Poetry (`[tool.poetry]`) both use `version = "..."`. Use the exec form because TOML's quoting is awkward for sed:

```yaml
release_files:
  - path: pyproject.toml
    cmd: |
      python -c "import re; p='pyproject.toml'; t=open(p).read(); t=re.sub(r'(?m)^(version\s*=\s*)\"[^\"]*\"', r'\1\"${version}\"', t, count=1); open(p,'w').write(t)"
```

`count=1` ensures only the first `version = "..."` line is replaced (the `[project]` one if it appears before any `[tool.*]` section). For projects with both `[project]` and `[tool.poetry]` (Poetry 1.8+), drop `count=1` or run a second entry.

## .NET (`.csproj`)

```yaml
release_files:
  - path: YourProject.csproj
    pattern: '<Version>[^<]*</Version>'
    replacement: '<Version>${version}</Version>'
```

Replace `YourProject.csproj` with your actual project file. For multiple `.csproj` files, add one entry per file — Flywheel `&&`-chains them into a single `prepareCmd`, so a failure in any one aborts the release.

If your project uses `<VersionPrefix>` + `<VersionSuffix>` (NuGet's split form), target `<VersionPrefix>` instead and let `<VersionSuffix>` come from `${channel}`:

```yaml
release_files:
  - path: YourProject.csproj
    pattern: '<VersionPrefix>[^<]*</VersionPrefix>'
    replacement: '<VersionPrefix>${version}</VersionPrefix>'
  - path: YourProject.csproj
    pattern: '<VersionSuffix>[^<]*</VersionSuffix>'
    replacement: '<VersionSuffix>${channel}</VersionSuffix>'
```

## Gradle (`build.gradle.kts` / `gradle.properties`)

For a Kotlin DSL build script with `version = "..."`:

```yaml
release_files:
  - path: build.gradle.kts
    pattern: '^version = ".*"'
    replacement: 'version = "${version}"'
```

For Groovy `build.gradle`, the same `pattern` works — the regex matches both `version = '...'` and `version = "..."`, but the `replacement` will normalize to double-quotes.

For multi-module projects, prefer a single `gradle.properties` holding the canonical version (`version=1.2.3`) and have each module read from it:

```yaml
release_files:
  - path: gradle.properties
    pattern: '^version=.*'
    replacement: 'version=${version}'
```

---

## Doesn't fit your ecosystem?

If `pattern` + `replacement` is too awkward for your file format, drop down to the `cmd` form and run any shell command you like. Flywheel only requires that `path` names the file (so it ends up in `@semantic-release/git`'s `assets`) and that the command exit non-zero on failure.

If you hit a case `release_files:` cannot express at all (multi-package monorepo with independent versioning, plugins not in the bundled chain, custom `tagFormat`), please [open an issue](https://github.com/PointSource/flywheel/issues) — we'd rather extend the schema than re-introduce the committed-`.releaserc.json` escape hatch.
