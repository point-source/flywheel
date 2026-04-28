import { afterEach, describe, expect, it } from "vitest";

import { runPrFlow } from "../../../src/pr-flow.js";
import {
  FLYWHEEL_AUTO_MERGE_LABEL,
  FLYWHEEL_NEEDS_REVIEW_LABEL,
} from "../../../src/github.js";
import { silentLogger } from "../../helpers/fakeGh.js";
import {
  SANDBOX_OWNER,
  SANDBOX_REPO,
  hasSandboxPat,
  sandboxGh,
  sandboxOctokit,
} from "../helpers/sandbox-client.js";
import { sandboxConfig } from "../helpers/sandbox-config.js";
import { createTestPR, fetchPR, uniqueBranch } from "../helpers/test-pr.js";
import { registerForTeardown, runTeardown } from "../helpers/teardown.js";

describe.skipIf(!hasSandboxPat)("integration: label application", () => {
  afterEach(async () => {
    await runTeardown();
  });

  it("applies flywheel:auto-merge to an eligible fix PR", async () => {
    const branch = uniqueBranch("fix-label");
    const handle = await createTestPR({
      title: "fix: integration label test",
      branch,
    });
    registerForTeardown({ prNumber: handle.number, branch: handle.branch });

    const pr = await fetchPR(handle.number);
    const { log } = silentLogger();
    await runPrFlow({ pr, config: sandboxConfig, gh: sandboxGh(), log });

    const updated = await fetchPR(handle.number);
    expect(updated.labels).toContain(FLYWHEEL_AUTO_MERGE_LABEL);
    expect(updated.labels).not.toContain(FLYWHEEL_NEEDS_REVIEW_LABEL);
  });

  it("applies flywheel:needs-review to an ineligible feat PR", async () => {
    const branch = uniqueBranch("feat-label");
    const handle = await createTestPR({
      title: "feat: integration label test",
      branch,
    });
    registerForTeardown({ prNumber: handle.number, branch: handle.branch });

    const pr = await fetchPR(handle.number);
    const { log } = silentLogger();
    await runPrFlow({ pr, config: sandboxConfig, gh: sandboxGh(), log });

    const updated = await fetchPR(handle.number);
    expect(updated.labels).toContain(FLYWHEEL_NEEDS_REVIEW_LABEL);
    expect(updated.labels).not.toContain(FLYWHEEL_AUTO_MERGE_LABEL);
  });

  it("flips needs-review to auto-merge after retitle from feat: to fix:", async () => {
    const branch = uniqueBranch("retitle-flip");
    const handle = await createTestPR({
      title: "feat: will be retitled",
      branch,
    });
    registerForTeardown({ prNumber: handle.number, branch: handle.branch });

    const pr1 = await fetchPR(handle.number);
    const { log } = silentLogger();
    await runPrFlow({ pr: pr1, config: sandboxConfig, gh: sandboxGh(), log });

    const afterFirst = await fetchPR(handle.number);
    expect(afterFirst.labels).toContain(FLYWHEEL_NEEDS_REVIEW_LABEL);

    // Retitle the PR (simulating an author edit).
    await sandboxOctokit().rest.pulls.update({
      owner: SANDBOX_OWNER,
      repo: SANDBOX_REPO,
      pull_number: handle.number,
      title: "fix: actually a fix",
    });

    const pr2 = await fetchPR(handle.number);
    await runPrFlow({ pr: pr2, config: sandboxConfig, gh: sandboxGh(), log });

    const afterFlip = await fetchPR(handle.number);
    expect(afterFlip.labels).toContain(FLYWHEEL_AUTO_MERGE_LABEL);
    expect(afterFlip.labels).not.toContain(FLYWHEEL_NEEDS_REVIEW_LABEL);
  });
});
