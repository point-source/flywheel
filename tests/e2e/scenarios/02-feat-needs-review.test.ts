import { afterEach, describe, expect, it } from "vitest";

import { hasSandboxToken } from "../../integration/helpers/sandbox-client.js";
import { createTestPR, fetchPR, fetchPRRaw, uniqueBranch } from "../../integration/helpers/test-pr.js";
import { registerForTeardown, runTeardown } from "../../integration/helpers/teardown.js";
import { pollUntil } from "../helpers/poll-until.js";

const E2E_DEVELOP = "e2e-develop";

describe.skipIf(!hasSandboxToken)("e2e/02: feat PR labeled needs-review and not auto-merged", () => {
  afterEach(async () => {
    await runTeardown();
  });

  it("applies flywheel:needs-review and leaves auto_merge null on a feat PR", async () => {
    const branch = uniqueBranch("e2e-feat-needs-review");
    const pr = await createTestPR({
      branch,
      base: E2E_DEVELOP,
      title: "feat: e2e needs-review path",
    });
    registerForTeardown({ branch, prNumber: pr.number });

    await pollUntil(
      async () => (await fetchPR(pr.number)).labels,
      (labels) => labels.includes("flywheel:needs-review"),
      {
        intervalMs: 3000,
        timeoutMs: 30_000,
        description: "flywheel:needs-review label on feat PR",
      },
    );

    const raw = await fetchPRRaw(pr.number);
    expect(raw.auto_merge).toBeNull();
    expect(raw.state).toBe("open");
    const labels = raw.labels.map((l) => l.name);
    expect(labels).not.toContain("flywheel:auto-merge");

    // Observation window: confirm the PR doesn't merge anyway in the next 15s.
    await new Promise((r) => setTimeout(r, 15_000));
    const after = await fetchPRRaw(pr.number);
    expect(after.state).toBe("open");
    expect(after.merged).toBe(false);
  });
});
