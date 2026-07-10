import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateNotes } from "@semantic-release/release-notes-generator";
import { describe, expect, it } from "vitest";

import {
  generateReleaseRc,
  serializeReleaseRc,
  chooseTagFormat,
} from "../src/release-rc.js";
import type { FlywheelConfig } from "../src/types.js";
import { loadReleaseConfig } from "./helpers/loadReleaseConfig.js";

// Override of @semantic-release/git's default message: drops the `[skip ci]`
// token the plugin would otherwise append. See src/release-rc.ts for the why.
const GIT_MESSAGE =
  "chore(release): ${nextRelease.version}\n\n${nextRelease.notes}";

describe("generateReleaseRc", () => {
  it("default plugin chain includes @semantic-release/exec for committed-rc adopters", () => {
    const config: FlywheelConfig = {
      streams: [
        {
          name: "main-line",
          branches: [{ name: "main", release: "production", auto_merge: [] }],
        },
      ],
    };
    const rc = generateReleaseRc(config.streams[0]!, config);
    expect(rc.plugins).toContain("@semantic-release/exec");
  });

  it("primary stream (terminal release: production) gets v${version}", () => {
    const config: FlywheelConfig = {
      streams: [
        {
          name: "main-line",
          branches: [
            { name: "develop", release: "prerelease", suffix: "dev", auto_merge: ["fix"] },
            { name: "staging", release: "prerelease", suffix: "rc", auto_merge: ["fix"] },
            { name: "main", release: "production", auto_merge: [] },
          ],
        },
      ],
    };
    const rc = generateReleaseRc(config.streams[0]!, config);
    expect(rc.tagFormat).toBe("v${version}");
    expect(rc.branches).toEqual([
      { name: "develop", prerelease: "dev", channel: "dev" },
      { name: "staging", prerelease: "rc", channel: "rc" },
      { name: "main" },
    ]);
  });

  it("filters release: none branches out of the branches array", () => {
    const config: FlywheelConfig = {
      streams: [
        {
          name: "main-line",
          branches: [
            { name: "develop", release: "none", auto_merge: ["fix"] },
            { name: "staging", release: "prerelease", suffix: "rc", auto_merge: ["fix"] },
            { name: "main", release: "production", auto_merge: [] },
          ],
        },
      ],
    };
    const rc = generateReleaseRc(config.streams[0]!, config);
    expect(rc.branches).toEqual([
      { name: "staging", prerelease: "rc", channel: "rc" },
      { name: "main" },
    ]);
  });

  it("secondary stream gets prefixed tagFormat", () => {
    const config: FlywheelConfig = {
      streams: [
        {
          name: "main-line",
          branches: [{ name: "main", release: "production", auto_merge: [] }],
        },
        {
          name: "customer-acme",
          branches: [
            { name: "customer-acme", release: "prerelease", suffix: "acme", auto_merge: ["fix"] },
          ],
        },
      ],
    };
    const rc = generateReleaseRc(config.streams[1]!, config);
    expect(rc.tagFormat).toBe("customer-acme/v${version}");
  });

  it("single-branch stream with prerelease declared as a normal release branch (no semantic-release prerelease flag)", () => {
    const config: FlywheelConfig = {
      streams: [
        {
          name: "main-line",
          branches: [{ name: "main", release: "production", auto_merge: [] }],
        },
        {
          name: "customer-acme",
          branches: [
            { name: "customer-acme", release: "prerelease", suffix: "acme", auto_merge: ["fix"] },
          ],
        },
      ],
    };
    const rc = generateReleaseRc(config.streams[1]!, config);
    expect(rc.branches).toEqual([{ name: "customer-acme" }]);
  });

  it("plugin list matches spec: no @semantic-release/npm; CHANGELOG.md asset for git plugin", () => {
    const config: FlywheelConfig = {
      streams: [
        {
          name: "only",
          branches: [{ name: "main", release: "production", auto_merge: [] }],
        },
      ],
    };
    const rc = generateReleaseRc(config.streams[0]!, config);
    expect(rc.plugins).toEqual([
      "@semantic-release/commit-analyzer",
      [
        "@semantic-release/release-notes-generator",
        { writerOpts: { finalizeContext: expect.any(String) } },
      ],
      "@semantic-release/changelog",
      "@semantic-release/exec",
      ["@semantic-release/git", { assets: ["CHANGELOG.md"], message: GIT_MESSAGE }],
      "@semantic-release/github",
    ]);
  });

  it("@semantic-release/git message override drops [skip ci]", () => {
    const config: FlywheelConfig = {
      streams: [
        {
          name: "only",
          branches: [{ name: "main", release: "production", auto_merge: [] }],
        },
      ],
    };
    const rc = generateReleaseRc(config.streams[0]!, config);
    const gitEntry = rc.plugins.find(
      (p): p is [string, { assets: string[]; message: string }] =>
        Array.isArray(p) && p[0] === "@semantic-release/git",
    );
    expect(gitEntry).toBeDefined();
    expect(gitEntry![1].message).toBe(GIT_MESSAGE);
    expect(gitEntry![1].message).not.toContain("[skip ci]");
  });

  describe("release_files", () => {
    const baseConfig: FlywheelConfig = {
      streams: [
        {
          name: "main-line",
          branches: [{ name: "main", release: "production", auto_merge: [] }],
        },
      ],
    };

    it("absent → plugin chain unchanged from default", () => {
      const rc = generateReleaseRc(baseConfig.streams[0]!, baseConfig);
      expect(rc.plugins).toEqual([
        "@semantic-release/commit-analyzer",
        [
          "@semantic-release/release-notes-generator",
          { writerOpts: { finalizeContext: expect.any(String) } },
        ],
        "@semantic-release/changelog",
        "@semantic-release/exec",
        ["@semantic-release/git", { assets: ["CHANGELOG.md"], message: GIT_MESSAGE }],
        "@semantic-release/github",
      ]);
    });

    it("declarative entry → exec plugin gets sed prepareCmd; file added to git assets", () => {
      const rc = generateReleaseRc(
        baseConfig.streams[0]!,
        {
          ...baseConfig,
          release_files: [
            {
              path: "pubspec.yaml",
              pattern: "^version: .*",
              replacement: "version: ${version}+${build}",
            },
          ],
        },
        7,
      );
      expect(rc.plugins).toContainEqual([
        "@semantic-release/exec",
        {
          prepareCmd:
            "sed -i.bak -E 's|^version: .*|version: ${nextRelease.version}+7|' " +
            "'pubspec.yaml' && rm 'pubspec.yaml.bak'",
        },
      ]);
      expect(rc.plugins).toContainEqual([
        "@semantic-release/git",
        { assets: ["CHANGELOG.md", "pubspec.yaml"], message: GIT_MESSAGE },
      ]);
    });

    it("exec entry → adopter cmd preserved verbatim except for placeholder substitution", () => {
      const rc = generateReleaseRc(baseConfig.streams[0]!, {
        ...baseConfig,
        release_files: [
          { path: "pyproject.toml", cmd: 'python bump.py "${version}" "${channel}"' },
        ],
      });
      expect(rc.plugins).toContainEqual([
        "@semantic-release/exec",
        {
          prepareCmd:
            "python bump.py \"${nextRelease.version}\" \"${nextRelease.channel || ''}\"",
        },
      ]);
    });

    it("multiple entries (mixed forms) → single exec plugin, &&-chained, all paths in git assets", () => {
      const rc = generateReleaseRc(
        baseConfig.streams[0]!,
        {
          ...baseConfig,
          release_files: [
            {
              path: "pubspec.yaml",
              pattern: "^version: .*",
              replacement: "version: ${version}+${build}",
            },
            { path: "scripts/bump.sh", cmd: 'echo "${version}" > VERSION' },
          ],
        },
        42,
      );
      const execEntries = rc.plugins.filter(
        (p) => Array.isArray(p) && p[0] === "@semantic-release/exec",
      );
      expect(execEntries).toHaveLength(1);
      const prepareCmd = (execEntries[0] as [string, { prepareCmd: string }])[1]
        .prepareCmd;
      expect(prepareCmd).toContain("sed -i.bak -E");
      expect(prepareCmd).toContain("+42|");
      expect(prepareCmd).toContain('echo "${nextRelease.version}" > VERSION');
      expect(rc.plugins).toContainEqual([
        "@semantic-release/git",
        {
          assets: ["CHANGELOG.md", "pubspec.yaml", "scripts/bump.sh"],
          message: GIT_MESSAGE,
        },
      ]);
    });

    // Regression for #95: previously rendered `${BUILD}` into prepareCmd and
    // relied on a bash-assigned $BUILD to satisfy it at runtime. semantic-release's
    // @semantic-release/exec runs the cmd through lodash.template, whose
    // hardcoded ES-template pass evaluates ${BUILD} as a JS expression and
    // ReferenceErrors before bash ever sees it.
    it("${build} is inlined as a literal integer (not ${BUILD} bash variable)", () => {
      const rc = generateReleaseRc(
        baseConfig.streams[0]!,
        {
          ...baseConfig,
          release_files: [
            {
              path: "pubspec.yaml",
              pattern: "^version: .*",
              replacement: "version: ${version}+${build}",
            },
          ],
        },
        12,
      );
      const execEntry = rc.plugins.find(
        (p): p is [string, { prepareCmd: string }] =>
          Array.isArray(p) && p[0] === "@semantic-release/exec",
      )!;
      expect(execEntry[1].prepareCmd).not.toContain("${BUILD}");
      expect(execEntry[1].prepareCmd).not.toContain("BUILD=");
      expect(execEntry[1].prepareCmd).toContain("+12|");
    });

    it("throws when ${build} is referenced but no buildNumber is supplied", () => {
      expect(() =>
        generateReleaseRc(baseConfig.streams[0]!, {
          ...baseConfig,
          release_files: [
            {
              path: "pubspec.yaml",
              pattern: "^version: .*",
              replacement: "version: ${version}+${build}",
            },
          ],
        }),
      ).toThrow(/\$\{build\}/);
    });

    it("buildNumber is not required when no entry references ${build}", () => {
      expect(() =>
        generateReleaseRc(baseConfig.streams[0]!, {
          ...baseConfig,
          release_files: [
            { path: "version.txt", pattern: "^.*$", replacement: "${version}" },
          ],
        }),
      ).not.toThrow();
    });

    it("git assets dedupe: file already in default assets is not duplicated", () => {
      const rc = generateReleaseRc(baseConfig.streams[0]!, {
        ...baseConfig,
        release_files: [
          {
            path: "CHANGELOG.md",
            pattern: "^## .*",
            replacement: "## ${version}",
          },
        ],
      });
      expect(rc.plugins).toContainEqual([
        "@semantic-release/git",
        { assets: ["CHANGELOG.md"], message: GIT_MESSAGE },
      ]);
    });

    it("channel placeholder maps to ${nextRelease.channel || ''} (not just ${nextRelease.channel})", () => {
      const rc = generateReleaseRc(baseConfig.streams[0]!, {
        ...baseConfig,
        release_files: [
          {
            path: "version.txt",
            pattern: "^.*$",
            replacement: "${version}-${channel}",
          },
        ],
      });
      const execEntry = rc.plugins.find(
        (p): p is [string, { prepareCmd: string }] =>
          Array.isArray(p) && p[0] === "@semantic-release/exec",
      )!;
      expect(execEntry[1].prepareCmd).toContain("${nextRelease.channel || ''}");
      expect(execEntry[1].prepareCmd).not.toContain("${nextRelease.channel}-");
    });

    // The next block is the shell-safety contract for the declarative form
    // (issue #164). The sed program is single-quoted (so $, `, ", \ in the
    // pattern/replacement stay literal), sed-replacement metacharacters & and
    // \ are escaped, and the path is single-quoted. The ${nextRelease.*}
    // Lodash tokens still expand because @semantic-release/exec runs Lodash
    // before the shell.
    describe("shell-safety of declarative entries (#164)", () => {
      const getPrepareCmd = (config: FlywheelConfig, buildNumber?: number): string => {
        const rc = generateReleaseRc(config.streams[0]!, config, buildNumber);
        const exec = rc.plugins.find(
          (p): p is [string, { prepareCmd: string }] =>
            Array.isArray(p) && p[0] === "@semantic-release/exec",
        )!;
        return exec[1].prepareCmd;
      };

      it("emits a single-quoted sed program (not double-quoted)", () => {
        const cmd = getPrepareCmd({
          ...baseConfig,
          release_files: [
            { path: "VERSION", pattern: "old", replacement: "new" },
          ],
        });
        expect(cmd).toContain("sed -i.bak -E 's|old|new|' 'VERSION'");
        expect(cmd).not.toContain('"s|');
      });

      it("single-quotes the path so spaces and metacharacters are literal", () => {
        const cmd = getPrepareCmd({
          ...baseConfig,
          release_files: [
            { path: "some dir/my file.txt", pattern: "x", replacement: "y" },
          ],
        });
        expect(cmd).toContain("'some dir/my file.txt'");
        expect(cmd).toContain("rm 'some dir/my file.txt.bak'");
      });

      it("escapes & in the replacement so it does not expand to the whole match", () => {
        const cmd = getPrepareCmd({
          ...baseConfig,
          release_files: [
            { path: "f", pattern: "old", replacement: "a & b" },
          ],
        });
        expect(cmd).toContain("'s|old|a \\& b|'");
      });

      it("escapes \\ in the replacement so it is not a sed escape", () => {
        const cmd = getPrepareCmd({
          ...baseConfig,
          release_files: [
            { path: "f", pattern: "old", replacement: "a\\nb" },
          ],
        });
        // user `\` → sed `\\` (literal backslash) so the output is `a\nb`,
        // not a newline.
        expect(cmd).toContain("'s|old|a\\\\nb|'");
      });

      it("leaves $ literal inside the single-quoted sed program (no shell expansion)", () => {
        const cmd = getPrepareCmd({
          ...baseConfig,
          release_files: [
            { path: "f", pattern: "old", replacement: "price $5" },
          ],
        });
        expect(cmd).toContain("'s|old|price $5|'");
      });

      it("escapes a literal single-quote in pattern/replacement/path", () => {
        const cmd = getPrepareCmd({
          ...baseConfig,
          release_files: [
            {
              path: "it's.txt",
              pattern: "it's",
              replacement: "wasn't",
            },
          ],
        });
        // Each ' breaks out of the surrounding '…' with the '\'' incantation.
        expect(cmd).toContain("'s|it'\\''s|wasn'\\''t|'");
        expect(cmd).toContain("'it'\\''s.txt'");
        expect(cmd).toContain("'it'\\''s.txt.bak'");
      });

      // End-to-end proof: actually run the emitted command and verify the
      // file content is exactly what the user wrote, character for character.
      // Use a placeholder-free entry so the prepareCmd is pure shell (no
      // Lodash template tokens left to expand). Per CLAUDE.md, this is
      // release-path code — worth executing, not just asserting on strings.
      it("the emitted command edits the file literally — &, $, \\, ', spaces all preserved", () => {
        const dir = mkdtempSync(join(tmpdir(), "flywheel-rc-"));
        const file = join(dir, "version with space.txt");
        writeFileSync(file, "VERSION = old\n");
        const cmd = getPrepareCmd({
          ...baseConfig,
          release_files: [
            {
              path: file,
              pattern: "old",
              replacement: "release & build \\o/ \"$HOME\" 'quoted'",
            },
          ],
        });
        execFileSync("sh", ["-c", cmd]);
        expect(readFileSync(file, "utf8")).toBe(
          "VERSION = release & build \\o/ \"$HOME\" 'quoted'\n",
        );
      });
    });
  });

  it("branches array preserves declaration order", () => {
    const config: FlywheelConfig = {
      streams: [
        {
          name: "only",
          branches: [
            { name: "third", release: "prerelease", suffix: "c", auto_merge: ["fix"] },
            { name: "first", release: "prerelease", suffix: "a", auto_merge: ["fix"] },
            { name: "second", release: "production", auto_merge: [] },
          ],
        },
      ],
    };
    const rc = generateReleaseRc(config.streams[0]!, config);
    expect(rc.branches.map((b) => b.name)).toEqual(["third", "first", "second"]);
  });

  describe("release_as_draft (per-branch)", () => {
    // Mixed-mode topology: develop publishes immediately, main is opted in.
    // Each release-rc generation targets exactly one branch — semantic-release
    // runs once per push — so the draft flag we resolve depends on which
    // branch generateReleaseRc was called for, not on the config as a whole.
    const mixedConfig: FlywheelConfig = {
      streams: [
        {
          name: "main-line",
          branches: [
            { name: "develop", release: "prerelease", suffix: "dev", auto_merge: ["fix"] },
            { name: "main", release: "production", release_as_draft: true, auto_merge: [] },
          ],
        },
      ],
    };

    it("targeting an opted-in branch → @semantic-release/github gets { draftRelease: true }", () => {
      const rc = generateReleaseRc(mixedConfig.streams[0]!, mixedConfig, undefined, "main");
      const githubEntry = rc.plugins.find(
        (p): p is [string, { draftRelease: boolean }] =>
          Array.isArray(p) && p[0] === "@semantic-release/github",
      );
      expect(githubEntry).toBeDefined();
      expect(githubEntry![1]).toEqual({ draftRelease: true });
      // Bare-string form must be gone — duplicate entries would confuse
      // semantic-release.
      expect(rc.plugins).not.toContain("@semantic-release/github");
    });

    it("targeting an opted-out branch in the same config → @semantic-release/github is a bare string", () => {
      const rc = generateReleaseRc(mixedConfig.streams[0]!, mixedConfig, undefined, "develop");
      expect(rc.plugins).toContain("@semantic-release/github");
      expect(
        rc.plugins.some(
          (p) => Array.isArray(p) && p[0] === "@semantic-release/github",
        ),
      ).toBe(false);
    });

    it("targetBranchName omitted → no branch is opted in (back-compat for callers pre-dating the parameter)", () => {
      const rc = generateReleaseRc(mixedConfig.streams[0]!, mixedConfig);
      expect(rc.plugins).toContain("@semantic-release/github");
      expect(
        rc.plugins.some(
          (p) => Array.isArray(p) && p[0] === "@semantic-release/github",
        ),
      ).toBe(false);
    });

    it("explicit release_as_draft: false on a branch → @semantic-release/github is a bare string", () => {
      const cfg: FlywheelConfig = {
        streams: [
          {
            name: "main-line",
            branches: [{ name: "main", release: "production", release_as_draft: false, auto_merge: [] }],
          },
        ],
      };
      const rc = generateReleaseRc(cfg.streams[0]!, cfg, undefined, "main");
      expect(rc.plugins).toContain("@semantic-release/github");
      expect(
        rc.plugins.some(
          (p) => Array.isArray(p) && p[0] === "@semantic-release/github",
        ),
      ).toBe(false);
    });

    it("composes with release_files: both github draft and git assets transforms apply", () => {
      const cfg: FlywheelConfig = {
        ...mixedConfig,
        release_files: [
          { path: "package.json", pattern: '"version": ".*"', replacement: '"version": "${version}"' },
        ],
      };
      const rc = generateReleaseRc(cfg.streams[0]!, cfg, undefined, "main");
      // github plugin configured for draft.
      const githubEntry = rc.plugins.find(
        (p): p is [string, { draftRelease: boolean }] =>
          Array.isArray(p) && p[0] === "@semantic-release/github",
      );
      expect(githubEntry![1]).toEqual({ draftRelease: true });
      // git plugin still gets the extra asset path merged in.
      const gitEntry = rc.plugins.find(
        (p): p is [string, { assets: string[]; message: string }] =>
          Array.isArray(p) && p[0] === "@semantic-release/git",
      );
      expect(gitEntry![1].assets).toEqual(["CHANGELOG.md", "package.json"]);
    });

    it("plugin order is unchanged when release_as_draft is set (github is last)", () => {
      const rc = generateReleaseRc(mixedConfig.streams[0]!, mixedConfig, undefined, "main");
      const last = rc.plugins[rc.plugins.length - 1];
      expect(Array.isArray(last) && last[0]).toBe("@semantic-release/github");
    });

    it("opt-in is scoped to the named branch only — other branches in the same stream observe no change", () => {
      // Same stream, two branches, only one opted in. Generating release-rc
      // for the opted-out branch must leave the github plugin untouched
      // (regression guard for SPEC §spec:immutable-release-support: "an
      // adopter who has not opted in on a branch observes no change on
      // that branch whatsoever, even when other branches in the same
      // repository are opted in").
      const rcForDevelop = generateReleaseRc(mixedConfig.streams[0]!, mixedConfig, undefined, "develop");
      const rcForMain = generateReleaseRc(mixedConfig.streams[0]!, mixedConfig, undefined, "main");
      expect(rcForDevelop.plugins).toContain("@semantic-release/github");
      expect(rcForMain.plugins).not.toContain("@semantic-release/github");
    });
  });
});

