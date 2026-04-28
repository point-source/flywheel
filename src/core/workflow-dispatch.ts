import type { Octokit } from '../github/octokit.js';

export interface DispatchWorkflowOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  /** Workflow filename (e.g. `pipeline-quality.yml`) or numeric ID. */
  workflow: string | number;
  ref: string;
  inputs?: Record<string, string>;
}

export async function dispatchWorkflow(opts: DispatchWorkflowOptions): Promise<void> {
  await opts.octokit.rest.actions.createWorkflowDispatch({
    owner: opts.owner,
    repo: opts.repo,
    workflow_id: opts.workflow,
    ref: opts.ref,
    inputs: opts.inputs,
  });
}

export interface PollRunOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  workflow: string | number;
  /** Branch name to filter by (post-filter on headBranch — see learning #7). */
  branch: string;
  /**
   * Maximum seconds to wait for the run to APPEAR. Once it's running, we
   * wait until completion regardless of this timeout.
   */
  appearTimeoutSeconds: number;
  /** Pluggable sleeper for tests. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Pluggable clock for tests. Defaults to Date.now. */
  now?: () => number;
}

export interface PollRunResult {
  runId: number;
  conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | 'neutral' | null;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

/**
 * Poll for the latest workflow run on a specific branch and wait for it to
 * complete. The post-filter on headBranch is critical: the GitHub Actions
 * `?branch=` query parameter is unreliable for short-lived branches and
 * recently force-rewritten refs (learning #7).
 */
export async function pollRunOnBranch(opts: PollRunOptions): Promise<PollRunResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;

  const start = now();
  let runId: number | null = null;

  // Phase 1: wait for the run to appear.
  while (now() - start < opts.appearTimeoutSeconds * 1000) {
    const { data } = await opts.octokit.rest.actions.listWorkflowRuns({
      owner: opts.owner,
      repo: opts.repo,
      workflow_id: opts.workflow,
      per_page: 50,
      // We do NOT pass `branch:` here. Post-filter on .head_branch instead.
    });
    const match = data.workflow_runs.find((r) => r.head_branch === opts.branch);
    if (match) {
      runId = match.id;
      break;
    }
    await sleep(2000);
  }

  if (runId === null) {
    throw new Error(
      `workflow ${opts.workflow} never produced a run on ${opts.branch} within ${opts.appearTimeoutSeconds}s`,
    );
  }

  // Phase 2: wait for the run to complete. No timeout here — the run has its
  // own job timeout, and we don't want to leave a half-tracked run behind.
  while (true) {
    const { data: run } = await opts.octokit.rest.actions.getWorkflowRun({
      owner: opts.owner,
      repo: opts.repo,
      run_id: runId,
    });
    if (run.status === 'completed') {
      return { runId, conclusion: run.conclusion as PollRunResult['conclusion'] };
    }
    await sleep(3000);
  }
}
