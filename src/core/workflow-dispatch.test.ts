import { describe, it, expect, vi } from 'vitest';
import { dispatchWorkflow, pollRunOnBranch } from './workflow-dispatch.js';
import type { Octokit } from '../github/octokit.js';

function fakeOctokit(opts: {
  listRuns?: ReturnType<typeof vi.fn>;
  getRun?: ReturnType<typeof vi.fn>;
  dispatch?: ReturnType<typeof vi.fn>;
}): Octokit {
  return {
    rest: {
      actions: {
        createWorkflowDispatch: opts.dispatch ?? vi.fn().mockResolvedValue({}),
        listWorkflowRuns: opts.listRuns ?? vi.fn(),
        getWorkflowRun: opts.getRun ?? vi.fn(),
      },
    },
  } as unknown as Octokit;
}

describe('dispatchWorkflow', () => {
  it('forwards owner/repo/workflow_id/ref/inputs to createWorkflowDispatch', async () => {
    const dispatch = vi.fn().mockResolvedValue({});
    await dispatchWorkflow({
      octokit: fakeOctokit({ dispatch }),
      owner: 'o',
      repo: 'r',
      workflow: 'pipeline-quality.yml',
      ref: 'feature/x',
      inputs: { pr_number: '42', sha: 'abc' },
    });
    expect(dispatch).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      workflow_id: 'pipeline-quality.yml',
      ref: 'feature/x',
      inputs: { pr_number: '42', sha: 'abc' },
    });
  });
});

// Learning #7: the GitHub Actions ?branch= filter is unreliable for
// short-lived branches. Post-filter on `head_branch` instead.
describe('pollRunOnBranch > headBranch post-filter', () => {
  it('selects the run matching the branch even when listing returns sibling-branch runs', async () => {
    const listRuns = vi.fn().mockResolvedValue({
      data: {
        workflow_runs: [
          { id: 100, head_branch: 'unrelated/branch', status: 'completed' },
          { id: 200, head_branch: 'feature/x', status: 'in_progress' },
          { id: 300, head_branch: 'main', status: 'completed' },
        ],
      },
    });
    const getRun = vi
      .fn()
      .mockResolvedValueOnce({ data: { status: 'in_progress', conclusion: null } })
      .mockResolvedValueOnce({ data: { status: 'completed', conclusion: 'success' } });

    const result = await pollRunOnBranch({
      octokit: fakeOctokit({ listRuns, getRun }),
      owner: 'o',
      repo: 'r',
      workflow: 'on-pr.yml',
      branch: 'feature/x',
      appearTimeoutSeconds: 10,
      sleep: () => Promise.resolve(),
      now: () => 0,
    });

    expect(result.runId).toBe(200);
    expect(result.conclusion).toBe('success');
    // Sanity: listWorkflowRuns must NOT have passed the unreliable `branch` param
    expect(listRuns.mock.calls[0]![0]).not.toHaveProperty('branch');
  });

  it('throws when no matching run appears within appearTimeoutSeconds', async () => {
    const listRuns = vi.fn().mockResolvedValue({
      data: {
        workflow_runs: [{ id: 100, head_branch: 'unrelated', status: 'in_progress' }],
      },
    });
    let t = 0;
    const advance = (): number => {
      t += 5000;
      return t;
    };

    await expect(
      pollRunOnBranch({
        octokit: fakeOctokit({ listRuns }),
        owner: 'o',
        repo: 'r',
        workflow: 'on-pr.yml',
        branch: 'feature/x',
        appearTimeoutSeconds: 5,
        sleep: () => Promise.resolve(),
        now: advance,
      }),
    ).rejects.toThrow(/never produced a run/);
  });
});
