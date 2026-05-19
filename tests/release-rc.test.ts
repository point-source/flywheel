import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { generateReleaseRc, chooseTagFormat } from "../src/release-rc.js";
import type { FlywheelConfig } from "../src/types.js";

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
      "@semantic-release/release-notes-generator",
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
        "@semantic-release/release-notes-generator",
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
