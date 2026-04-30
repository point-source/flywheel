import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SANDBOX_OWNER,
  SANDBOX_REPO,
  sandboxGh,
  sandboxOctokit,
  hasSandboxToken,
} from "../../integration/helpers/sandbox-client.js";
import { createTestPR, uniqueBranch } from "../../integration/helpers/test-pr.js";
import { registerForTeardown, runTeardown } from "../../integration/helpers/teardown.js";
import { pollUntil } from "../helpers/poll-until.js";
import { mergePR } from "../helpers/sandbox-e2e.js";
import { snapshotRunIds, waitForRunAfter } from "../helpers/run-baseline.js";

// e2e-staging → e2e-main is the cleanest place to assert upsert behavior:
// e2e-main has auto_merge: [], so a fix-titled promotion PR stays open
// long enough for the second merge's push run to update it (rather than
// auto-merging away in between).
const E2E_STAGING = "e2e-staging";
const E2E_MAIN = "e2e-main";

async function closeOpenPromotionPRs(head: string, base: string): Promise<void> {
  const open = await sandboxGh().listOpenPRs({ head, base });
  for (const pr of open) {
    await sandboxOctokit().rest.pulls.update({
      owner: SANDBOX_OWNER,
      repo: SANDBOX_REPO,
      pull_number: pr.number,
      state: "closed",
    });
  }
}

describe.skipIf(!hasSandboxToken)("e2e/07: promotion PR upserts (accumulates) across two merges", () => {
  beforeEach(async () => {
    // Start from a clean staging→main slate so the first PR detection is
    // unambiguous and the second merge's upsert is visible.
    await closeOpenPromotionPRs(E2E_STAGING, E2E_MAIN);
  });
  afterEach(async () => {
    await runTeardown();
  });

  it("two sequential fix merges produce one promotion PR with both commits in body", async () => {
    const priorPromotions = await sandboxGh().listOpenPRs({
      head: E2E_STAGING,
      base: E2E_MAIN,
    });
    const priorNumbers = new Set(priorPromotions.map((p) => p.number));

    // First merge.
    const baselineA = await snapshotRunIds([E2E_STAGING]);
    const branchA = uniqueBranch("e2e-accum-a");
    const prA = await createTestPR({
      branch: branchA,
      base: E2E_STAGING,
      title: "fix: accumulate first commit",
    });
    registerForTeardown({ branch: branchA, prNumber: prA.number });
    await mergePR(prA.number, "squash");
    await waitForRunAfter("flywheel-push.yml", E2E_STAGING, baselineA.get(E2E_STAGING)!.push, {
      timeoutMs: 180_000,
    });

    const firstPR = (
      await pollUntil(
        async () => sandboxGh().listOpenPRs({ head: E2E_STAGING, base: E2E_MAIN }),
        (prs) => prs.some((p) => !priorNumbers.has(p.number)),
        {
          intervalMs: 3000,
          timeoutMs: 90_000,
          description: "first staging→main promotion PR to appear",
        },
      )
    ).find((p) => !priorNumbers.has(p.number))!;
    registerForTeardown({ prNumber: firstPR.number });

    // Second merge.
    const baselineB = await snapshotRunIds([E2E_STAGING]);
    const branchB = uniqueBranch("e2e-accum-b");
    const prB = await createTestPR({
      branch: branchB,
      base: E2E_STAGING,
      title: "fix: accumulate second commit",
    });
    registerForTeardown({ branch: branchB, prNumber: prB.number });
    await mergePR(prB.number, "squash");
    await waitForRunAfter("flywheel-push.yml", E2E_STAGING, baselineB.get(E2E_STAGING)!.push, {
      timeoutMs: 180_000,
    });

    const updated = await pollUntil(
      async () => sandboxGh().listOpenPRs({ head: E2E_STAGING, base: E2E_MAIN }),
      (prs) => {
        const same = prs.find((p) => p.number === firstPR.number);
        return Boolean(
          same && same.body && /accumulate first/.test(same.body) && /accumulate second/.test(same.body),
        );
      },
      {
        intervalMs: 3000,
        timeoutMs: 90_000,
        description: "promotion PR body to contain both commit titles",
      },
    );

    const same = updated.find((p) => p.number === firstPR.number);
    expect(same).toBeDefined();
    expect(same!.body ?? "").toMatch(/accumulate first/);
    expect(same!.body ?? "").toMatch(/accumulate second/);

    const newOnes = updated.filter((p) => !priorNumbers.has(p.number));
    expect(newOnes).toHaveLength(1);
  });
});
