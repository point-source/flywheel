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

  it("auto-merge declines (clean PR, no required checks) → direct-merge fallback succeeds", async () => {
    const gh = createFakeGh({
      pullCommits: { 7: [makeCommit("a", "fix: x")] },
      enableAutoMergeResponse: { ok: false, reason: "Pull request is in clean status" },
      // mergePRResponse defaults to { ok: true, sha: "merged..." }
    });
    const { log } = silentLogger();

    const outcome = await runPrFlow({ pr: makePR(), config: baseConfig, gh, log });

    expect(outcome).toMatchObject({
      kind: "labeled",
      label: FLYWHEEL_AUTO_MERGE_LABEL,
      autoMergeEnabled: false,
      merged: true,
    });
    expect(gh.prLabels[7]).toContain(FLYWHEEL_AUTO_MERGE_LABEL);
    expect(gh.directMergedPRs).toContain(7);
  });

  it("auto-merge AND direct-merge both fail → labeled, not merged, warning logged", async () => {
    const gh = createFakeGh({
      pullCommits: { 7: [makeCommit("a", "fix: x")] },
      enableAutoMergeResponse: { ok: false, reason: "Auto merge is not allowed for this repository" },
      mergePRResponse: { ok: false, reason: "Required status check 'build' is missing", status: 405 },
    });
    const { log, warnings } = silentLogger();

    const outcome = await runPrFlow({ pr: makePR(), config: baseConfig, gh, log });

    expect(outcome).toMatchObject({
      kind: "labeled",
      label: FLYWHEEL_AUTO_MERGE_LABEL,
      autoMergeEnabled: false,
      merged: false,
    });
    expect(gh.prLabels[7]).toContain(FLYWHEEL_AUTO_MERGE_LABEL);
    expect(gh.directMergedPRs).not.toContain(7);
    expect(warnings.some((w) => w.includes("native auto-merge and direct merge both failed"))).toBe(true);
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

  it("label flip: PR previously labeled needs-review now eligible (retitled feat: → fix:) → label flipped, auto-merge enabled", async () => {
    const gh = createFakeGh({
      pullCommits: { 7: [makeCommit("a", "fix: actually a fix")] },
      prLabels: { 7: [FLYWHEEL_NEEDS_REVIEW_LABEL] },
    });
    const { log } = silentLogger();

    await runPrFlow({
      pr: makePR({
        title: "fix: actually a fix",
        labels: [FLYWHEEL_NEEDS_REVIEW_LABEL],
      }),
      config: baseConfig,
      gh,
      log,
    });

    expect(gh.prLabels[7]).toContain(FLYWHEEL_AUTO_MERGE_LABEL);
    expect(gh.prLabels[7]).not.toContain(FLYWHEEL_NEEDS_REVIEW_LABEL);
    expect(gh.autoMergeEnabledFor).toContain("PR_node_7");
    expect(gh.autoMergeDisabledFor).toEqual([]);
  });

  it("label flip with stale pr.labels: input pr does NOT include needs-review but real state does → still removes it", async () => {
    // Regression: GitHub's labels endpoint can serve a slightly outdated
    // read after a recent write. Previously runPrFlow gated the
    // removeLabel call on `pr.labels.includes(...)`; if the input pr was
    // stale, the gate was false and the wrong label stuck forever.
    const gh = createFakeGh({
      pullCommits: { 7: [makeCommit("a", "fix: actually a fix")] },
      // Real state on the server: needs-review IS attached.
      prLabels: { 7: [FLYWHEEL_NEEDS_REVIEW_LABEL] },
    });
    const { log } = silentLogger();

    await runPrFlow({
      // Input pr: stale read — labels missing the needs-review entry.
      pr: makePR({ title: "fix: actually a fix", labels: [] }),
      config: baseConfig,
      gh,
      log,
    });

    expect(gh.prLabels[7]).toContain(FLYWHEEL_AUTO_MERGE_LABEL);
    expect(gh.prLabels[7]).not.toContain(FLYWHEEL_NEEDS_REVIEW_LABEL);
    // Confirm removeLabel was actually issued (not skipped by stale gate).
    const removeCalls = gh.calls.filter(
      (c) => c.method === "removeLabel"
        && (c.args as { label: string }).label === FLYWHEEL_NEEDS_REVIEW_LABEL,
    );
    expect(removeCalls).toHaveLength(1);
  });

  it("idempotent across two consecutive runs against the same fakeGh — final state matches first run, no extra updatePR", async () => {
    const gh = createFakeGh({
      pullCommits: { 7: [makeCommit("a", "fix(auth): handle token refresh race condition")] },
    });
    const { log } = silentLogger();

    const initialPr = makePR();
    await runPrFlow({ pr: initialPr, config: baseConfig, gh, log });

    const writtenTitle = gh.prTitles[7] ?? initialPr.title;
    const writtenBody = gh.prBodies[7] ?? initialPr.body;
    const labelsAfterRun1 = [...(gh.prLabels[7] ?? [])];

    // Simulate GitHub returning the post-run-1 state on a retry.
    const updatedPr = {
      ...initialPr,
      title: writtenTitle,
      body: writtenBody,
      labels: labelsAfterRun1,
    };
    await runPrFlow({ pr: updatedPr, config: baseConfig, gh, log });

    // State idempotency: labels are the AUTO_MERGE singleton, no duplication or flip.
    expect(gh.prLabels[7]).toEqual([FLYWHEEL_AUTO_MERGE_LABEL]);
    // Title/body unchanged from run-1 result.
    expect(gh.prTitles[7] ?? writtenTitle).toBe(writtenTitle);
    expect(gh.prBodies[7] ?? writtenBody).toBe(writtenBody);
    // Body-rewrite idempotency: updatePR only fired on run 1.
    expect(gh.calls.filter((c) => c.method === "updatePR")).toHaveLength(1);
    // The eligible path always issues removeLabel(NEEDS_REVIEW) defensively
    // (404-tolerant) to avoid stale-read bugs. Never removes AUTO_MERGE
    // or disables auto-merge on the eligible path.
    const removeAutoMergeCalls = gh.calls.filter(
      (c) => c.method === "removeLabel"
        && (c.args as { label: string }).label === FLYWHEEL_AUTO_MERGE_LABEL,
    );
    expect(removeAutoMergeCalls).toEqual([]);
    expect(gh.autoMergeDisabledFor).toEqual([]);
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
