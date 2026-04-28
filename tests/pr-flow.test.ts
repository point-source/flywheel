import { describe, expect, it } from "vitest";

import { runPrFlow } from "../src/pr-flow.js";
import {
  FLYWHEEL_AUTO_MERGE_LABEL,
  FLYWHEEL_NEEDS_REVIEW_LABEL,
  type PullRequest,
} from "../src/github.js";
import type { FlywheelConfig } from "../src/types.js";
import { createFakeGh, makeCommit, silentLogger } from "./helpers/fakeGh.js";

const baseConfig: FlywheelConfig = {
  streams: [
    {
      name: "main-line",
      branches: [
        {
          name: "develop",
          prerelease: "dev",
          auto_merge: ["fix", "fix!", "chore", "feat", "perf", "refactor", "style", "test", "docs"],
        },
        { name: "main", auto_merge: [] },
      ],
    },
  ],
  merge_strategy: "squash",
  initial_version: "0.1.0",
};

function makePR(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 7,
    title: "fix(auth): handle token refresh race condition",
    body: "old body",
    baseRef: "develop",
    headRef: "feature/x",
    headSha: "abcdef01234567890abcdef01234567890abcdef",
    nodeId: "PR_node_7",
    labels: [],
    draft: false,
    ...overrides,
  };
}

