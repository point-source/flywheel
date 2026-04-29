import { afterEach, describe, expect, it } from "vitest";

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

const E2E_DEVELOP = "e2e-develop";
const E2E_STAGING = "e2e-staging";

describe.skipIf(!hasSandboxToken)("e2e/05: promotion PR opens after a merge to e2e-develop", () => {
  afterEach(async () => {
    await runTeardown();
  });

  it("a fix on develop is promoted (PR opened or merged) into staging", async () => {
    const baseline = await snapshotRunIds([E2E_DEVELOP]);
    const baselinePush = baseline.get(E2E_DEVELOP)!.push;

    const branch = uniqueBranch("e2e-promotion-source");
    const pr = await createTestPR({
      branch,
      base: E2E_DEVELOP,
      title: "fix: e2e promotion seed",
    });
    registerForTeardown({ branch, prNumber: pr.number });

    await mergePR(pr.number, "squash");
    const mergedAt = Date.now();

    await waitForRunAfter("flywheel-push.yml", E2E_DEVELOP, baselinePush, {
      timeoutMs: 180_000,
    });

    // The product semantic: after this merge, a develop→staging promotion
    // exists that was created/updated at-or-after the merge. The promotion
    // PR may already be auto-merged by the time we observe it — a previous
    // push run on the same branch can batch this commit into its own
    // promotion PR — so accept either state.
    type CandidatePR = { number: number; updatedAt: number; state: string };
    const matching = await pollUntil<CandidatePR[]>(
      async () => {
        const res = await sandboxOctokit().rest.pulls.list({
          owner: SANDBOX_OWNER,
          repo: SANDBOX_REPO,
          state: "all",
          base: E2E_STAGING,
          head: `${SANDBOX_OWNER}:${E2E_DEVELOP}`,
          per_page: 20,
          sort: "updated",
          direction: "desc",
        });
        return res.data
          .filter((p) => /promote .* → /.test(p.title))
          .map((p) => ({
            number: p.number,
            updatedAt: Date.parse(p.updated_at),
            state: p.merged_at ? "merged" : p.state,
          }));
      },
      // Allow a small clock-skew tolerance against the GH API.
      (prs) => prs.some((p) => p.updatedAt >= mergedAt - 5_000),
      {
        intervalMs: 3000,
        timeoutMs: 90_000,
        description: "develop→staging promotion PR updated at or after our merge",
      },
    );

    const promo = matching.find((p) => p.updatedAt >= mergedAt - 5_000)!;
    expect(promo).toBeDefined();
    expect(["open", "closed", "merged"]).toContain(promo.state);
  });
});
