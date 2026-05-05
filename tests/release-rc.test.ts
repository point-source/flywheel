import { describe, expect, it } from "vitest";

import { generateReleaseRc, chooseTagFormat } from "../src/release-rc.js";
import type { FlywheelConfig } from "../src/types.js";

const baseRc = {
  merge_strategy: "squash" as const,
};

// Override of @semantic-release/git's default message: drops the `[skip ci]`
// token the plugin would otherwise append. See src/release-rc.ts for the why.
const GIT_MESSAGE =
  "chore(release): ${nextRelease.version}\n\n${nextRelease.notes}";

describe("generateReleaseRc", () => {
  it("default plugin chain includes @semantic-release/exec for committed-rc adopters", () => {
    const config: FlywheelConfig = {
      ...baseRc,
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
      ...baseRc,
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
      ...baseRc,
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
      ...baseRc,
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
      ...baseRc,
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
      ...baseRc,
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
      ...baseRc,
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
      ...baseRc,
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
      const rc = generateReleaseRc(baseConfig.streams[0]!, {
        ...baseConfig,
        release_files: [
          {
            path: "pubspec.yaml",
            pattern: "^version: .*",
            replacement: "version: ${version}+${build}",
          },
        ],
      });
      expect(rc.plugins).toContainEqual([
        "@semantic-release/exec",
        {
          prepareCmd:
            "BUILD=$(( $(git tag --list 'v*' | wc -l) + 1 )) && " +
            'sed -i.bak -E "s|^version: .*|version: ${nextRelease.version}+${BUILD}|" pubspec.yaml && ' +
            "rm pubspec.yaml.bak",
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
            "BUILD=$(( $(git tag --list 'v*' | wc -l) + 1 )) && " +
            "python bump.py \"${nextRelease.version}\" \"${nextRelease.channel || ''}\"",
        },
      ]);
    });

    it("multiple entries (mixed forms) → single exec plugin, &&-chained, all paths in git assets", () => {
      const rc = generateReleaseRc(baseConfig.streams[0]!, {
        ...baseConfig,
        release_files: [
          {
            path: "pubspec.yaml",
            pattern: "^version: .*",
            replacement: "version: ${version}+${build}",
          },
          { path: "scripts/bump.sh", cmd: 'echo "${version}" > VERSION' },
        ],
      });
      const execEntries = rc.plugins.filter(
        (p) => Array.isArray(p) && p[0] === "@semantic-release/exec",
      );
      expect(execEntries).toHaveLength(1);
      const prepareCmd = (execEntries[0] as [string, { prepareCmd: string }])[1]
        .prepareCmd;
      expect(prepareCmd).toMatch(/^BUILD=\$\(\( \$\(git tag --list 'v\*'.*\) \+ 1 \)\) && /);
      expect(prepareCmd).toContain("sed -i.bak -E");
      expect(prepareCmd).toContain('echo "${nextRelease.version}" > VERSION');
      expect(rc.plugins).toContainEqual([
        "@semantic-release/git",
        {
          assets: ["CHANGELOG.md", "pubspec.yaml", "scripts/bump.sh"],
          message: GIT_MESSAGE,
        },
      ]);
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
  });

  it("branches array preserves declaration order", () => {
    const config: FlywheelConfig = {
      ...baseRc,
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
