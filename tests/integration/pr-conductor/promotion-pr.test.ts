import { afterEach, describe, expect, it } from "vitest";

import { runPromotion } from "../../../src/promotion.js";
import type { FlywheelConfig } from "../../../src/types.js";
import { silentLogger } from "../../helpers/fakeGh.js";
import {
  INTEGRATION_BASE,
  SANDBOX_OWNER,
  SANDBOX_REPO,
  hasSandboxToken,
  sandboxGh,
  sandboxOctokit,
} from "../helpers/sandbox-client.js";
import { sandboxConfig } from "../helpers/sandbox-config.js";
import { uniqueBranch } from "../helpers/test-pr.js";
import { registerForTeardown, runTeardown } from "../helpers/teardown.js";

/**
 * Promotion integration tests use a per-test ephemeral source branch and
 * upsert PRs against the long-lived integration-test-base. Each test gets
 * its own source branch so no test ever blocks on another's state.
 *
 * The FlywheelConfig is built per-test by appending a synthetic stream to
 * sandboxConfig — runPromotion only needs the config to know which branch
 * pairs to consider, it doesn't require those branches to be declared in
 * the sandbox repo's committed .flywheel.yml.
 */

async function seedSourceBranch(branch: string, commitMessage: string): Promise<string> {
  const octokit = sandboxOctokit();

  const baseRef = await octokit.rest.git.getRef({
    owner: SANDBOX_OWNER,
    repo: SANDBOX_REPO,
    ref: `heads/${INTEGRATION_BASE}`,
  });
  await octokit.rest.git.createRef({
    owner: SANDBOX_OWNER,
    repo: SANDBOX_REPO,
    ref: `refs/heads/${branch}`,
    sha: baseRef.data.object.sha,
  });

  const path = `tests/${branch.replace(/[^a-z0-9]/gi, "-")}.txt`;
  const put = await octokit.rest.repos.createOrUpdateFileContents({
    owner: SANDBOX_OWNER,
    repo: SANDBOX_REPO,
    path,
    message: commitMessage,
    content: Buffer.from(`marker for ${branch}\n`).toString("base64"),
    branch,
  });
  const sha = put.data.commit.sha;
  if (!sha) throw new Error(`createOrUpdateFileContents did not return a commit SHA for ${branch}`);
  return sha;
}

async function pushAdditionalCommit(branch: string, commitMessage: string, marker: string): Promise<void> {
  const octokit = sandboxOctokit();
  const path = `tests/${branch.replace(/[^a-z0-9]/gi, "-")}-${marker}.txt`;
  await octokit.rest.repos.createOrUpdateFileContents({
    owner: SANDBOX_OWNER,
    repo: SANDBOX_REPO,
    path,
    message: commitMessage,
    content: Buffer.from(`additional marker ${marker}\n`).toString("base64"),
    branch,
  });
}

function configForStream(sourceBranch: string): FlywheelConfig {
  return {
    ...sandboxConfig,
    streams: [
      ...sandboxConfig.streams,
      {
        name: `integration-promote-${sourceBranch}`,
        branches: [
          {
            name: sourceBranch,
            release: "prerelease",
            suffix: "promo",
            auto_merge: ["fix", "feat", "chore"],
          },
          {
            name: INTEGRATION_BASE,
            release: "production",
            auto_merge: ["fix", "chore", "perf", "style", "test"],
          },
        ],
      },
    ],
  };
}

describe.skipIf(!hasSandboxToken)("integration: promotion PR upsert", () => {
  afterEach(async () => {
    await runTeardown();
  });

  it("creates a promotion PR for a fix commit, then upserts (not duplicates) on a second push", async () => {
    const sourceBranch = uniqueBranch("promote-src");
    await seedSourceBranch(sourceBranch, "fix: integration promote first");
    registerForTeardown({ branch: sourceBranch });

    const config = configForStream(sourceBranch);
    const { log } = silentLogger();

    await runPromotion({ branchRef: sourceBranch, config, gh: sandboxGh(), log });

    const firstList = await sandboxGh().listOpenPRs({
      head: sourceBranch,
      base: INTEGRATION_BASE,
    });
    expect(firstList).toHaveLength(1);
    const firstPR = firstList[0]!;
    expect(firstPR.title).toMatch(/^fix.*promote/);
    registerForTeardown({ prNumber: firstPR.number });

    // Second push with a more impactful type.
    await pushAdditionalCommit(sourceBranch, "feat: bigger change", "feat");
    await runPromotion({ branchRef: sourceBranch, config, gh: sandboxGh(), log });

    const secondList = await sandboxGh().listOpenPRs({
      head: sourceBranch,
      base: INTEGRATION_BASE,
    });
    expect(secondList).toHaveLength(1);
    expect(secondList[0]!.number).toBe(firstPR.number); // upserted, not duplicated
    expect(secondList[0]!.title).toMatch(/^feat/); // most-impactful type updated
  });

  it("does not create a promotion PR when the source branch only has chore-grade commits and target is fix-only", async () => {
    const sourceBranch = uniqueBranch("promote-chore-only");
    await seedSourceBranch(sourceBranch, "chore: dep bump");
    registerForTeardown({ branch: sourceBranch });

    // Build a config where the target only allows fix — a chore-only diff is non-bumping.
    const config: FlywheelConfig = {
      ...sandboxConfig,
      streams: [
        ...sandboxConfig.streams,
        {
          name: `integration-promote-${sourceBranch}`,
          branches: [
            {
              name: sourceBranch,
              release: "prerelease",
              suffix: "promo",
              auto_merge: ["fix", "chore"],
            },
            { name: INTEGRATION_BASE, release: "production", auto_merge: ["fix"] },
          ],
        },
      ],
    };
    const { log } = silentLogger();

    const outcome = await runPromotion({ branchRef: sourceBranch, config, gh: sandboxGh(), log });
    expect(outcome.kind).toBe("no-bumping");

    const prs = await sandboxGh().listOpenPRs({
      head: sourceBranch,
      base: INTEGRATION_BASE,
    });
    expect(prs).toHaveLength(0);
  });
});
