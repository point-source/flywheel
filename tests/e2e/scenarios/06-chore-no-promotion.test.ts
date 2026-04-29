import { afterEach, describe, expect, it } from "vitest";

import { sandboxGh, hasSandboxToken } from "../../integration/helpers/sandbox-client.js";
import { createTestPR, uniqueBranch } from "../../integration/helpers/test-pr.js";
import { registerForTeardown, runTeardown } from "../../integration/helpers/teardown.js";
import { mergePR } from "../helpers/sandbox-e2e.js";
import { snapshotRunIds, waitForRunAfter } from "../helpers/run-baseline.js";

const E2E_STAGING = "e2e-staging";
const E2E_MAIN = "e2e-main";

describe.skipIf(!hasSandboxToken)("e2e/06: chore-only merge does NOT open a promotion PR", () => {
  afterEach(async () => {
    await runTeardown();
  });

  // Sandbox config: e2e-staging.auto_merge includes chore; e2e-main.auto_merge = [].
  // A chore-only merge to staging produces no promotion PR to main because
  // chore is non-bumping for the main-line tag stream.
  it("after merging a chore PR to e2e-staging, no new staging→main promotion PR exists", async () => {
    const baseline = await snapshotRunIds([E2E_STAGING]);
    const baselinePush = baseline.get(E2E_STAGING)!.push;

    const priorPromotions = await sandboxGh().listOpenPRs({
      head: E2E_STAGING,
      base: E2E_MAIN,
    });
    const priorNumbers = new Set(priorPromotions.map((p) => p.number));

    const branch = uniqueBranch("e2e-chore-no-promote");
    const pr = await createTestPR({
      branch,
      base: E2E_STAGING,
      title: "chore: e2e chore-only no-bump",
    });
    registerForTeardown({ branch, prNumber: pr.number });

    await mergePR(pr.number, "squash");

    await waitForRunAfter("flywheel-push.yml", E2E_STAGING, baselinePush, {
      timeoutMs: 180_000,
    });

    // Give the action 5s after run completion to settle, then assert no new promotion.
    await new Promise((r) => setTimeout(r, 5000));
    const after = await sandboxGh().listOpenPRs({ head: E2E_STAGING, base: E2E_MAIN });
    const newOnes = after.filter((p) => !priorNumbers.has(p.number));
    expect(newOnes).toHaveLength(0);
  });
});
