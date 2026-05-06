import { describe, expect, it } from "vitest";

import { runPromotion, computePendingCommits, isPromotionPR } from "../src/promotion.js";
import {
  FLYWHEEL_AUTO_MERGE_LABEL,
  FLYWHEEL_NEEDS_REVIEW_LABEL,
} from "../src/github.js";
import type { FlywheelConfig } from "../src/types.js";
import { createFakeGh, makeCommit, silentLogger } from "./helpers/fakeGh.js";

const config: FlywheelConfig = {
  streams: [
    {
      name: "main-line",
      branches: [
        {
          name: "develop",
          release: "prerelease",
          suffix: "dev",
          auto_merge: ["fix", "fix!", "feat", "chore"],
        },
        {
          name: "staging",
          release: "prerelease",
          suffix: "rc",
          auto_merge: ["fix", "chore"],
        },
        { name: "main", release: "production", auto_merge: [] },
      ],
    },
    {
      name: "customer-acme",
      branches: [
        {
          name: "customer-acme",
          release: "prerelease",
          suffix: "acme",
          auto_merge: ["fix"],
        },
      ],
    },
  ],
};

const date = (iso: string) => iso;

describe("computePendingCommits — the highest-stakes logic", () => {
  it("squash-merged already-promoted commits do NOT reappear as pending", () => {
    // Scenario:
    //  - develop has feature commits A (2026-01-01), B (2026-01-02), C (2026-01-03)
    //  - promotion PR squashed onto staging on 2026-01-04 → staging gets ONE commit P with title
    //    "feat: promote develop → staging" (the underlying feature commits do NOT propagate).
    //  - On 2026-01-05, commit D lands on develop.
    //  - We expect the next pending detection to return ONLY D, not A/B/C/D.
    const sourceCommits = [
      makeCommit("d000000", "feat: D — added widget", date("2026-01-05T10:00:00Z")),
      makeCommit("c000000", "fix: C — fixed bug", date("2026-01-03T10:00:00Z")),
      makeCommit("b000000", "feat: B — new endpoint", date("2026-01-02T10:00:00Z")),
      makeCommit("a000000", "fix: A — small fix", date("2026-01-01T10:00:00Z")),
    ];
    const targetCommits = [
      makeCommit("p000000", "feat: promote develop → staging (#41)", date("2026-01-04T12:00:00Z")),
      makeCommit("z000000", "feat: previous staging commit", date("2025-12-30T10:00:00Z")),
    ];

    const pending = computePendingCommits({
      sourceCommits,
      targetCommits,
      sourceName: "develop",
      targetName: "staging",
    });

    expect(pending.map((c) => c.sha)).toEqual(["d000000"]);
  });

  it("already-promoted commits with identical titles on target are not re-promoted", () => {
    // Title-equality dedup: covers cherry-picks across streams, identical
    // chore/lint titles produced independently on each side, and (under
    // hybrid mode) source commits made reachable on target via a merge.
    const sourceCommits = [
      makeCommit("a", "fix: shared title", date("2026-01-01T10:00:00Z")),
      makeCommit("b", "feat: only on source", date("2026-01-02T10:00:00Z")),
    ];
    const targetCommits = [
      makeCommit("a-on-target", "fix: shared title", date("2026-01-01T11:00:00Z")),
    ];

    const pending = computePendingCommits({
      sourceCommits,
      targetCommits,
      sourceName: "develop",
      targetName: "staging",
    });

    expect(pending.map((c) => c.title)).toEqual(["feat: only on source"]);
  });

  it("equal source/target tips → no pending (fast-path for post-back-merge state)", () => {
    // After a release back-merge, develop fast-forwards to main's tip. Both
    // branches list the same commit at index 0. Strategy A/B can disagree
    // here; the fast-path returns [] before either runs. See #71.
    const sharedTip = makeCommit("aaaabbb", "chore(release): 1.0.0", date("2026-01-04T10:00:00Z"));
    const sourceCommits = [
      sharedTip,
      makeCommit("c000000", "feat: earlier", date("2026-01-03T10:00:00Z")),
    ];
    const targetCommits = [
      sharedTip,
      makeCommit("c000000", "feat: earlier", date("2026-01-03T10:00:00Z")),
    ];
    const pending = computePendingCommits({
      sourceCommits,
      targetCommits,
      sourceName: "develop",
      targetName: "main",
    });
    expect(pending).toEqual([]);
  });

  it("identical-titled cherry-picks across unrelated streams don't false-match (we scope to source/target only)", () => {
    // computePendingCommits only takes source and target — it doesn't see other streams,
    // so this is a property of the API not the algorithm. Verify by giving identical titles.
    const sourceCommits = [makeCommit("s", "fix: same wording")];
    const targetCommits = [makeCommit("t", "fix: same wording")];

    const pending = computePendingCommits({
      sourceCommits,
      targetCommits,
      sourceName: "src",
      targetName: "tgt",
    });
    expect(pending).toEqual([]);
  });

  it("strips GitHub's (#NN) PR-number suffix when comparing titles (initial seed case)", () => {
    const sourceCommits = [makeCommit("s", "feat: shiny thing")];
    const targetCommits = [makeCommit("t", "feat: shiny thing (#42)")];

    const pending = computePendingCommits({
      sourceCommits,
      targetCommits,
      sourceName: "develop",
      targetName: "staging",
    });
    expect(pending).toEqual([]);
  });
});

