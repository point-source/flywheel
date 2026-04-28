import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as core from '@actions/core';
import { runPrLifecycleWithOctokit } from './pr-lifecycle.js';
import type { Octokit } from '../github/octokit.js';
import type { Config } from '../core/config.js';

interface MockOctokit {
  octokit: Octokit;
  pullsListCommits: ReturnType<typeof vi.fn>;
  pullsUpdate: ReturnType<typeof vi.fn>;
  pullsGet: ReturnType<typeof vi.fn>;
  reposGetBranch: ReturnType<typeof vi.fn>;
  reposGetBranchRules: ReturnType<typeof vi.fn>;
  actionsCreateDispatch: ReturnType<typeof vi.fn>;
  actionsListRuns: ReturnType<typeof vi.fn>;
  actionsGetRun: ReturnType<typeof vi.fn>;
  graphql: ReturnType<typeof vi.fn>;
  issuesCreateComment: ReturnType<typeof vi.fn>;
}

function buildMockOctokit(): MockOctokit {
  const pullsListCommits = vi.fn();
  const pullsUpdate = vi.fn().mockResolvedValue({ data: {} });
  const pullsGet = vi.fn().mockResolvedValue({ data: { node_id: 'PR_node_id_42' } });
  const reposGetBranch = vi.fn().mockResolvedValue({ data: { commit: { sha: 'sha_branch_tip' } } });
  const reposGetBranchRules = vi.fn().mockResolvedValue({ data: [] });
  const actionsCreateDispatch = vi.fn().mockResolvedValue({});
  const actionsListRuns = vi.fn().mockResolvedValue({
    data: { workflow_runs: [{ id: 9999, head_branch: 'feature/x', status: 'completed' }] },
  });
  const actionsGetRun = vi
    .fn()
    .mockResolvedValue({ data: { status: 'completed', conclusion: 'success' } });
  const graphql = vi.fn().mockResolvedValue({});
  const issuesCreateComment = vi.fn().mockResolvedValue({ data: {} });
  const octokit = {
    rest: {
      pulls: { listCommits: pullsListCommits, update: pullsUpdate, get: pullsGet },
      repos: { getBranch: reposGetBranch, getBranchRules: reposGetBranchRules },
      actions: {
        createWorkflowDispatch: actionsCreateDispatch,
        listWorkflowRuns: actionsListRuns,
        getWorkflowRun: actionsGetRun,
      },
      issues: { createComment: issuesCreateComment },
    },
    graphql,
  } as unknown as Octokit;
  return {
    octokit,
    pullsListCommits,
    pullsUpdate,
    pullsGet,
    reposGetBranch,
    reposGetBranchRules,
    actionsCreateDispatch,
    actionsListRuns,
    actionsGetRun,
    graphql,
    issuesCreateComment,
  };
}

function buildConfig(overrides: Partial<Config['pipeline']> = {}): Config {
  return {
    pipeline: {
      branches: { develop: true, staging: false, main: false },
      merge_strategy: 'squash',
      auto_merge_types: ['fix', 'chore', 'refactor', 'perf', 'style', 'test'],
      publish_on_develop: true,
      publish_on_staging: true,
      merge_queue: 'auto',
      workflows: {
        build: 'pipeline-build.yml',
        publish: 'pipeline-publish.yml',
        quality: '',
      },
      ...overrides,
    },
    initial_version: '0.1.0',
  };
}

beforeEach(() => {
  vi.spyOn(core, 'info').mockImplementation(() => undefined);
  vi.spyOn(core, 'warning').mockImplementation(() => undefined);
});

const fixPr = (mock: MockOctokit): void => {
  mock.pullsListCommits.mockResolvedValue({
    data: [{ sha: 'sha1', commit: { message: 'fix: handle null token' } }],
  });
};

describe('runPrLifecycleWithOctokit > fix PR (auto-merge eligible) without quality workflow', () => {
  it('updates PR title+body once, no quality dispatch, enables auto-merge', async () => {
    const mock = buildMockOctokit();
    fixPr(mock);

    await runPrLifecycleWithOctokit(mock.octokit, buildConfig(), {
      prNumber: 42,
      sourceBranch: 'feature/x',
      targetBranch: 'develop',
      dryRun: false,
      repo: 'point-source/sandbox',
    });

    // Single update — no re-render because no quality dispatched.
    expect(mock.pullsUpdate).toHaveBeenCalledOnce();
    const updateCall = mock.pullsUpdate.mock.calls[0]![0];
    expect(updateCall.title).toBe('fix: handle null token');
    // Quality line MUST NOT appear when no quality workflow configured (learning #6).
    expect(updateCall.body).not.toContain('Quality checks');

    // No quality dispatch.
    expect(mock.actionsCreateDispatch).not.toHaveBeenCalled();

    // Auto-merge enabled via GraphQL.
    expect(mock.graphql).toHaveBeenCalledOnce();
    expect(mock.graphql.mock.calls[0]![0]).toMatch(/enablePullRequestAutoMerge/);

    // No "ready for review" comment posted.
    expect(mock.issuesCreateComment).not.toHaveBeenCalled();
  });
});

