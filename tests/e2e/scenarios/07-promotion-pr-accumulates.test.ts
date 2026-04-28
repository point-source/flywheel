import { afterEach, describe, expect, it } from "vitest";

import { sandboxGh, hasSandboxToken } from "../../integration/helpers/sandbox-client.js";
import { createTestPR, uniqueBranch } from "../../integration/helpers/test-pr.js";
import { registerForTeardown, runTeardown } from "../../integration/helpers/teardown.js";
import { pollUntil } from "../helpers/poll-until.js";
import { mergePR } from "../helpers/sandbox-e2e.js";
import { snapshotRunIds, waitForRunAfter } from "../helpers/run-baseline.js";

const E2E_DEVELOP = "e2e-develop";
const E2E_STAGING = "e2e-staging";

describe.skipIf(!hasSandboxToken)("e2e/07: promotion PR upserts (accumulates) across two merges", () => {
  afterEach(async () => {
    await runTeardown();
  });

  it("two sequential fix merges produce one promotion PR with both commits in body", async () => {
    const priorPromotions = await sandboxGh().listOpenPRs({
      head: E2E_DEVELOP,
      base: E2E_STAGING,
    });
    const priorNumbers = new Set(priorPromotions.map((p) => p.number));

    // First merge.
    const baselineA = await snapshotRunIds([E2E_DEVELOP]);
    const branchA = uniqueBranch("e2e-accum-a");
    const prA = await createTestPR({
      branch: branchA,
      base: E2E_DEVELOP,
      title: "fix: accumulate first commit",
    });
    registerForTeardown({ branch: branchA, prNumber: prA.number });
    await mergePR(prA.number, "squash");
    await waitForRunAfter("flywheel-push.yml", E2E_DEVELOP, baselineA.get(E2E_DEVELOP)!.push, {
      timeoutMs: 180_000,
    });

    const firstPR = (
      await pollUntil(
        async () => sandboxGh().listOpenPRs({ head: E2E_DEVELOP, base: E2E_STAGING }),
        (prs) => prs.some((p) => !priorNumbers.has(p.number)),
        {
          intervalMs: 3000,
          timeoutMs: 60_000,
          description: "first promotion PR to appear",
        },
      )
    ).find((p) => !priorNumbers.has(p.number))!;
    registerForTeardown({ prNumber: firstPR.number });

    // Second merge.
    const baselineB = await snapshotRunIds([E2E_DEVELOP]);
    const branchB = uniqueBranch("e2e-accum-b");
    const prB = await createTestPR({
      branch: branchB,
      base: E2E_DEVELOP,
      title: "fix: accumulate second commit",
    });
    registerForTeardown({ branch: branchB, prNumber: prB.number });
    await mergePR(prB.number, "squash");
    await waitForRunAfter("flywheel-push.yml", E2E_DEVELOP, baselineB.get(E2E_DEVELOP)!.push, {
      timeoutMs: 180_000,
    });

    // Same promotion PR (upsert), with both commits referenced in body.
    const updated = await pollUntil(
      async () => sandboxGh().listOpenPRs({ head: E2E_DEVELOP, base: E2E_STAGING }),
      (prs) => {
        const same = prs.find((p) => p.number === firstPR.number);
        return Boolean(same && same.body && /accumulate first/.test(same.body) && /accumulate second/.test(same.body));
      },
      {
        intervalMs: 3000,
        timeoutMs: 60_000,
        description: "promotion PR body to contain both commit titles",
      },
    );

    const same = updated.find((p) => p.number === firstPR.number);
    expect(same).toBeDefined();
    expect(same!.body ?? "").toMatch(/accumulate first/);
    expect(same!.body ?? "").toMatch(/accumulate second/);

    // Verify no second promotion PR opened (still upsert).
    const newOnes = updated.filter((p) => !priorNumbers.has(p.number));
    expect(newOnes).toHaveLength(1);
  });
});