describe("runPromotion — orchestration", () => {
  it("non-bumping pending list (only chore/style/docs) → no PR upserted", async () => {
    const gh = createFakeGh({
      branchCommits: {
        develop: [
          makeCommit("c1", "chore: bump dep", date("2026-01-05T10:00:00Z")),
          makeCommit("c2", "style: lint fixes", date("2026-01-04T10:00:00Z")),
        ],
        staging: [
          makeCommit("s1", "feat: previous", date("2025-12-01T10:00:00Z")),
        ],
      },
    });
    const { log } = silentLogger();

    const outcome = await runPromotion({ branchRef: "develop", config, gh, log });

    expect(outcome).toEqual({ kind: "no-bumping" });
    expect(gh.createdPRs).toEqual([]);
  });

  it("creates a promotion PR with correct most-impactful type label and auto-merge eligibility", async () => {
    const gh = createFakeGh({
      branchCommits: {
        develop: [
          makeCommit("c1", "fix: small fix", date("2026-01-05T10:00:00Z")),
          makeCommit("c2", "feat: bigger feature", date("2026-01-04T10:00:00Z")),
        ],
        staging: [makeCommit("s1", "chore: old", date("2025-12-01T10:00:00Z"))],
      },
    });
    const { log } = silentLogger();

    const outcome = await runPromotion({ branchRef: "develop", config, gh, log });

    expect(outcome.kind).toBe("created");
    expect(gh.createdPRs).toHaveLength(1);
    expect(gh.createdPRs[0]!.title).toBe("feat: promote develop → staging");
    // staging.auto_merge does not include 'feat' → needs-review.
    expect(gh.prLabels[999]).toContain(FLYWHEEL_NEEDS_REVIEW_LABEL);
    expect(gh.autoMergeEnabledFor).toEqual([]);
  });

  it("auto-merge label and native auto-merge enabled when most-impactful type IS in target.auto_merge", async () => {
    const gh = createFakeGh({
      branchCommits: {
        develop: [
          makeCommit("c1", "fix: small fix", date("2026-01-05T10:00:00Z")),
        ],
        staging: [makeCommit("s1", "chore: old", date("2025-12-01T10:00:00Z"))],
      },
    });
    const { log } = silentLogger();

    await runPromotion({ branchRef: "develop", config, gh, log });

    expect(gh.createdPRs[0]!.title).toBe("fix: promote develop → staging");
    expect(gh.prLabels[999]).toContain(FLYWHEEL_AUTO_MERGE_LABEL);
    expect(gh.autoMergeEnabledFor).toContain("PR_node_999");
  });

  it("promotion PRs always request MERGE (true merge commit) for auto-merge", async () => {
    const gh = createFakeGh({
      branchCommits: {
        develop: [
          makeCommit("c1", "fix: small fix", date("2026-01-05T10:00:00Z")),
        ],
        staging: [makeCommit("s1", "chore: old", date("2025-12-01T10:00:00Z"))],
      },
    });
    const { log } = silentLogger();

    await runPromotion({ branchRef: "develop", config, gh, log });

    const enableCall = gh.calls.find((c) => c.method === "enableAutoMerge");
    expect(enableCall).toBeDefined();
    expect((enableCall!.args as { method: string }).method).toBe("MERGE");
  });

  it("breaking change in pending → title gets `!`, label tier evaluated for `feat!`", async () => {
    const gh = createFakeGh({
      branchCommits: {
        develop: [
          makeCommit(
            "c1",
            "feat: drop legacy API\n\nBREAKING CHANGE: removed /v1",
            date("2026-01-05T10:00:00Z"),
          ),
        ],
        staging: [makeCommit("s1", "chore: old", date("2025-12-01T10:00:00Z"))],
      },
    });
    const { log } = silentLogger();

    await runPromotion({ branchRef: "develop", config, gh, log });
    expect(gh.createdPRs[0]!.title).toBe("feat!: promote develop → staging");
  });

  it("existing open promotion PR is updated, not duplicated", async () => {
    const gh = createFakeGh({
      branchCommits: {
        develop: [makeCommit("c1", "fix: x", date("2026-01-05T10:00:00Z"))],
        staging: [makeCommit("s1", "chore: old", date("2025-12-01T10:00:00Z"))],
      },
      openPRs: {
        "develop->staging": [
          {
            number: 17,
            nodeId: "PR_node_17",
            title: "fix: promote develop → staging",
            body: "stale body",
          },
        ],
      },
    });
    const { log } = silentLogger();

    const outcome = await runPromotion({ branchRef: "develop", config, gh, log });

    expect(outcome.kind).toBe("updated");
    expect(gh.createdPRs).toEqual([]);
    const update = gh.calls.find((c) => c.method === "updatePR");
    expect(update).toBeDefined();
    expect(gh.prLabels[17]).toContain(FLYWHEEL_AUTO_MERGE_LABEL);
  });

  it("terminal branch in stream → no promotion PR", async () => {
    const gh = createFakeGh();
    const { log } = silentLogger();

    const outcome = await runPromotion({ branchRef: "main", config, gh, log });
    expect(outcome).toEqual({ kind: "terminal" });
    expect(gh.calls.find((c) => c.method === "listBranchCommits")).toBeUndefined();
  });

  it("single-branch stream's only branch is also terminal → no promotion PR", async () => {
    const gh = createFakeGh();
    const { log } = silentLogger();

    const outcome = await runPromotion({ branchRef: "customer-acme", config, gh, log });
    expect(outcome).toEqual({ kind: "terminal" });
  });

  it("unmanaged branch → no-op", async () => {
    const gh = createFakeGh();
    const { log } = silentLogger();

    const outcome = await runPromotion({ branchRef: "feature/sandbox", config, gh, log });
    expect(outcome).toEqual({ kind: "unmanaged" });
    expect(gh.calls).toEqual([]);
  });

  it("createPR 422 'No commits between' → in-sync outcome, no throw (#71)", async () => {
    // Force pending detection to think there are pending commits even though
    // GitHub's compare view says otherwise. The createPR call then 422s, and
    // runPromotion must treat that as a no-op.
    const gh = createFakeGh({
      branchCommits: {
        develop: [
          makeCommit("c1", "feat: pending", date("2026-01-05T10:00:00Z")),
        ],
        staging: [makeCommit("s1", "chore: old", date("2025-12-01T10:00:00Z"))],
      },
    });
    gh.createPR = async () => {
      throw Object.assign(
        new Error(
          'Validation Failed: {"resource":"PullRequest","code":"custom","message":"No commits between staging and develop"}',
        ),
        { status: 422 },
      );
    };
    const { log } = silentLogger();

    const outcome = await runPromotion({ branchRef: "develop", config, gh, log });

    expect(outcome).toEqual({ kind: "in-sync" });
    expect(gh.createdPRs).toEqual([]);
  });

  it("createPR errors other than 422 'No commits between' still propagate", async () => {
    const gh = createFakeGh({
      branchCommits: {
        develop: [makeCommit("c1", "feat: pending", date("2026-01-05T10:00:00Z"))],
        staging: [makeCommit("s1", "chore: old", date("2025-12-01T10:00:00Z"))],
      },
    });
    gh.createPR = async () => {
      throw Object.assign(new Error("Internal Server Error"), { status: 500 });
    };
    const { log } = silentLogger();

    await expect(
      runPromotion({ branchRef: "develop", config, gh, log }),
    ).rejects.toThrow(/Internal Server Error/);
  });
});

