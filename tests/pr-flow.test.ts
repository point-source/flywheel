import { describe, expect, it } from "vitest";

import { FLYWHEEL_TITLE_CHECK, isCleanStatusDecline, runPrFlow } from "../src/pr-flow.js";
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
          release: "prerelease",
          suffix: "dev",
          auto_merge: ["fix", "fix!", "chore", "feat", "perf", "refactor", "style", "test", "docs"],
        },
        { name: "main", release: "production", auto_merge: [] },
      ],
    },
  ],
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

  it("feature PRs into a stream branch always request SQUASH auto-merge", async () => {
    const gh = createFakeGh({
      pullCommits: { 7: [makeCommit("aaaaaaa", "fix: x")] },
    });
    const { log } = silentLogger();

    await runPrFlow({ pr: makePR(), config: baseConfig, gh, log });

    const enableCall = gh.calls.find((c) => c.method === "enableAutoMerge");
    expect(enableCall).toBeDefined();
    expect((enableCall!.args as { method: string }).method).toBe("SQUASH");
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

  it("non-benign auto-merge decline (allow_auto_merge disabled) → NO direct merge, label kept, warning", async () => {
    // allow_auto_merge=false declines enablePullRequestAutoMerge even though
    // the adopter has required checks. Direct-merging here would bypass those
    // checks via the App's ruleset bypass, so pr-flow must not fall through.
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
      merged: false,
    });
    expect(gh.prLabels[7]).toContain(FLYWHEEL_AUTO_MERGE_LABEL);
    expect(gh.calls.some((c) => c.method === "mergePR")).toBe(false);
    expect(gh.directMergedPRs).not.toContain(7);
    expect(warnings.some((w) => w.includes("not a benign clean-status decline"))).toBe(true);
  });

  it("clean-status decline + direct merge fails → labeled, not merged, warning logged", async () => {
    const gh = createFakeGh({
      pullCommits: { 7: [makeCommit("a", "fix: x")] },
      enableAutoMergeResponse: { ok: false, reason: "Pull request is in clean status" },
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
    expect(gh.directMergedPRs).not.toContain(7);
    expect(warnings.some((w) => w.includes("direct merge failed"))).toBe(true);
  });

  it("schedules native auto-merge BEFORE posting the conventional-commit check", async () => {
    // The PR must still be `blocked` (check unreported) when auto-merge is
    // scheduled, or GitHub refuses it as already-clean. See #147.
    const gh = createFakeGh({ pullCommits: { 7: [makeCommit("a", "fix: x")] } });
    const { log } = silentLogger();

    await runPrFlow({ pr: makePR(), config: baseConfig, gh, log });

    const enableIdx = gh.calls.findIndex((c) => c.method === "enableAutoMerge");
    const checkIdx = gh.calls.findIndex(
      (c) => c.method === "createCheck" && (c.args as { name?: string }).name === FLYWHEEL_TITLE_CHECK,
    );
    expect(enableIdx).toBeGreaterThanOrEqual(0);
    expect(checkIdx).toBeGreaterThan(enableIdx);
  });

  it("needs-review PR still posts a passing conventional-commit check", async () => {
    const gh = createFakeGh({ pullCommits: { 7: [makeCommit("a", "feat: x")] } });
    const { log } = silentLogger();

    await runPrFlow({
      pr: makePR({ title: "feat: x", baseRef: "main" }),
      config: baseConfig,
      gh,
      log,
    });

    expect(gh.createdChecks.find((c) => c.name === FLYWHEEL_TITLE_CHECK)).toMatchObject({
      name: FLYWHEEL_TITLE_CHECK,
      conclusion: "success",
    });
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

  it("skip-ci marker in PR title fails the check before any rewrite or labeling", async () => {
    const gh = createFakeGh({
      pullCommits: { 7: [makeCommit("aaaaaaa", "fix: clean commit")] },
    });
    const { log } = silentLogger();

    const outcome = await runPrFlow({
      pr: makePR({ title: "fix: handle race [skip ci]" }),
      config: baseConfig,
      gh,
      log,
    });

    expect(outcome).toEqual({ kind: "skip-ci-found" });
    expect(gh.createdChecks).toHaveLength(1);
    expect(gh.createdChecks[0]!.conclusion).toBe("failure");
    expect(gh.createdChecks[0]!.details).toContain("PR title");
    expect(gh.createdChecks[0]!.details).toContain("[skip ci]");
    expect(gh.prLabels[7] ?? []).toEqual([]);
  });

  it("skip-ci marker in PR body fails the check", async () => {
    const gh = createFakeGh({
      pullCommits: { 7: [makeCommit("aaaaaaa", "fix: clean commit")] },
    });
    const { log } = silentLogger();

    const outcome = await runPrFlow({
      pr: makePR({ body: "Notes: [ci skip] for this rollout" }),
      config: baseConfig,
      gh,
      log,
    });

    expect(outcome).toEqual({ kind: "skip-ci-found" });
    expect(gh.createdChecks[0]!.details).toContain("PR body");
  });

  it("skip-ci marker in a commit title fails the check", async () => {
    const gh = createFakeGh({
      pullCommits: {
        7: [
          makeCommit("aaaaaaa", "fix: legitimate"),
          makeCommit("bbbbbbb", "chore: bumped [no ci]"),
        ],
      },
    });
    const { log } = silentLogger();

    const outcome = await runPrFlow({
      pr: makePR(),
      config: baseConfig,
      gh,
      log,
    });

    expect(outcome).toEqual({ kind: "skip-ci-found" });
    expect(gh.createdChecks[0]!.details).toMatch(/commit \w+ title/);
  });

  it("skip-ci marker in a commit body fails the check", async () => {
    const gh = createFakeGh({
      pullCommits: {
        7: [makeCommit("aaaaaaa", "fix: legitimate\n\nBody line\n[skip actions] suppressed.")],
      },
    });
    const { log } = silentLogger();

    const outcome = await runPrFlow({
      pr: makePR(),
      config: baseConfig,
      gh,
      log,
    });

    expect(outcome).toEqual({ kind: "skip-ci-found" });
    expect(gh.createdChecks[0]!.details).toMatch(/commit \w+ body/);
  });

  it("clean PR with no markers proceeds to label and post a passing check (single check posted)", async () => {
    const gh = createFakeGh({
      pullCommits: { 7: [makeCommit("aaaaaaa", "fix: legitimate")] },
    });
    const { log } = silentLogger();

    await runPrFlow({ pr: makePR(), config: baseConfig, gh, log });

    expect(gh.createdChecks).toHaveLength(1);
    expect(gh.createdChecks[0]!.conclusion).toBe("success");
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

  it("promotion PR (head/base match a stream edge with promote-shaped title) short-circuits: title check posted, no body rewrite, no auto-merge re-enable", async () => {
    // Regression for #78: when runPromotion opens the develop→main PR it
    // configures auto-merge with MERGE method. If pr-flow then runs on the
    // resulting pull_request event and treats it as a feature PR, it
    // re-enables auto-merge with SQUASH — collapsing the v1.0.x changelog
    // on main to a single squash commit. pr-flow must short-circuit.
    const promotionConfig: FlywheelConfig = {
      streams: [
        {
          name: "main-line",
          branches: [
            {
              name: "develop",
              release: "prerelease",
              suffix: "dev",
              auto_merge: ["fix", "feat", "chore"],
            },
            {
              name: "main",
              release: "production",
              auto_merge: ["fix", "feat", "chore"],
            },
          ],
        },
      ],
    };
    const gh = createFakeGh();
    const { log } = silentLogger();

    const outcome = await runPrFlow({
      pr: makePR({
        number: 74,
        title: "fix: promote develop → main",
        baseRef: "main",
        headRef: "develop",
      }),
      config: promotionConfig,
      gh,
      log,
    });

    expect(outcome).toEqual({ kind: "promotion-pr" });
    // Single passing check posted so adopters can require it in branch protection.
    expect(gh.createdChecks).toHaveLength(1);
    expect(gh.createdChecks[0]!.conclusion).toBe("success");
    // No body rewrite (formatPromotionBody is authoritative for promotion PRs).
    expect(gh.calls.find((c) => c.method === "updatePR")).toBeUndefined();
    // No auto-merge re-enable (would have used SQUASH and clobbered MERGE).
    expect(gh.calls.find((c) => c.method === "enableAutoMerge")).toBeUndefined();
    expect(gh.autoMergeEnabledFor).toEqual([]);
    // No label churn — runPromotion owns labels for promotion PRs.
    expect(gh.calls.find((c) => c.method === "addLabels")).toBeUndefined();
  });

  it("back-merge fallback PR (head matches `chore/back-merge-*-into-<base>`) short-circuits: title check posted, no auto-merge, no label churn", async () => {
    // Regression for #120: when push.yml's back-merge fallback opens a PR,
    // pr-flow used to label it `flywheel:auto-merge` and enable SQUASH
    // auto-merge — collapsing the released `chore(release)` commit out of
    // the upstream's ancestry and re-opening the divergence on the next
    // promotion. pr-flow must short-circuit so the PR sits with
    // `flywheel:needs-review` until a human resolves and merge-commits.
    const gh = createFakeGh();
    const { log } = silentLogger();

    const outcome = await runPrFlow({
      pr: makePR({
        number: 99,
        title: "chore: back-merge v1.1.1 from main into develop",
        baseRef: "develop",
        headRef: "chore/back-merge-v1.1.1-into-develop",
      }),
      config: baseConfig,
      gh,
      log,
    });

    expect(outcome).toEqual({ kind: "back-merge-pr" });
    // Conventional-commit success check still posted so branch protection
    // can require it.
    expect(gh.createdChecks).toHaveLength(1);
    expect(gh.createdChecks[0]!.conclusion).toBe("success");
    // No body rewrite — push.yml's resolution instructions must survive.
    expect(gh.calls.find((c) => c.method === "updatePR")).toBeUndefined();
    // No auto-merge — this is the whole point of #120.
    expect(gh.calls.find((c) => c.method === "enableAutoMerge")).toBeUndefined();
    expect(gh.autoMergeEnabledFor).toEqual([]);
    // No label churn — push.yml's `flywheel:needs-review` must persist.
    expect(gh.calls.find((c) => c.method === "addLabels")).toBeUndefined();
    expect(gh.calls.find((c) => c.method === "removeLabel")).toBeUndefined();
  });

  it("back-merge detection requires the deterministic head-branch shape — a manually-named branch with similar title goes through normal flow", async () => {
    // Defensive: title alone is not load-bearing for the short-circuit.
    // A human might write `chore: back-merge ...` for an unrelated change;
    // only push.yml-shaped head refs (`chore/back-merge-*-into-<base>`) get
    // the short-circuit treatment.
    const gh = createFakeGh({
      pullCommits: { 7: [makeCommit("aaaaaaa", "chore: back-merge something")] },
    });
    const { log } = silentLogger();

    const outcome = await runPrFlow({
      pr: makePR({
        title: "chore: back-merge something useful",
        headRef: "feature/manual-back-merge",
        baseRef: "develop",
      }),
      config: baseConfig,
      gh,
      log,
    });

    // Normal flow: chore is in develop's auto_merge list, so this gets
    // labeled and auto-merged like any other chore PR.
    expect(outcome).toMatchObject({ kind: "labeled", label: FLYWHEEL_AUTO_MERGE_LABEL });
  });

  it("promotion PR detection requires both edge match AND promote-shaped title — non-promotion fix from develop into main goes through normal flow", async () => {
    // A plain feature PR that happens to target main from a develop-named
    // local branch must not be misidentified as a promotion PR. Detection
    // hinges on the title matching the runPromotion title shape.
    const promotionConfig: FlywheelConfig = {
      streams: [
        {
          name: "main-line",
          branches: [
            {
              name: "develop",
              release: "prerelease",
              suffix: "dev",
              auto_merge: ["fix"],
            },
            { name: "main", release: "production", auto_merge: ["fix"] },
          ],
        },
      ],
    };
    const gh = createFakeGh({
      pullCommits: { 7: [makeCommit("aaaaaaa", "fix: real fix")] },
    });
    const { log } = silentLogger();

    const outcome = await runPrFlow({
      pr: makePR({
        title: "fix: real fix",
        baseRef: "main",
        headRef: "develop",
      }),
      config: promotionConfig,
      gh,
      log,
    });

    expect(outcome).toMatchObject({ kind: "labeled" });
    expect(gh.calls.some((c) => c.method === "enableAutoMerge")).toBe(true);
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

  it("preserves Closes/Fixes/Resolves trailers from PR body, normalized to `Closes #N`", async () => {
    const gh = createFakeGh({
      pullCommits: { 7: [makeCommit("aaaaaaa", "fix: x")] },
    });
    const { log } = silentLogger();

    await runPrFlow({
      pr: makePR({
        body: "Some context.\n\nFixes #104\nResolves: #112\nclose #99",
      }),
      config: baseConfig,
      gh,
      log,
    });

    const updateCall = gh.calls.find((c) => c.method === "updatePR");
    const body = (updateCall!.args as { fields: { body?: string } }).fields.body!;
    expect(body).toContain("Closes #99");
    expect(body).toContain("Closes #104");
    expect(body).toContain("Closes #112");
    // Normalized to numerically sorted, deduped form.
    const idx99 = body.indexOf("Closes #99");
    const idx104 = body.indexOf("Closes #104");
    const idx112 = body.indexOf("Closes #112");
    expect(idx99).toBeLessThan(idx104);
    expect(idx104).toBeLessThan(idx112);
    // Closes block sits before the metadata footer so aggregateClosesRefs
    // (and humans) can locate it predictably.
    expect(idx112).toBeLessThan(body.indexOf("**Increment type:**"));
  });

  it("Closes-trailer preservation is idempotent across re-runs", async () => {
    const gh = createFakeGh({
      pullCommits: { 7: [makeCommit("aaaaaaa", "fix: x")] },
    });
    const { log } = silentLogger();

    await runPrFlow({
      pr: makePR({ body: "Fixes #104\nCloses #112" }),
      config: baseConfig,
      gh,
      log,
    });
    const writtenBody = (gh.calls.find((c) => c.method === "updatePR")!.args as {
      fields: { body?: string };
    }).fields.body!;

    const gh2 = createFakeGh({
      pullCommits: { 7: [makeCommit("aaaaaaa", "fix: x")] },
    });
    await runPrFlow({
      pr: makePR({ body: writtenBody }),
      config: baseConfig,
      gh: gh2,
      log,
    });

    // Second run sees a body that already contains the rendered output —
    // nothing to update.
    expect(gh2.calls.find((c) => c.method === "updatePR")).toBeUndefined();
  });

  it("dedupes a Closes ref that the contributor wrote multiple times", async () => {
    const gh = createFakeGh({
      pullCommits: { 7: [makeCommit("aaaaaaa", "fix: x")] },
    });
    const { log } = silentLogger();

    await runPrFlow({
      pr: makePR({ body: "Fixes #104\nCloses #104\nresolved #104" }),
      config: baseConfig,
      gh,
      log,
    });

    const body = (gh.calls.find((c) => c.method === "updatePR")!.args as {
      fields: { body?: string };
    }).fields.body!;
    const matches = body.match(/Closes #104/g) ?? [];
    expect(matches).toHaveLength(1);
  });
});

describe("isCleanStatusDecline", () => {
  it("treats the already-mergeable decline as benign", () => {
    expect(isCleanStatusDecline("Pull request is in clean status")).toBe(true);
    expect(isCleanStatusDecline("Pull request is in clean state")).toBe(true);
  });

  it("treats every other decline (and unrecognized messages) as non-benign", () => {
    expect(isCleanStatusDecline("Auto merge is not allowed for this repository")).toBe(false);
    expect(isCleanStatusDecline("Pull request is in unstable status")).toBe(false);
    expect(isCleanStatusDecline("Pull request is in dirty status")).toBe(false);
    expect(isCleanStatusDecline("some unrecognized graphql error")).toBe(false);
    expect(isCleanStatusDecline("")).toBe(false);
  });
});
