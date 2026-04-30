import { describe, expect, it } from "vitest";

import { runPromotion, computePendingCommits } from "../src/promotion.js";
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
          prerelease: "dev",
          auto_merge: ["fix", "fix!", "feat", "chore"],
        },
        {
          name: "staging",
          prerelease: "rc",
          auto_merge: ["fix", "chore"],
        },
        { name: "main", auto_merge: [] },
      ],
    },
    {
      name: "customer-acme",
      branches: [
        { name: "customer-acme", prerelease: "acme", auto_merge: ["fix"] },
      ],
    },
  ],
  merge_strategy: "squash",
  initial_version: "0.1.0",
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

  it("rebase-merged already-promoted commits do not reappear (titles match exactly)", () => {
    // With rebase merge, source commit titles propagate verbatim to target.
    const sourceCommits = [
      makeCommit("a", "fix: shared title", date("2026-01-01T10:00:00Z")),
      makeCommit("b", "feat: only on source", date("2026-01-02T10:00:00Z")),
    ];
    const targetCommits = [
      makeCommit("a-rebased", "fix: shared title", date("2026-01-01T11:00:00Z")),
    ];

    const pending = computePendingCommits({
      sourceCommits,
      targetCommits,
      sourceName: "develop",
      targetName: "staging",
    });

    expect(pending.map((c) => c.title)).toEqual(["feat: only on source"]);
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
});
