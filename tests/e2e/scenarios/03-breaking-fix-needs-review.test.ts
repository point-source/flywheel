import { afterEach, describe, expect, it } from "vitest";

import { hasSandboxToken } from "../../integration/helpers/sandbox-client.js";
import { createTestPR, fetchPR, fetchPRRaw, uniqueBranch } from "../../integration/helpers/test-pr.js";
import { registerForTeardown, runTeardown } from "../../integration/helpers/teardown.js";
import { pollUntil } from "../helpers/poll-until.js";

const E2E_STAGING = "e2e-staging";

describe.skipIf(!hasSandboxToken)("e2e/03: breaking fix (fix!) needs review", () => {
  afterEach(async () => {
    await runTeardown();
  });

  // Sandbox config: e2e-staging.auto_merge = [fix, chore]; fix! is excluded.
  it("labels fix! against e2e-staging as needs-review (fix! not in auto_merge list)", async () => {
    const branch = uniqueBranch("e2e-breaking-fix");
    const pr = await createTestPR({
      branch,
      base: E2E_STAGING,
      title: "fix!: e2e breaking change requires review",
    });
    registerForTeardown({ branch, prNumber: pr.number });

    await pollUntil(
      async () => (await fetchPR(pr.number)).labels,
      (labels) => labels.includes("flywheel:needs-review"),
      {
        intervalMs: 3000,
        timeoutMs: 30_000,
        description: "flywheel:needs-review label on fix! PR",
      },
    );

    const raw = await fetchPRRaw(pr.number);
    expect(raw.auto_merge).toBeNull();
    const labels = raw.labels.map((l) => l.name);
    expect(labels).not.toContain("flywheel:auto-merge");
  });
});
