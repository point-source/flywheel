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
  /** Pluggable sleeper (tests pass a no-op). Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Max attempts on transient "unstable status" errors. Defaults to 6. */
  maxAttempts?: number;
}

/**
 * `not_allowed` means the repo has `Allow auto-merge` disabled (spec §565
 * requires it to be on). Surfaced separately from `merged` so callers can
 * fall back to a human-review comment instead of crashing the run.
 */
export type AutoMergeResult = 'merged' | 'enqueued' | 'skipped' | 'not_allowed';

/**
 * Either enable GitHub native auto-merge on the PR, or add it to the merge
 * queue, depending on `useQueue`. Both flows are eventually-consistent —
 * GitHub completes the merge once required checks pass.
 *
 * Per spec.md §54, this is the only auto-merge path. Manual merges go
 * through the human-review flow.
 *
 * If the repo has auto-merge disabled (`Allow auto-merge: Disabled` in
 * Settings → General), GraphQL returns "Auto merge is not allowed for this
 * repository". We catch that specific error and return `'not_allowed'` so
 * pr-lifecycle can fall back to a comment + warning instead of failing the
 * required check. Other GraphQL errors propagate.
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

  // Retry loop for the "Pull request is in unstable status" transient. After
  // a quality workflow completes, GitHub takes a few seconds to update the
  // PR's mergeable_state from UNKNOWN/UNSTABLE to CLEAN. Calling auto-merge
  // during that window throws — retrying with backoff lets the eventual
  // consistency settle. `not_allowed` is NOT retried (it's a settings issue,
  // not a race), and unrecognized errors propagate.
  const sleep = opts.sleep ?? defaultSleep;
  const maxAttempts = opts.maxAttempts ?? 6;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await enableAutoMergeViaGraphQL(opts);
      return 'merged';
    } catch (err) {
      if (isAutoMergeNotAllowedError(err)) {
        return 'not_allowed';
      }
      if (!isUnstableStatusError(err)) {
        throw err;
      }
      lastErr = err;
      if (attempt < maxAttempts) {
        // 5s × attempt: 5, 10, 15, 20, 25 seconds — total ~75s before giving up
        await sleep(5000 * attempt);
      }
    }
  }
  throw lastErr;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function isAutoMergeNotAllowedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Octokit's GraphqlResponseError flattens error messages into err.message.
  // The exact GitHub phrasing is stable: "Auto merge is not allowed for this
  // repository". Match on the substring to remain resilient to small wording
  // changes (e.g. trailing punctuation).
  return /Auto merge is not allowed/i.test(err.message);
}

function isUnstableStatusError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // GraphQL phrasing: "Pull request is in unstable status". This means
  // GitHub hasn't yet computed the PR's mergeable_state after a recent
  // commit / check-run completion. Transient — retries fix it.
  return /Pull request is in unstable status/i.test(err.message);
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
