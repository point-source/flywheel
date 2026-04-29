import { afterEach, describe, expect, it } from "vitest";

import { runPrFlow } from "../../../src/pr-flow.js";
import {
  FLYWHEEL_AUTO_MERGE_LABEL,
  FLYWHEEL_NEEDS_REVIEW_LABEL,
} from "../../../src/github.js";
import { silentLogger } from "../../helpers/fakeGh.js";
import {
  hasSandboxToken,
  SANDBOX_OWNER,
  SANDBOX_REPO,
  sandboxGh,
  sandboxOctokit,
} from "../helpers/sandbox-client.js";
import { sandboxConfig } from "../helpers/sandbox-config.js";
import { createTestPR, fetchPR, uniqueBranch } from "../helpers/test-pr.js";
import { registerForTeardown, runTeardown } from "../helpers/teardown.js";

describe.skipIf(!hasSandboxToken)("integration: native auto-merge enablement", () => {
  afterEach(async () => {
    await runTeardown();
  });

  it("an eligible fix on integration-test-base (no required checks) is merged via direct-merge fallback", async () => {
    // integration-test-base has no required status checks, so GitHub's
    // enablePullRequestAutoMerge mutation refuses with "Pull request is in
    // clean status". The product falls back to a direct REST merge, which
    // exercises the path adopters without required checks rely on.
    const branch = uniqueBranch("auto-merge-direct");
    const handle = await createTestPR({
      title: "fix: enable auto-merge integration",
      branch,
    });
    registerForTeardown({ prNumber: handle.number, branch: handle.branch });

    const pr = await fetchPR(handle.number);
    const { log } = silentLogger();
    const outcome = await runPrFlow({ pr, config: sandboxConfig, gh: sandboxGh(), log });

    expect(outcome).toMatchObject({
      kind: "labeled",
      label: FLYWHEEL_AUTO_MERGE_LABEL,
      autoMergeEnabled: false,
      merged: true,
    });
  });

  it("disables auto-merge when an ineligible PR carries the auto-merge label from a prior run", async () => {
    // Open a feat PR (NOT in integration-test-base auto_merge list) and
    // pre-apply the auto-merge label to simulate a label flip: the PR was
    // eligible at one point, then retitled to feat. The flow should remove
    // the stale auto-merge label, add needs-review, and call disableAutoMerge
    // against real GitHub.
    const branch = uniqueBranch("auto-merge-disable");
    const handle = await createTestPR({
      title: "feat: requires review on integration base",
      branch,
    });
    registerForTeardown({ prNumber: handle.number, branch: handle.branch });

    await sandboxOctokit().rest.issues.addLabels({
      owner: SANDBOX_OWNER,
      repo: SANDBOX_REPO,
      issue_number: handle.number,
      labels: [FLYWHEEL_AUTO_MERGE_LABEL],
    });

    const pr = await fetchPR(handle.number);
    expect(pr.labels).toContain(FLYWHEEL_AUTO_MERGE_LABEL);

    const { log } = silentLogger();
    const outcome = await runPrFlow({ pr, config: sandboxConfig, gh: sandboxGh(), log });

    expect(outcome).toMatchObject({
      kind: "labeled",
      label: FLYWHEEL_NEEDS_REVIEW_LABEL,
      autoMergeEnabled: false,
      merged: false,
    });

    const after = await fetchPR(handle.number);
    expect(after.labels).toContain(FLYWHEEL_NEEDS_REVIEW_LABEL);
    expect(after.labels).not.toContain(FLYWHEEL_AUTO_MERGE_LABEL);
  });
});