describe("runPrFlow", () => {
  it("happy path: fix targeting develop → auto-merge label, native auto-merge enabled, body rewritten", async () => {
    const gh = createFakeGh({
      pullCommits: {
        7: [
          makeCommit("aaaaaaa", "fix(auth): handle token refresh race condition"),
          makeCommit("bbbbbbb", "chore: update dep"),
        ],
      },
    });
    const { log } = silentLogger();

    const outcome = await runPrFlow({ pr: makePR(), config: baseConfig, gh, log });

    expect(outcome).toMatchObject({ kind: "labeled", label: FLYWHEEL_AUTO_MERGE_LABEL, autoMergeEnabled: true });
    expect(gh.prLabels[7]).toContain(FLYWHEEL_AUTO_MERGE_LABEL);
    expect(gh.autoMergeEnabledFor).toContain("PR_node_7");
    const updateCall = gh.calls.find((c) => c.method === "updatePR");
    expect(updateCall).toBeDefined();
    const updateArgs = updateCall!.args as { number: number; fields: { title?: string; body?: string } };
    expect(updateArgs.fields.body).toContain("**Increment type:** patch");
    expect(updateArgs.fields.body).toContain("### fix");
    expect(updateArgs.fields.body).toContain("### chore");
  });

  it("breaking change in commit body upgrades increment to major even though title is plain fix", async () => {
    const gh = createFakeGh({
      pullCommits: {
        7: [
          makeCommit("aaaaaaa", "fix(auth): renamed env var\n\nBREAKING CHANGE: AUTH_KEY renamed to AUTH_TOKEN"),
        ],
      },
    });
    const { log } = silentLogger();

    const outcome = await runPrFlow({ pr: makePR(), config: baseConfig, gh, log });

    expect(outcome).toMatchObject({ kind: "labeled", label: FLYWHEEL_AUTO_MERGE_LABEL });
    const updateCall = gh.calls.find((c) => c.method === "updatePR")!;
    const args = updateCall.args as { fields: { title?: string; body?: string } };
    expect(args.fields.title).toBe("fix(auth)!: handle token refresh race condition");
    expect(args.fields.body).toContain("**Increment type:** major");
    expect(args.fields.body).toContain("BREAKING CHANGE");
  });

  it("feat targeting main (auto_merge: []) → needs-review label, no auto-merge call", async () => {
    const gh = createFakeGh({ pullCommits: { 7: [makeCommit("a", "feat: shiny new thing")] } });
    const { log } = silentLogger();

    const outcome = await runPrFlow({
      pr: makePR({ title: "feat: shiny new thing", baseRef: "main" }),
      config: baseConfig,
      gh,
      log,
    });

    expect(outcome).toMatchObject({ kind: "labeled", label: FLYWHEEL_NEEDS_REVIEW_LABEL });
    expect(gh.prLabels[7]).toContain(FLYWHEEL_NEEDS_REVIEW_LABEL);
    expect(gh.autoMergeEnabledFor).toEqual([]);
  });

  it("label flip: PR previously labeled auto-merge but now needs review removes the old label and disables auto-merge", async () => {
    const gh = createFakeGh({
      pullCommits: { 7: [makeCommit("a", "feat: drop")] },
      prLabels: { 7: [FLYWHEEL_AUTO_MERGE_LABEL] },
    });
    const { log } = silentLogger();

    await runPrFlow({
      pr: makePR({
        title: "feat!: drop API v1",
        baseRef: "main",
        labels: [FLYWHEEL_AUTO_MERGE_LABEL],
      }),
      config: baseConfig,
      gh,
      log,
    });

    expect(gh.prLabels[7]).toContain(FLYWHEEL_NEEDS_REVIEW_LABEL);
    expect(gh.prLabels[7]).not.toContain(FLYWHEEL_AUTO_MERGE_LABEL);
    expect(gh.autoMergeDisabledFor).toContain("PR_node_7");
  });

  it("auto-merge fallback: GraphQL refusal logs warning and continues with label intact", async () => {
    const gh = createFakeGh({
      pullCommits: { 7: [makeCommit("a", "fix: x")] },
      enableAutoMergeResponse: { ok: false, reason: "Auto merge is not allowed for this repository" },
    });
    const { log, warnings } = silentLogger();

    const outcome = await runPrFlow({ pr: makePR(), config: baseConfig, gh, log });

    expect(outcome).toMatchObject({
      kind: "labeled",
      label: FLYWHEEL_AUTO_MERGE_LABEL,
      autoMergeEnabled: false,
    });
    expect(gh.prLabels[7]).toContain(FLYWHEEL_AUTO_MERGE_LABEL);
    expect(warnings.some((w) => w.includes("could not enable native auto-merge"))).toBe(true);
  });

  it("unmanaged base ref → no-op: no API calls beyond an info log", async () => {
    const gh = createFakeGh();
    const { log } = silentLogger();

    const outcome = await runPrFlow({
      pr: makePR({ baseRef: "experimental/sandbox" }),
      config: baseConfig,
      gh,
      log,
    });

    expect(outcome).toEqual({ kind: "unmanaged" });
    expect(gh.calls).toEqual([]);
  });

  it("invalid title posts a failing check and signals parse-failed", async () => {
    const gh = createFakeGh();
    const { log } = silentLogger();

    const outcome = await runPrFlow({
      pr: makePR({ title: "totally not conventional" }),
      config: baseConfig,
      gh,
      log,
    });

    expect(outcome).toEqual({ kind: "parse-failed" });
    expect(gh.createdChecks).toHaveLength(1);
    expect(gh.createdChecks[0]!.conclusion).toBe("failure");
    expect(gh.createdChecks[0]!.headSha).toMatch(/^abcdef/);
  });

  it("does not call updatePR when title and body are already correct", async () => {
    const idempotentTitle = "fix: handle token refresh race condition";
    const gh = createFakeGh({
      pullCommits: { 7: [makeCommit("a", idempotentTitle)] },
    });
    const { log } = silentLogger();

    // First run captures the rewritten body.
    await runPrFlow({
      pr: makePR({ title: idempotentTitle, body: null }),
      config: baseConfig,
      gh,
      log,
    });
    const firstUpdate = gh.calls.find((c) => c.method === "updatePR");
    const writtenBody = (firstUpdate!.args as { fields: { body?: string } }).fields.body!;

    const gh2 = createFakeGh({
      pullCommits: { 7: [makeCommit("a", idempotentTitle)] },
    });
    await runPrFlow({
      pr: makePR({ title: idempotentTitle, body: writtenBody }),
      config: baseConfig,
      gh: gh2,
      log,
    });
    const update2 = gh2.calls.find((c) => c.method === "updatePR");
    expect(update2).toBeUndefined();
  });
});
