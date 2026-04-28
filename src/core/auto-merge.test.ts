import { describe, it, expect, vi } from 'vitest';
import { enableAutoMergeOrEnqueue } from './auto-merge.js';
import type { Octokit } from '../github/octokit.js';

function fakeOctokit(): { octokit: Octokit; graphql: ReturnType<typeof vi.fn> } {
  const graphql = vi.fn().mockResolvedValue({});
  const octokit = { graphql } as unknown as Octokit;
  return { octokit, graphql };
}

describe('enableAutoMergeOrEnqueue > dry-run', () => {
  it('returns "skipped" without any API call when dryRun=true', async () => {
    const { octokit, graphql } = fakeOctokit();
    const result = await enableAutoMergeOrEnqueue({
      octokit,
      owner: 'o',
      repo: 'r',
      prNumber: 1,
      prNodeId: 'PR_id',
      useQueue: false,
      mergeStrategy: 'squash',
      dryRun: true,
    });
    expect(result).toBe('skipped');
    expect(graphql).not.toHaveBeenCalled();
  });
});

// Additional coverage from the plan: each merge_strategy maps to the right
// GraphQL enum.
describe('enableAutoMergeOrEnqueue > merge strategy mapping', () => {
  it('maps squash → SQUASH', async () => {
    const { octokit, graphql } = fakeOctokit();
    await enableAutoMergeOrEnqueue({
      octokit, owner: 'o', repo: 'r', prNumber: 1, prNodeId: 'id',
      useQueue: false, mergeStrategy: 'squash', dryRun: false,
    });
    expect(graphql).toHaveBeenCalledOnce();
    expect(graphql.mock.calls[0]![1]).toEqual({ prId: 'id', mergeMethod: 'SQUASH' });
  });

  it('maps merge → MERGE', async () => {
    const { octokit, graphql } = fakeOctokit();
    await enableAutoMergeOrEnqueue({
      octokit, owner: 'o', repo: 'r', prNumber: 1, prNodeId: 'id',
      useQueue: false, mergeStrategy: 'merge', dryRun: false,
    });
    expect(graphql.mock.calls[0]![1]).toEqual({ prId: 'id', mergeMethod: 'MERGE' });
  });

  it('maps rebase → REBASE', async () => {
    const { octokit, graphql } = fakeOctokit();
    await enableAutoMergeOrEnqueue({
      octokit, owner: 'o', repo: 'r', prNumber: 1, prNodeId: 'id',
      useQueue: false, mergeStrategy: 'rebase', dryRun: false,
    });
    expect(graphql.mock.calls[0]![1]).toEqual({ prId: 'id', mergeMethod: 'REBASE' });
  });
});

// Spec §565 requires "Allow auto-merge: Enabled" in repo settings. When an
// adopter forgets, the GraphQL mutation returns "Auto merge is not allowed
// for this repository". We surface this as `'not_allowed'` so callers can
// fall back gracefully instead of failing the required check.
describe('enableAutoMergeOrEnqueue > auto-merge disabled in repo settings', () => {
  it('returns "not_allowed" when GraphQL throws "Auto merge is not allowed"', async () => {
    const { octokit, graphql } = fakeOctokit();
    graphql.mockRejectedValueOnce(
      new Error(
        'Request failed due to following response errors:\n - Auto merge is not allowed for this repository',
      ),
    );
    const result = await enableAutoMergeOrEnqueue({
      octokit, owner: 'o', repo: 'r', prNumber: 1, prNodeId: 'id',
      useQueue: false, mergeStrategy: 'squash', dryRun: false,
    });
    expect(result).toBe('not_allowed');
  });

  it('rethrows other GraphQL errors (does not silently swallow)', async () => {
    const { octokit, graphql } = fakeOctokit();
    graphql.mockRejectedValueOnce(new Error('Some other GitHub error'));
    await expect(
      enableAutoMergeOrEnqueue({
        octokit, owner: 'o', repo: 'r', prNumber: 1, prNodeId: 'id',
        useQueue: false, mergeStrategy: 'squash', dryRun: false,
      }),
    ).rejects.toThrow('Some other GitHub error');
  });
});

// "Pull request is in unstable status" is GitHub's eventually-consistent
// state right after a check completes — the PR's mergeable_state hasn't
// yet flipped to CLEAN. We retry with backoff so the run doesn't fail on
// a transient timing issue.
describe('enableAutoMergeOrEnqueue > unstable status retry', () => {
  it('retries on "Pull request is in unstable status" and succeeds on a later attempt', async () => {
    const { octokit, graphql } = fakeOctokit();
    graphql
      .mockRejectedValueOnce(
        new Error('Request failed: Pull request is in unstable status'),
      )
      .mockRejectedValueOnce(
        new Error('Request failed: Pull request is in unstable status'),
      )
      .mockResolvedValueOnce({});
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await enableAutoMergeOrEnqueue({
      octokit, owner: 'o', repo: 'r', prNumber: 1, prNodeId: 'id',
      useQueue: false, mergeStrategy: 'squash', dryRun: false,
      sleep,
    });

    expect(result).toBe('merged');
    expect(graphql).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2); // sleep BETWEEN retries, not after the final
  });

  it('throws after maxAttempts if unstable persists', async () => {
    const { octokit, graphql } = fakeOctokit();
    graphql.mockRejectedValue(
      new Error('Request failed: Pull request is in unstable status'),
    );
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      enableAutoMergeOrEnqueue({
        octokit, owner: 'o', repo: 'r', prNumber: 1, prNodeId: 'id',
        useQueue: false, mergeStrategy: 'squash', dryRun: false,
        sleep, maxAttempts: 3,
      }),
    ).rejects.toThrow('Pull request is in unstable status');
    expect(graphql).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry on "not allowed" — returns immediately', async () => {
    const { octokit, graphql } = fakeOctokit();
    graphql.mockRejectedValueOnce(
      new Error('Request failed: Auto merge is not allowed for this repository'),
    );
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await enableAutoMergeOrEnqueue({
      octokit, owner: 'o', repo: 'r', prNumber: 1, prNodeId: 'id',
      useQueue: false, mergeStrategy: 'squash', dryRun: false,
      sleep,
    });

    expect(result).toBe('not_allowed');
    expect(graphql).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('enableAutoMergeOrEnqueue > merge queue routing', () => {
  it('uses enqueuePullRequest when useQueue=true', async () => {
    const { octokit, graphql } = fakeOctokit();
    const result = await enableAutoMergeOrEnqueue({
      octokit, owner: 'o', repo: 'r', prNumber: 1, prNodeId: 'id',
      useQueue: true, mergeStrategy: 'squash', dryRun: false,
    });
    expect(result).toBe('enqueued');
    expect(graphql).toHaveBeenCalledOnce();
    expect(graphql.mock.calls[0]![0]).toMatch(/enqueuePullRequest/);
  });

  it('uses enablePullRequestAutoMerge when useQueue=false', async () => {
    const { octokit, graphql } = fakeOctokit();
    const result = await enableAutoMergeOrEnqueue({
      octokit, owner: 'o', repo: 'r', prNumber: 1, prNodeId: 'id',
      useQueue: false, mergeStrategy: 'squash', dryRun: false,
    });
    expect(result).toBe('merged');
    expect(graphql.mock.calls[0]![0]).toMatch(/enablePullRequestAutoMerge/);
  });
});