describe("chooseTagFormat — edge cases", () => {
  it("with zero terminal-production streams, the first declared stream is primary", () => {
    const streams = [
      {
        name: "alpha",
        branches: [
          { name: "alpha", release: "prerelease" as const, suffix: "a", auto_merge: ["fix"] },
        ],
      },
      {
        name: "beta",
        branches: [
          { name: "beta", release: "prerelease" as const, suffix: "b", auto_merge: ["fix"] },
        ],
      },
    ];
    expect(chooseTagFormat(streams[0]!, streams)).toBe("v${version}");
    expect(chooseTagFormat(streams[1]!, streams)).toBe("beta/v${version}");
  });

  it("with exactly one terminal-production stream, it wins regardless of declaration order", () => {
    const streams = [
      {
        name: "customer-acme",
        branches: [
          {
            name: "customer-acme",
            release: "prerelease" as const,
            suffix: "acme",
            auto_merge: ["fix"],
          },
        ],
      },
      {
        name: "main-line",
        branches: [
          { name: "develop", release: "prerelease" as const, suffix: "dev", auto_merge: ["fix"] },
          { name: "main", release: "production" as const, auto_merge: [] },
        ],
      },
    ];
    expect(chooseTagFormat(streams[0]!, streams)).toBe("customer-acme/v${version}");
    expect(chooseTagFormat(streams[1]!, streams)).toBe("v${version}");
  });
});

