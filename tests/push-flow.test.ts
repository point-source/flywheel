import { describe, expect, it } from "vitest";

import { getUpstreamBranches, runPushFlow } from "../src/push-flow.js";
import type { FlywheelConfig } from "../src/types.js";

const config: FlywheelConfig = {
  streams: [
    {
      name: "main-line",
      branches: [
        { name: "develop", release: "prerelease", suffix: "dev", auto_merge: ["fix"] },
        { name: "main", release: "production", auto_merge: [] },
      ],
    },
    {
      name: "customer-acme",
      branches: [
        { name: "customer-acme", release: "prerelease", suffix: "acme", auto_merge: ["fix"] },
      ],
    },
  ],
  merge_strategy: "squash",
};

describe("runPushFlow", () => {
  it("unmanaged branch → no .releaserc written, outcome is unmanaged", async () => {
    const writes: Array<{ path: string; contents: string }> = [];
    const outcome = await runPushFlow({
      branchRef: "feature/sandbox",
      config,
      workspace: "/ws",
      log: { info: () => undefined },
      writer: async (path, contents) => {
        writes.push({ path, contents });
      },
    });
    expect(outcome).toEqual({ kind: "unmanaged", reason: "branch-not-in-stream" });
    expect(writes).toEqual([]);
  });

  it("managed branch → writes .releaserc.json with the correct stream's config", async () => {
    const writes: Array<{ path: string; contents: string }> = [];
    const outcome = await runPushFlow({
      branchRef: "develop",
      config,
      workspace: "/ws",
      log: { info: () => undefined },
      writer: async (path, contents) => {
        writes.push({ path, contents });
      },
    });
    expect(outcome.kind).toBe("release");
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path).toBe("/ws/.releaserc.json");
    const rc = JSON.parse(writes[0]!.contents);
    expect(rc.tagFormat).toBe("v${version}");
    expect(rc.branches).toEqual([
      { name: "develop", prerelease: "dev", channel: "dev" },
      { name: "main" },
    ]);
  });

  it("managed branch in secondary stream → prefixed tagFormat", async () => {
    const writes: Array<{ path: string; contents: string }> = [];
    await runPushFlow({
      branchRef: "customer-acme",
      config,
      workspace: "/ws",
      log: { info: () => undefined },
      writer: async (path, contents) => {
        writes.push({ path, contents });
      },
    });
    const rc = JSON.parse(writes[0]!.contents);
    expect(rc.tagFormat).toBe("customer-acme/v${version}");
    expect(rc.branches).toEqual([{ name: "customer-acme" }]);
  });

  it("committed .releaserc.json → release outcome, writer not called", async () => {
    const writes: Array<{ path: string; contents: string }> = [];
    const outcome = await runPushFlow({
      branchRef: "develop",
      config,
      workspace: "/ws",
      log: { info: () => undefined },
      writer: async (path, contents) => {
        writes.push({ path, contents });
      },
      rcExists: async (path) => path === "/ws/.releaserc.json",
    });
    expect(outcome).toEqual({
      kind: "release",
      stream: config.streams[0],
      rcPath: "/ws/.releaserc.json",
    });
    expect(writes).toEqual([]);
  });

  it("no committed .releaserc.json → writer is called (rcExists returns false)", async () => {
    const writes: Array<{ path: string; contents: string }> = [];
    const outcome = await runPushFlow({
      branchRef: "develop",
      config,
      workspace: "/ws",
      log: { info: () => undefined },
      writer: async (path, contents) => {
        writes.push({ path, contents });
      },
      rcExists: async () => false,
    });
    expect(outcome.kind).toBe("release");
    expect(writes).toHaveLength(1);
  });

  it("release: none branch → promote-only outcome, no .releaserc written", async () => {
    const promoteOnlyConfig: FlywheelConfig = {
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
      merge_strategy: "squash",
    };
    const writes: Array<{ path: string; contents: string }> = [];
    const outcome = await runPushFlow({
      branchRef: "develop",
      config: promoteOnlyConfig,
      workspace: "/ws",
      log: { info: () => undefined },
      writer: async (path, contents) => {
        writes.push({ path, contents });
      },
    });
    expect(outcome.kind).toBe("promote-only");
    expect(writes).toEqual([]);
  });
});

describe("getUpstreamBranches", () => {
  const threeStage: FlywheelConfig = {
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
    merge_strategy: "squash",
  };

  it("terminal branch → returns all earlier branches in stream order", () => {
    expect(getUpstreamBranches(threeStage, "main")).toEqual(["develop", "staging"]);
  });

  it("middle branch → returns only branches earlier than itself", () => {
    expect(getUpstreamBranches(threeStage, "staging")).toEqual(["develop"]);
  });

  it("first branch in stream → returns empty (no upstream)", () => {
    expect(getUpstreamBranches(threeStage, "develop")).toEqual([]);
  });

  it("single-branch stream → returns empty", () => {
    expect(getUpstreamBranches(config, "customer-acme")).toEqual([]);
  });

  it("unmanaged branch → returns empty", () => {
    expect(getUpstreamBranches(config, "feature/sandbox")).toEqual([]);
  });
});
