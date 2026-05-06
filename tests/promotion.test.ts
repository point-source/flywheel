import { describe, expect, it } from "vitest";

import {
  runPromotion,
  computePendingCommits,
  extractClosesRefs,
  isPromotionPR,
} from "../src/promotion.js";
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
  it("already-promoted commits reachable from target via the merge are not re-promoted", () => {
    // Hybrid-mode scenario: promotion PRs land as true merge commits, so
    // source commits become reachable from target. listBranchCommits walks
    // ancestry, so target's listing includes the merge commit M *and* the
    // underlying source commits A/B/C with their original SHAs.
    //  - develop has A, B, C, D (D landed after the last promotion).
    //  - staging has merge commit M plus A/B/C reachable through it, plus Z.
    //  - Expect pending = [D] via SHA set-difference.
    const sourceCommits = [
      makeCommit("d000000", "feat: D — added widget", date("2026-01-05T10:00:00Z")),
      makeCommit("c000000", "fix: C — fixed bug", date("2026-01-03T10:00:00Z")),
      makeCommit("b000000", "feat: B — new endpoint", date("2026-01-02T10:00:00Z")),
      makeCommit("a000000", "fix: A — small fix", date("2026-01-01T10:00:00Z")),
    ];
    const targetCommits = [
      makeCommit("m000000", "Merge pull request #41 from org/develop", date("2026-01-04T12:00:00Z")),
      makeCommit("c000000", "fix: C — fixed bug", date("2026-01-03T10:00:00Z")),
      makeCommit("b000000", "feat: B — new endpoint", date("2026-01-02T10:00:00Z")),
      makeCommit("a000000", "fix: A — small fix", date("2026-01-01T10:00:00Z")),
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
    // Title-equality fallback: covers cross-stream cherry-picks (different
    // SHA, identical message) and the initial-seed case where streams
    // haven't been promoted yet so SHA equality has no overlap to exploit.
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
    // branches list the same commit at index 0. The fast-path returns []
    // here so we don't try to createPR and 422 on "No commits between". See #71.
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

  it("aggregates Closes refs from each pending sub-PR's body into the promotion PR (#77)", async () => {
    // Sub-PRs land on develop with squash titles like "fix: foo (#NN)" where
    // (#NN) is the sub-PR number GitHub appended on squash. runPromotion
    // fetches each sub-PR's description and pulls Closes/Fixes/Resolves
    // refs out of it, so the promotion PR body lists every issue that
    // should auto-close on the production-branch merge.
    const gh = createFakeGh({
      branchCommits: {
        develop: [
          makeCommit("c1", "fix: a (#72)", date("2026-01-05T10:00:00Z")),
          makeCommit("c2", "fix: b (#73)", date("2026-01-04T10:00:00Z")),
          makeCommit("c3", "fix: c (#75)", date("2026-01-03T10:00:00Z")),
        ],
        staging: [makeCommit("s1", "chore: old", date("2025-12-01T10:00:00Z"))],
      },
      pullBodies: {
        72: "Closes #60",
        73: "Fixes #70 and resolves #99",
        75: "fix(promotion): handle equal-tip\n\nCloses #71",
      },
    });
    const { log } = silentLogger();

    await runPromotion({ branchRef: "develop", config, gh, log });

    const body = gh.createdPRs[0]!.body;
    // Sorted, deduplicated, normalized to "Closes #N" so GitHub auto-close
    // recognizes each one independently when the promotion PR merges.
    expect(body).toContain("Closes #60\nCloses #70\nCloses #71\nCloses #99");
  });

  it("dedups Closes refs that appear in multiple sub-PR bodies", async () => {
    const gh = createFakeGh({
      branchCommits: {
        develop: [
          makeCommit("c1", "fix: a (#72)", date("2026-01-05T10:00:00Z")),
          makeCommit("c2", "fix: b (#73)", date("2026-01-04T10:00:00Z")),
        ],
        staging: [makeCommit("s1", "chore: old", date("2025-12-01T10:00:00Z"))],
      },
      pullBodies: {
        72: "closes #60, fixes #60", // intra-body duplicate
        73: "Closes #60", // cross-body duplicate
      },
    });
    const { log } = silentLogger();

    await runPromotion({ branchRef: "develop", config, gh, log });

    const body = gh.createdPRs[0]!.body;
    const matches = body.match(/Closes #60/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("strips self-references — a sub-PR whose body says 'closes #<itself>' does not appear in the aggregate", async () => {
    const gh = createFakeGh({
      branchCommits: {
        develop: [
          makeCommit("c1", "fix: a (#72)", date("2026-01-05T10:00:00Z")),
        ],
        staging: [makeCommit("s1", "chore: old", date("2025-12-01T10:00:00Z"))],
      },
      pullBodies: {
        72: "Closes #72\nCloses #60", // typo / self-ref + a real one
      },
    });
    const { log } = silentLogger();

    await runPromotion({ branchRef: "develop", config, gh, log });

    const body = gh.createdPRs[0]!.body;
    expect(body).toContain("Closes #60");
    expect(body).not.toContain("Closes #72");
  });

  it("emits no Closes block when no sub-PR body has Closes refs", async () => {
    const gh = createFakeGh({
      branchCommits: {
        develop: [
          makeCommit("c1", "fix: a (#72)", date("2026-01-05T10:00:00Z")),
        ],
        staging: [makeCommit("s1", "chore: old", date("2025-12-01T10:00:00Z"))],
      },
      pullBodies: {
        72: "Just a description, nothing to auto-close.",
      },
    });
    const { log } = silentLogger();

    await runPromotion({ branchRef: "develop", config, gh, log });

    expect(gh.createdPRs[0]!.body).not.toMatch(/Closes #/);
  });

  it("survives a 404 from getPullBody (sub-PR hard-deleted) — promotion PR still upserts", async () => {
    // pullBodies map omits #72, so fakeGh.getPullBody returns null. The
    // production GitHubClient returns null on 404 from octokit. Either
    // way, runPromotion should treat it as "nothing to aggregate" and
    // not fail.
    const gh = createFakeGh({
      branchCommits: {
        develop: [
          makeCommit("c1", "fix: a (#72)", date("2026-01-05T10:00:00Z")),
          makeCommit("c2", "fix: b (#73)", date("2026-01-04T10:00:00Z")),
        ],
        staging: [makeCommit("s1", "chore: old", date("2025-12-01T10:00:00Z"))],
      },
      pullBodies: {
        // 72 omitted — simulates 404
        73: "Fixes #70",
      },
    });
    const { log } = silentLogger();

    const outcome = await runPromotion({ branchRef: "develop", config, gh, log });
    expect(outcome.kind).toBe("created");
    expect(gh.createdPRs[0]!.body).toContain("Closes #70");
  });

  it("ignores commits without a trailing (#NN) — direct-pushed bot commits don't trigger getPullBody", async () => {
    // chore(release) commits and back-merge commits land on the source
    // branch via direct push, so they have no PR number. extractTrailingPrNumber
    // returns null and we skip them.
    const gh = createFakeGh({
      branchCommits: {
        develop: [
          makeCommit("c1", "fix: a (#72)", date("2026-01-05T10:00:00Z")),
          makeCommit("c2", "chore(release): 1.0.1-dev.1", date("2026-01-04T10:00:00Z")),
        ],
        staging: [makeCommit("s1", "chore: old", date("2025-12-01T10:00:00Z"))],
      },
      pullBodies: { 72: "Closes #60" },
    });
    const { log } = silentLogger();

    await runPromotion({ branchRef: "develop", config, gh, log });

    const getCalls = gh.calls.filter((c) => c.method === "getPullBody");
    expect(getCalls).toHaveLength(1);
    expect((getCalls[0]!.args as { prNumber: number }).prNumber).toBe(72);
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

describe("extractClosesRefs — Closes/Fixes/Resolves keyword parsing", () => {
  it("recognizes the closing keywords GitHub recognizes (case-insensitive)", () => {
    expect(extractClosesRefs("Closes #1")).toEqual([1]);
    expect(extractClosesRefs("closes #1")).toEqual([1]);
    expect(extractClosesRefs("CLOSES #1")).toEqual([1]);
    expect(extractClosesRefs("Closed #1")).toEqual([1]);
    expect(extractClosesRefs("Fix #1")).toEqual([1]);
    expect(extractClosesRefs("Fixes #1")).toEqual([1]);
    expect(extractClosesRefs("Fixed #1")).toEqual([1]);
    expect(extractClosesRefs("Resolve #1")).toEqual([1]);
    expect(extractClosesRefs("Resolves #1")).toEqual([1]);
    expect(extractClosesRefs("Resolved #1")).toEqual([1]);
  });

  it("accepts the colon variant (Closes: #1)", () => {
    expect(extractClosesRefs("Closes: #42")).toEqual([42]);
  });

  it("returns refs in encounter order, including duplicates (caller handles dedup)", () => {
    expect(
      extractClosesRefs("Closes #3, fixes #1, resolves #2, closes #1"),
    ).toEqual([3, 1, 2, 1]);
  });

  it("ignores cross-repo refs (owner/repo#N) — out of scope to propagate", () => {
    expect(extractClosesRefs("Closes octo-org/octo-repo#100")).toEqual([]);
  });

  it("does not match keywords inside other words", () => {
    // 'preclosed' should not trigger; word boundary required.
    expect(extractClosesRefs("Preclosed #5")).toEqual([]);
    // 'closeness' — also not a keyword.
    expect(extractClosesRefs("closeness #5")).toEqual([]);
  });

  it("returns [] for null or empty bodies", () => {
    expect(extractClosesRefs(null)).toEqual([]);
    expect(extractClosesRefs("")).toEqual([]);
  });
});
