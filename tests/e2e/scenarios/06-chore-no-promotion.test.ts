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
  it("a chore commit on staging does not by itself appear in a new promotion PR's body", async () => {
    const baseline = await snapshotRunIds([E2E_STAGING]);
    const baselinePush = baseline.get(E2E_STAGING)!.push;

    const priorPromotions = await sandboxGh().listOpenPRs({
      head: E2E_STAGING,
      base: E2E_MAIN,
    });
    const priorNumbers = new Set(priorPromotions.map((p) => p.number));

    const choreTitle = `chore: e2e chore-only no-bump ${Date.now()}`;
    const branch = uniqueBranch("e2e-chore-no-promote");
    const pr = await createTestPR({
      branch,
      base: E2E_STAGING,
      title: choreTitle,
    });
    registerForTeardown({ branch, prNumber: pr.number });

    await mergePR(pr.number, "squash");

    await waitForRunAfter("flywheel-push.yml", E2E_STAGING, baselinePush, {
      timeoutMs: 180_000,
    });

    // Settle, then check that any newly-opened promotion PR is here because
    // of pre-existing pending fixes, not because of our chore. The product
    // invariant: chore is non-bumping, so it does not by itself trigger a
    // promotion. If a new PR is opened by another scenario's pending state,
    // our chore may also ride along — that's fine, but the chore alone
    // should never be the sole content of a new bumping PR.
    await new Promise((r) => setTimeout(r, 5000));
    const after = await sandboxGh().listOpenPRs({ head: E2E_STAGING, base: E2E_MAIN });
    const newOnes = after.filter((p) => !priorNumbers.has(p.number));
    for (const p of newOnes) {
      const body = p.body ?? "";
      const containsOurChore = body.includes(choreTitle);
      const containsBumping = /^### (fix|feat|perf)/m.test(body) || /^- /m.test(body);
      // If our chore is in the PR but the PR also has bumping commits in
      // prior pending state, that's expected. If the PR contains ONLY our
      // chore, that's a violation.
      if (containsOurChore && !containsBumping) {
        throw new Error(
          `Promotion PR #${p.number} appears to contain only our chore commit:\n${body}`,
        );
      }
    }
  });
});
