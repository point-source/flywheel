import { afterEach, describe, expect, it } from "vitest";

import { hasSandboxToken } from "../../integration/helpers/sandbox-client.js";
import { createTestPR, uniqueBranch } from "../../integration/helpers/test-pr.js";
import { registerForTeardown, runTeardown } from "../../integration/helpers/teardown.js";
import { pollUntil } from "../helpers/poll-until.js";
import { getCheckRuns } from "../helpers/sandbox-e2e.js";

const E2E_DEVELOP = "e2e-develop";
const CHECK_NAME = "flywheel/conventional-commit";

describe.skipIf(!hasSandboxToken)("e2e/04: invalid PR title posts a failing check", () => {
  afterEach(async () => {
    await runTeardown();
  });

  it("creates a flywheel/conventional-commit check with conclusion=failure", async () => {
    const branch = uniqueBranch("e2e-invalid-title");
    const pr = await createTestPR({
      branch,
      base: E2E_DEVELOP,
      title: "not a conventional commit title",
    });
    registerForTeardown({ branch, prNumber: pr.number });

    const failing = await pollUntil(
      async () => getCheckRuns(pr.headSha, CHECK_NAME),
      (runs) => runs.some((r) => r.conclusion === "failure"),
      {
        intervalMs: 3000,
        timeoutMs: 30_000,
        description: `${CHECK_NAME} check with conclusion=failure on ${pr.headSha}`,
      },
    );

    expect(failing.find((r) => r.conclusion === "failure")).toBeDefined();
  });
});
