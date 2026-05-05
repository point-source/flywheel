import { describe, expect, it } from "vitest";

import { generateReleaseRc, chooseTagFormat } from "../src/release-rc.js";
import type { FlywheelConfig } from "../src/types.js";

const baseRc = {
  merge_strategy: "squash" as const,
};

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
      ["@semantic-release/git", { assets: ["CHANGELOG.md"] }],
      "@semantic-release/github",
    ]);
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