// §spec:release-notes-dedup — the generated release-notes configuration must
// render a clean `closes` list: each closed issue at most once, uniqueness by
// (owner, repository, number), and only references introduced by a closing
// keyword. These tests run a noisy fixture commit through the *actually
// generated* config (serialized to `.releaserc.cjs`, loaded back, and handed to
// the real @semantic-release/release-notes-generator), so they pin the rendered
// output — not just the config shape. No live GitHub access, no e2e load.
describe("release-notes de-duplication (§spec:release-notes-dedup)", () => {
  // Load the writerOpts flywheel actually emits: generate the rc, serialize it
  // exactly as push-flow writes it, load the resulting module, and pull out the
  // release-notes-generator options — real finalizeContext function and all.
  function generatedWriterOpts(): unknown {
    const config: FlywheelConfig = {
      streams: [
        {
          name: "main-line",
          branches: [{ name: "main", release: "production", auto_merge: [] }],
        },
      ],
    };
    const rc = generateReleaseRc(config.streams[0]!, config);
    const loaded = loadReleaseConfig(serializeReleaseRc(rc)) as { plugins: unknown[] };
    const entry = loaded.plugins.find(
      (p): p is [string, { writerOpts: unknown }] =>
        Array.isArray(p) &&
        p[0] === "@semantic-release/release-notes-generator" &&
        typeof p[1] === "object" &&
        p[1] !== null,
    );
    expect(entry, "generator plugin entry must carry an options object").toBeDefined();
    return (entry![1] as { writerOpts: unknown }).writerOpts;
  }

  const REPO = "https://github.com/point-source/flywheel";

  function commit(message: string) {
    return {
      hash: "d363a2f0000000000000000000000000000000000",
      message,
      committerDate: "2024-01-01",
      author: { name: "x", email: "x@example.com" },
      committer: { name: "x", email: "x@example.com" },
    };
  }

  async function render(commits: ReturnType<typeof commit>[]): Promise<string> {
    const writerOpts = generatedWriterOpts();
    return generateNotes(
      { writerOpts },
      {
        cwd: process.cwd(),
        env: {},
        options: { repositoryUrl: REPO },
        lastRelease: { gitTag: "v1.0.0", version: "1.0.0" },
        nextRelease: { gitTag: "v1.1.0", version: "1.1.0", channel: null },
        commits,
        logger: { log: () => undefined, error: () => undefined },
      } as never,
    );
  }

  // One squashed feat whose body repeats `closes #245` seven times (across the
  // squashed sub-commits), closes a same-numbered issue here (#5) and in another
  // repo (other/repo#5), and carries prose non-issue tokens plus bare sub-task
  // numbers — none introduced by a closing keyword.
  const NOISY_SQUASH = [
    "feat: add capability layer (#247)",
    "",
    "* closes #245",
    "* closes #245",
    "* closes #245",
    "* closes #245",
    "* closes #245",
    "* closes #245",
    "* closes #245",
    "* fixes #236 and resolves other/repo#5",
    "* prose about #capability and preflight-#capability and #233-3",
    "* sub-tasks #1 #2 #3 #4 #6 #7 #8 done (#247)",
    "* closes #5",
  ].join("\n");

  // A change with only a bare `(#N)` PR suffix and no closing keyword.
  const BARE_SUFFIX = "fix: unrelated tweak (#264)";

  const count = (haystack: string, needle: string): number =>
    haystack.split(needle).length - 1;

  it("collapses a seven-times-repeated `closes #245` to exactly one entry", async () => {
    const notes = await render([commit(NOISY_SQUASH)]);
    expect(count(notes, "/issues/245)")).toBe(1);
  });

  it("keeps a cross-repo issue distinct from a same-numbered local issue", async () => {
    const notes = await render([commit(NOISY_SQUASH)]);
    expect(notes).toContain("other/repo/issues/5)");
    expect(notes).toContain("point-source/flywheel/issues/5)");
  });

  it("renders genuine closing references (Closes/Fixes/Resolves)", async () => {
    const notes = await render([commit(NOISY_SQUASH)]);
    expect(notes).toContain(", closes");
    expect(notes).toContain("/issues/245)");
    expect(notes).toContain("/issues/236)");
  });

  it("drops non-issue tokens and never emits a garbage issue link", async () => {
    const notes = await render([commit(NOISY_SQUASH)]);
    expect(notes).not.toContain("issues/capability");
    expect(notes).not.toContain("preflight-");
    expect(notes).not.toContain("issues/233-3");
    for (const n of ["1", "2", "3", "4", "6", "7", "8"]) {
      expect(notes, `sub-task #${n} must not render as an issue link`).not.toContain(
        `/issues/${n})`,
      );
    }
    expect(notes).not.toMatch(/github\.com\/[^)\s]*#|github\.com\/preflight-/);
  });

  it("a bare `(#N)` suffix with no closing keyword contributes nothing to closes", async () => {
    const notes = await render([commit(NOISY_SQUASH), commit(BARE_SUFFIX)]);
    // #264 appears only as the inline PR link on its own commit line, never in a
    // closes list.
    expect(count(notes, "/issues/264)")).toBe(1);
    const bareLine = notes.split("\n").find((l) => l.includes("unrelated tweak"));
    expect(bareLine, "bare-suffix commit line must be present").toBeDefined();
    expect(bareLine).not.toContain(", closes");
  });

  it("still shows a change's PR inline on its commit line", async () => {
    const notes = await render([commit(NOISY_SQUASH)]);
    const featLine = notes.split("\n").find((l) => l.includes("add capability layer"));
    expect(featLine).toBeDefined();
    expect(featLine).toContain("/issues/247)");
  });

  it("fails loudly if a config value collides with the finalizeContext sentinel", () => {
    // A branch named exactly the reserved token would otherwise win the
    // first-occurrence sentinel replace and silently corrupt the config.
    const config: FlywheelConfig = {
      streams: [
        {
          name: "main-line",
          branches: [
            { name: "__FLYWHEEL_FINALIZE_CONTEXT__", release: "production", auto_merge: [] },
          ],
        },
      ],
    };
    const rc = generateReleaseRc(config.streams[0]!, config);
    expect(() => serializeReleaseRc(rc)).toThrow(/finalizeContext sentinel/);
  });
});
