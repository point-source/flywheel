import type { Octokit } from '../github/octokit.js';

export type MergeStrategy = 'squash' | 'merge' | 'rebase';

export interface AutoMergeOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  prNumber: number;
  prNodeId: string;
  /** True to enqueue (merge queue), false to enable native auto-merge. */
  useQueue: boolean;
  mergeStrategy: MergeStrategy;
  dryRun: boolean;
}

export type AutoMergeResult = 'merged' | 'enqueued' | 'skipped';

/**
 * Either enable GitHub native auto-merge on the PR, or add it to the merge
 * queue, depending on `useQueue`. Both flows are eventually-consistent —
 * GitHub completes the merge once required checks pass.
 *
 * Per spec.md §54, this is the only auto-merge path. Manual merges go
 * through the human-review flow.
 */
export async function enableAutoMergeOrEnqueue(
  opts: AutoMergeOptions,
): Promise<AutoMergeResult> {
  if (opts.dryRun) {
    return 'skipped';
  }

  if (opts.useQueue) {
    await enqueueViaGraphQL(opts);
    return 'enqueued';
  }

  await enableAutoMergeViaGraphQL(opts);
  return 'merged';
}

/**
 * GraphQL mutation: enablePullRequestAutoMerge. Maps the REST mergeStrategy
 * to the enum the GraphQL API expects.
 */
async function enableAutoMergeViaGraphQL(opts: AutoMergeOptions): Promise<void> {
  const mergeMethod = mergeStrategyToGraphQL(opts.mergeStrategy);
  await opts.octokit.graphql<unknown>(
    `mutation($prId: ID!, $mergeMethod: PullRequestMergeMethod!) {
       enablePullRequestAutoMerge(input: {
         pullRequestId: $prId,
         mergeMethod: $mergeMethod
       }) {
         pullRequest { id, autoMergeRequest { enabledAt } }
       }
     }`,
    {
      prId: opts.prNodeId,
      mergeMethod,
    },
  );
}

/**
 * GraphQL mutation: enqueuePullRequest. The merge-queue enum is shared
 * with native auto-merge.
 */
async function enqueueViaGraphQL(opts: AutoMergeOptions): Promise<void> {
  await opts.octokit.graphql<unknown>(
    `mutation($prId: ID!) {
       enqueuePullRequest(input: { pullRequestId: $prId }) {
         mergeQueueEntry { position }
       }
     }`,
    {
      prId: opts.prNodeId,
    },
  );
}

function mergeStrategyToGraphQL(s: MergeStrategy): 'SQUASH' | 'MERGE' | 'REBASE' {
  switch (s) {
    case 'squash':
      return 'SQUASH';
    case 'merge':
      return 'MERGE';
    case 'rebase':
      return 'REBASE';
  }
}
