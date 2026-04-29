import { afterEach, describe, expect, it } from "vitest";

import { hasSandboxToken } from "../../integration/helpers/sandbox-client.js";
import { createTestPR, fetchPR, fetchPRRaw, uniqueBranch } from "../../integration/helpers/test-pr.js";
import { registerForTeardown, runTeardown } from "../../integration/helpers/teardown.js";
import { pollUntil } from "../helpers/poll-until.js";
import { getCheckRuns, getPRMergeState } from "../helpers/sandbox-e2e.js";

const E2E_DEVELOP = "e2e-develop";

describe.skipIf(!hasSandboxToken)("e2e/01: fix PR auto-merges end-to-end", () => {
  afterEach(async () => {
    await runTeardown();
  });

  it("labels, enables auto-merge, and merges a fix PR against e2e-develop", async () => {
    const branch = uniqueBranch("e2e-fix-auto-merge");
    const pr = await createTestPR({
      branch,
      base: E2E_DEVELOP,
      title: "fix: e2e auto-merge happy path",
    });
    registerForTeardown({ branch, prNumber: pr.number });

    await pollUntil(
      async () => (await fetchPR(pr.number)).labels,
      (labels) => labels.includes("flywheel:auto-merge"),
      {
        intervalMs: 3000,
        timeoutMs: 30_000,
        description: "flywheel:auto-merge label on fix PR",
      },
    );

    let lastState = await getPRMergeState(pr.number);
    try {
      await pollUntil(
        async () => {
          lastState = await getPRMergeState(pr.number);
          return lastState;
        },
        (s) => s.merged === true && s.mergedAt !== null,
        {
          intervalMs: 5000,
          timeoutMs: 120_000,
          description: "fix PR to merge (mergedAt != null)",
        },
      );
    } catch (err) {
      const raw = await fetchPRRaw(pr.number);
      const checks = await getCheckRuns(raw.head.sha, "");
      const diagnostic = {
        lastState,
        head_sha: raw.head.sha,
        mergeable: raw.mergeable,
        mergeable_state: raw.mergeable_state,
        rebaseable: raw.rebaseable,
        auto_merge: raw.auto_merge,
        checks,
      };
      throw new Error(
        `${(err as Error).message}\n\nDiagnostic:\n${JSON.stringify(diagnostic, null, 2)}`,
      );
    }

    expect(lastState.merged).toBe(true);
    expect(lastState.state).toBe("closed");
  });
});
