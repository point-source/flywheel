import { afterEach, describe, expect, it } from "vitest";

import { runPrFlow } from "../../../src/pr-flow.js";
import { silentLogger } from "../../helpers/fakeGh.js";
import { hasSandboxPat, sandboxGh } from "../helpers/sandbox-client.js";
import { sandboxConfig } from "../helpers/sandbox-config.js";
import { createTestPR, fetchPR, uniqueBranch } from "../helpers/test-pr.js";
import { registerForTeardown, runTeardown } from "../helpers/teardown.js";

describe.skipIf(!hasSandboxPat)("integration: PR title rewrite", () => {
  afterEach(async () => {
    await runTeardown();
  });

  it("normalizes a malformed conventional commit title and writes the increment annotation in the body", async () => {
    const branch = uniqueBranch("pr-title-rewrite");
    const handle = await createTestPR({
      title: "fix(auth):handle token refresh", // missing space after colon
      branch,
    });
    registerForTeardown({ prNumber: handle.number, branch: handle.branch });

    const pr = await fetchPR(handle.number);
    const { log } = silentLogger();
    await runPrFlow({ pr, config: sandboxConfig, gh: sandboxGh(), log });

    const updated = await fetchPR(handle.number);
    expect(updated.title).toBe("fix(auth): handle token refresh");
    expect(updated.body ?? "").toContain("**Increment type:** patch");
  });

  it("renders a per-type changelog section in the PR body using real listPullCommits results", async () => {
    const branch = uniqueBranch("pr-title-changelog");
    const handle = await createTestPR({
      title: "fix(api): tighten rate limiter",
      branch,
    });
    registerForTeardown({ prNumber: handle.number, branch: handle.branch });

    const pr = await fetchPR(handle.number);
    const { log } = silentLogger();
    await runPrFlow({ pr, config: sandboxConfig, gh: sandboxGh(), log });

    const updated = await fetchPR(handle.number);
    expect(updated.body ?? "").toContain("### fix");
    expect(updated.body ?? "").toContain("tighten rate limiter");
  });
});