describe("isPromotionPR — promotion PR detection used by pr-flow short-circuit", () => {
  it("matches the canonical develop → main fix-typed promotion title", () => {
    expect(isPromotionPR(config, "develop", "main", "fix: promote develop → main")).toBe(false);
    // ^ develop → main is not adjacent in this fixture (staging is between).
    expect(isPromotionPR(config, "staging", "main", "fix: promote staging → main")).toBe(true);
    expect(isPromotionPR(config, "develop", "staging", "fix: promote develop → staging")).toBe(true);
  });

  it("accepts any conventional commit type prefix and breaking marker", () => {
    expect(isPromotionPR(config, "staging", "main", "feat!: promote staging → main")).toBe(true);
    expect(isPromotionPR(config, "staging", "main", "chore(release): promote staging → main")).toBe(true);
  });

  it("rejects when head/base are not a configured promotion edge even if title matches", () => {
    expect(isPromotionPR(config, "feature/x", "main", "fix: promote develop → main")).toBe(false);
    // staging → develop reverses the edge direction.
    expect(isPromotionPR(config, "staging", "develop", "fix: promote staging → develop")).toBe(false);
    // customer-acme is a single-branch stream — no promotion edges out of it.
    expect(isPromotionPR(config, "customer-acme", "main", "fix: promote customer-acme → main")).toBe(false);
  });

  it("rejects when edge matches but title is not a promotion shape", () => {
    expect(isPromotionPR(config, "staging", "main", "fix: regular bug fix")).toBe(false);
    expect(isPromotionPR(config, "staging", "main", "promote staging → main")).toBe(false);
    expect(isPromotionPR(config, "staging", "main", "fix: promote main → staging")).toBe(false);
  });
});
