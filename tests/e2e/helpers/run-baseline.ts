import { SANDBOX_OWNER, SANDBOX_REPO, sandboxOctokit } from "../../integration/helpers/sandbox-client.js";
import { pollUntil } from "./poll-until.js";

export type WorkflowFile = "flywheel-pr.yml" | "flywheel-push.yml";

export interface BaselineRunIds {
  push: number;
  pr: number;
}

export interface WorkflowRunSummary {
  id: number;
  status: string;
  conclusion: string | null;
  headSha: string;
  htmlUrl: string;
}

async function highestRunId(workflow: WorkflowFile, branch: string): Promise<number> {
  const octokit = sandboxOctokit();
  const res = await octokit.rest.actions.listWorkflowRuns({
    owner: SANDBOX_OWNER,
    repo: SANDBOX_REPO,
    workflow_id: workflow,
    branch,
    per_page: 1,
  });
  const top = res.data.workflow_runs[0];
  return top?.id ?? 0;
}

export async function snapshotRunIds(branches: string[]): Promise<Map<string, BaselineRunIds>> {
  const out = new Map<string, BaselineRunIds>();
  for (const branch of branches) {
    const [push, pr] = await Promise.all([
      highestRunId("flywheel-push.yml", branch),
      highestRunId("flywheel-pr.yml", branch),
    ]);
    out.set(branch, { push, pr });
  }
  return out;
}

export async function waitForRunAfter(
  workflow: WorkflowFile,
  branch: string,
  sinceId: number,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<WorkflowRunSummary> {
  const octokit = sandboxOctokit();
  return pollUntil(
    async () => {
      const res = await octokit.rest.actions.listWorkflowRuns({
        owner: SANDBOX_OWNER,
        repo: SANDBOX_REPO,
        workflow_id: workflow,
        branch,
        per_page: 10,
      });
      const newest = res.data.workflow_runs.find((r) => r.id > sinceId);
      if (!newest) return null;
      return {
        id: newest.id,
        status: newest.status ?? "unknown",
        conclusion: newest.conclusion ?? null,
        headSha: newest.head_sha,
        htmlUrl: newest.html_url,
      };
    },
    (run): run is WorkflowRunSummary => run !== null && run.status === "completed",
    {
      intervalMs: options.intervalMs ?? 5000,
      timeoutMs: options.timeoutMs ?? 120_000,
      description: `${workflow} run on ${branch} after id ${sinceId} to complete`,
    },
  ) as Promise<WorkflowRunSummary>;
}
