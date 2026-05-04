import { describe, expect, it } from "vitest";

import { generateReleaseRc, chooseTagFormat } from "../src/release-rc.js";
import type { FlywheelConfig } from "../src/types.js";

const baseRc = {
  merge_strategy: "squash" as const,
  initial_version: "0.1.0",
};

describe("generateReleaseRc", () => {
  it("primary stream (terminal prerelease: false) gets v${version}", () => {
    const config: FlywheelConfig = {
      ...baseRc,
      streams: [
        {
          name: "main-line",
          branches: [
            { name: "develop", prerelease: "dev", auto_merge: ["fix"] },
            { name: "staging", prerelease: "rc", auto_merge: ["fix"] },
            { name: "main", auto_merge: [] },
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

  it("secondary stream gets prefixed tagFormat", () => {
    const config: FlywheelConfig = {
      ...baseRc,
      streams: [
        {
          name: "main-line",
          branches: [{ name: "main", auto_merge: [] }],
        },
        {
          name: "customer-acme",
          branches: [{ name: "customer-acme", prerelease: "acme", auto_merge: ["fix"] }],
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
          branches: [{ name: "main", auto_merge: [] }],
        },
        {
          name: "customer-acme",
          branches: [{ name: "customer-acme", prerelease: "acme", auto_merge: ["fix"] }],
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
          branches: [{ name: "main", auto_merge: [] }],
        },
      ],
    };
    const rc = generateReleaseRc(config.streams[0]!, config);
    expect(rc.plugins).toEqual([
      "@semantic-release/commit-analyzer",
      "@semantic-release/release-notes-generator",
      "@semantic-release/changelog",
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
            { name: "third", prerelease: "c", auto_merge: ["fix"] },
            { name: "first", prerelease: "a", auto_merge: ["fix"] },
            { name: "second", auto_merge: [] },
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
      { name: "alpha", branches: [{ name: "alpha", prerelease: "a", auto_merge: ["fix"] }] },
      { name: "beta", branches: [{ name: "beta", prerelease: "b", auto_merge: ["fix"] }] },
    ];
    expect(chooseTagFormat(streams[0]!, streams)).toBe("v${version}");
    expect(chooseTagFormat(streams[1]!, streams)).toBe("beta/v${version}");
  });

  it("with exactly one terminal-production stream, it wins regardless of declaration order", () => {
    const streams = [
      { name: "customer-acme", branches: [{ name: "customer-acme", prerelease: "acme", auto_merge: ["fix"] }] },
      {
        name: "main-line",
        branches: [
          { name: "develop", prerelease: "dev", auto_merge: ["fix"] },
          { name: "main", auto_merge: [] },
        ],
      },
    ];
    expect(chooseTagFormat(streams[0]!, streams)).toBe("customer-acme/v${version}");
    expect(chooseTagFormat(streams[1]!, streams)).toBe("v${version}");
  });
});
