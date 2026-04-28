import { afterEach, describe, expect, it } from "vitest";

import { runPrFlow } from "../../../src/pr-flow.js";
import { FLYWHEEL_AUTO_MERGE_LABEL } from "../../../src/github.js";
import { silentLogger } from "../../helpers/fakeGh.js";
import { hasSandboxToken, sandboxGh } from "../helpers/sandbox-client.js";
import { sandboxConfig } from "../helpers/sandbox-config.js";
import { createTestPR, fetchPR, uniqueBranch } from "../helpers/test-pr.js";
import { registerForTeardown, runTeardown } from "../helpers/teardown.js";

describe.skipIf(!hasSandboxToken)("integration: native auto-merge enablement", () => {
  afterEach(async () => {
    await runTeardown();
  });

  it("enables native auto-merge via the real GraphQL mutation for an eligible fix", async () => {
    const branch = uniqueBranch("auto-merge-enable");
    const handle = await createTestPR({
      title: "fix: enable auto-merge integration",
      branch,
    });
    registerForTeardown({ prNumber: handle.number, branch: handle.branch });

    const pr = await fetchPR(handle.number);
    const { log } = silentLogger();
    const outcome = await runPrFlow({ pr, config: sandboxConfig, gh: sandboxGh(), log });

    // The production return shape is the contract. autoMergeEnabled: true means
    // the GraphQL mutation succeeded against real GitHub — proving the sandbox
    // has auto-merge allowed and the PAT has the permissions to enable it.
    // We do not poll for actual merge: required checks (or their absence) on
    // integration-test-base govern when the merge actually fires, which is out
    // of scope for this test — afterEach closes the PR before any merge.
    expect(outcome).toMatchObject({
      kind: "labeled",
      label: FLYWHEEL_AUTO_MERGE_LABEL,
      autoMergeEnabled: true,
    });
  });

  it("disables auto-merge when an eligible PR is retitled to an ineligible type", async () => {
    const branch = uniqueBranch("auto-merge-disable");
    const handle = await createTestPR({
      title: "fix: enable then disable",
      branch,
    });
    registerForTeardown({ prNumber: handle.number, branch: handle.branch });

    const pr1 = await fetchPR(handle.number);
    const { log } = silentLogger();
    const first = await runPrFlow({ pr: pr1, config: sandboxConfig, gh: sandboxGh(), log });
    expect(first).toMatchObject({ kind: "labeled", autoMergeEnabled: true });

    // Author retitles to feat (not in integration-test-base auto_merge list).
    await sandboxGh().updatePR(handle.number, { title: "feat: now needs review" });

    const pr2 = await fetchPR(handle.number);
    const second = await runPrFlow({ pr: pr2, config: sandboxConfig, gh: sandboxGh(), log });
    expect(second).toMatchObject({
      kind: "labeled",
      autoMergeEnabled: false,
    });
  });
});
