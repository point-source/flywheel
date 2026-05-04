import type { PullRequest } from "../../../src/github.js";
import {
  INTEGRATION_BASE,
  SANDBOX_OWNER,
  SANDBOX_REPO,
  sandboxOctokit,
} from "./sandbox-client.js";

export function uniqueBranch(scenario: string): string {
  const slug = scenario.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  return `test/${slug}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

interface CreateTestPROptions {
  title: string;
  branch: string;
  base?: string;
  body?: string;
  fileContent?: string;
}

export interface TestPRHandle {
  number: number;
  nodeId: string;
  branch: string;
  base: string;
  headSha: string;
}

export async function createTestPR(opts: CreateTestPROptions): Promise<TestPRHandle> {
  const octokit = sandboxOctokit();
  const base = opts.base ?? INTEGRATION_BASE;

  // 1. Get the SHA of the base branch.
  const baseRef = await octokit.rest.git.getRef({
    owner: SANDBOX_OWNER,
    repo: SANDBOX_REPO,
    ref: `heads/${base}`,
  });
  const baseSha = baseRef.data.object.sha;

  // 2. Create a new branch at the base SHA.
  await octokit.rest.git.createRef({
    owner: SANDBOX_OWNER,
    repo: SANDBOX_REPO,
    ref: `refs/heads/${opts.branch}`,
    sha: baseSha,
  });

  // 3. Commit a unique file so the branch has new content (PRs require diff).
  const path = `tests/${opts.branch.replace(/[^a-z0-9]/gi, "-")}.txt`;
  const content = Buffer.from(opts.fileContent ?? `marker for ${opts.branch}\n`).toString("base64");
  const put = await octokit.rest.repos.createOrUpdateFileContents({
    owner: SANDBOX_OWNER,
    repo: SANDBOX_REPO,
    path,
    message: opts.title,
    content,
    branch: opts.branch,
  });
  const headSha = put.data.commit.sha;
  if (!headSha) throw new Error(`createOrUpdateFileContents did not return a commit SHA for ${opts.branch}`);

  // 4. Open a PR.
  const pr = await octokit.rest.pulls.create({
    owner: SANDBOX_OWNER,
    repo: SANDBOX_REPO,
    title: opts.title,
    body: opts.body ?? "integration test PR",
    head: opts.branch,
    base,
  });

  return {
    number: pr.data.number,
    nodeId: pr.data.node_id,
    branch: opts.branch,
    base,
    headSha,
  };
}

export async function fetchPR(number: number): Promise<PullRequest> {
  const octokit = sandboxOctokit();
  const res = await octokit.rest.pulls.get({
    owner: SANDBOX_OWNER,
    repo: SANDBOX_REPO,
    pull_number: number,
  });
  const data = res.data;
  return {
    number: data.number,
    title: data.title,
    body: data.body ?? null,
    baseRef: data.base.ref,
    headRef: data.head.ref,
    headSha: data.head.sha,
    nodeId: data.node_id,
    labels: data.labels.map((l) => (typeof l === "string" ? l : l.name ?? "")).filter(Boolean),
    draft: data.draft ?? false,
  };
}

export async function fetchPRRaw(number: number) {
  const octokit = sandboxOctokit();
  const res = await octokit.rest.pulls.get({
    owner: SANDBOX_OWNER,
    repo: SANDBOX_REPO,
    pull_number: number,
  });
  return res.data;
}

// GitHub's read API can lag a PR write by a few seconds (eventual consistency
// across read replicas). Tests that mutate a PR and then read it back must
// either wait or risk a stale read. waitForPR polls fetchPR up to 30s,
// returning the first value that satisfies `predicate`. The bound is
// deliberately well under any reasonable CI step timeout — if it fires, the
// problem is a real bug, not GitHub being slow.
export async function waitForPR(
  number: number,
  predicate: (pr: import("../../../src/github.js").PullRequest) => boolean,
  description: string,
  { timeoutMs = 30_000, pollMs = 500 }: { timeoutMs?: number; pollMs?: number } = {},
): Promise<import("../../../src/github.js").PullRequest> {
  const deadline = Date.now() + timeoutMs;
  let pr = await fetchPR(number);
  while (!predicate(pr)) {
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for PR #${number}: ${description}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    pr = await fetchPR(number);
  }
  return pr;
}
