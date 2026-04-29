import { afterEach, describe, expect, it } from "vitest";

import { sandboxGh, hasSandboxToken } from "../../integration/helpers/sandbox-client.js";
import { createTestPR, uniqueBranch } from "../../integration/helpers/test-pr.js";
import { registerForTeardown, runTeardown } from "../../integration/helpers/teardown.js";
import { pollUntil } from "../helpers/poll-until.js";
import { mergePR } from "../helpers/sandbox-e2e.js";
import { snapshotRunIds, waitForRunAfter } from "../helpers/run-baseline.js";

const E2E_DEVELOP = "e2e-develop";
const E2E_STAGING = "e2e-staging";

describe.skipIf(!hasSandboxToken)("e2e/05: promotion PR opens after a merge to e2e-develop", () => {
  afterEach(async () => {
    await runTeardown();
  });

  it("opens a develop→staging promotion PR after a fix lands", async () => {
    const baseline = await snapshotRunIds([E2E_DEVELOP]);
    const baselinePush = baseline.get(E2E_DEVELOP)!.push;

    // Snapshot existing promotion PR(s) before the test merges anything.
    const priorPromotions = await sandboxGh().listOpenPRs({
      head: E2E_DEVELOP,
      base: E2E_STAGING,
    });
    const priorNumbers = new Set(priorPromotions.map((p) => p.number));

    const branch = uniqueBranch("e2e-promotion-source");
    const pr = await createTestPR({
      branch,
      base: E2E_DEVELOP,
      title: "fix: e2e promotion seed",
    });
    registerForTeardown({ branch, prNumber: pr.number });

    await mergePR(pr.number, "squash");

    await waitForRunAfter("flywheel-push.yml", E2E_DEVELOP, baselinePush, {
      timeoutMs: 180_000,
    });

    const promotion = await pollUntil(
      async () => sandboxGh().listOpenPRs({ head: E2E_DEVELOP, base: E2E_STAGING }),
      (prs) => prs.some((p) => !priorNumbers.has(p.number)),
      {
        intervalMs: 3000,
        timeoutMs: 60_000,
        description: "new develop→staging promotion PR to appear",
      },
    );

    const created = promotion.find((p) => !priorNumbers.has(p.number))!;
    registerForTeardown({ prNumber: created.number });
    expect(created.title.toLowerCase()).toMatch(/^fix/);
  });
});
