import { SANDBOX_OWNER, SANDBOX_REPO, sandboxOctokit } from "./sandbox-client.js";

interface PendingCleanup {
  prNumber?: number;
  branch?: string;
}

const stack: PendingCleanup[] = [];

export function registerForTeardown(item: PendingCleanup): void {
  stack.push(item);
}

export async function runTeardown(): Promise<void> {
  const octokit = sandboxOctokit();
  // LIFO so the most recently created resources are torn down first.
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (item.prNumber !== undefined) {
      try {
        await octokit.rest.pulls.update({
          owner: SANDBOX_OWNER,
          repo: SANDBOX_REPO,
          pull_number: item.prNumber,
          state: "closed",
        });
      } catch (err) {
        const status = (err as { status?: number } | undefined)?.status;
        if (status !== 404 && status !== 422) throw err;
      }
    }
    if (item.branch !== undefined) {
      try {
        await octokit.rest.git.deleteRef({
          owner: SANDBOX_OWNER,
          repo: SANDBOX_REPO,
          ref: `heads/${item.branch}`,
        });
      } catch (err) {
        const status = (err as { status?: number } | undefined)?.status;
        if (status !== 404 && status !== 422) throw err;
      }
    }
  }
}