// Learning #5: re-render PR body after quality completes (else it freezes
// on "pending" forever). Two updates expected.
describe('runPrLifecycleWithOctokit > re-renders body after quality completes (learning #5)', () => {
  it('updates PR twice: once with "pending", once with "passed" after quality success', async () => {
    const mock = buildMockOctokit();
    fixPr(mock);
    const config = buildConfig({
      workflows: {
        build: 'pipeline-build.yml',
        publish: 'pipeline-publish.yml',
        quality: 'pipeline-quality.yml',
      },
    });

    await runPrLifecycleWithOctokit(mock.octokit, config, {
      prNumber: 42,
      sourceBranch: 'feature/x',
      targetBranch: 'develop',
      dryRun: false,
      repo: 'point-source/sandbox',
    });

    expect(mock.pullsUpdate).toHaveBeenCalledTimes(2);
    const firstBody = mock.pullsUpdate.mock.calls[0]![0].body;
    const secondBody = mock.pullsUpdate.mock.calls[1]![0].body;
    expect(firstBody).toContain('**Quality checks:** pending');
    expect(secondBody).toContain('**Quality checks:** ✅ passed');
    expect(secondBody).not.toContain('**Quality checks:** pending');

    // Quality was dispatched with the right inputs.
    expect(mock.actionsCreateDispatch).toHaveBeenCalledOnce();
    const dispatchCall = mock.actionsCreateDispatch.mock.calls[0]![0];
    expect(dispatchCall.workflow_id).toBe('pipeline-quality.yml');
    expect(dispatchCall.inputs).toEqual({ pr_number: '42', sha: 'sha_branch_tip' });
  });

  it('still re-renders to "❌ failed" then throws when quality fails', async () => {
    const mock = buildMockOctokit();
    fixPr(mock);
    mock.actionsGetRun.mockResolvedValue({
      data: { status: 'completed', conclusion: 'failure' },
    });
    const config = buildConfig({
      workflows: {
        build: 'pipeline-build.yml',
        publish: 'pipeline-publish.yml',
        quality: 'pipeline-quality.yml',
      },
    });

    await expect(
      runPrLifecycleWithOctokit(mock.octokit, config, {
        prNumber: 42,
        sourceBranch: 'feature/x',
        targetBranch: 'develop',
        dryRun: false,
        repo: 'point-source/sandbox',
      }),
    ).rejects.toThrow(/quality workflow failed/);

    // Body MUST be re-rendered before the throw, so reviewers see the failure.
    expect(mock.pullsUpdate).toHaveBeenCalledTimes(2);
    expect(mock.pullsUpdate.mock.calls[1]![0].body).toContain('❌ failed');
    expect(mock.graphql).not.toHaveBeenCalled(); // no auto-merge on failure
  });
});

describe('runPrLifecycleWithOctokit > human-review path', () => {
  it('posts "ready for review" comment for feat (not in default allowlist)', async () => {
    const mock = buildMockOctokit();
    mock.pullsListCommits.mockResolvedValue({
      data: [{ sha: 'sha1', commit: { message: 'feat: add OAuth flow' } }],
    });

    await runPrLifecycleWithOctokit(mock.octokit, buildConfig(), {
      prNumber: 42,
      sourceBranch: 'feature/x',
      targetBranch: 'develop',
      dryRun: false,
      repo: 'point-source/sandbox',
    });

    expect(mock.graphql).not.toHaveBeenCalled(); // no auto-merge for feat
    expect(mock.issuesCreateComment).toHaveBeenCalledOnce();
    expect(mock.issuesCreateComment.mock.calls[0]![0].body).toMatch(/Ready for human review/);
  });

  it('posts "ready for review" for breaking change even if type is in allowlist', async () => {
    const mock = buildMockOctokit();
    mock.pullsListCommits.mockResolvedValue({
      data: [{ sha: 'sha1', commit: { message: 'fix!: drop legacy auth' } }],
    });

    await runPrLifecycleWithOctokit(mock.octokit, buildConfig(), {
      prNumber: 42,
      sourceBranch: 'feature/x',
      targetBranch: 'develop',
      dryRun: false,
      repo: 'point-source/sandbox',
    });

    expect(mock.graphql).not.toHaveBeenCalled();
    expect(mock.issuesCreateComment).toHaveBeenCalledOnce();
  });
});

describe('runPrLifecycleWithOctokit > strict commit parsing', () => {
  it('throws if any commit is non-conventional (gates the required check)', async () => {
    const mock = buildMockOctokit();
    mock.pullsListCommits.mockResolvedValue({
      data: [
        { sha: 'sha1', commit: { message: 'fix: ok' } },
        { sha: 'sha2', commit: { message: 'update foo' } },
      ],
    });

    await expect(
      runPrLifecycleWithOctokit(mock.octokit, buildConfig(), {
        prNumber: 42,
        sourceBranch: 'feature/x',
        targetBranch: 'develop',
        dryRun: false,
        repo: 'point-source/sandbox',
      }),
    ).rejects.toThrow(/conventional-commit/);
    expect(mock.pullsUpdate).not.toHaveBeenCalled();
  });
});
