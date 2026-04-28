import * as core from '@actions/core';
import type { Octokit } from '../github/octokit.js';

export type MergeQueueOverride = 'auto' | boolean;

export interface DetectMergeQueueOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  branch: string;
  override: MergeQueueOverride;
}

/**
 * Determine whether GitHub merge queue is enabled on the given branch.
 *
 * Resolution order (per spec.md §625):
 *   1. If override is `true` or `false`, return it directly.
 *   2. Otherwise (override === 'auto'), query the branch's rules and return
 *      true iff any rule has `type === 'merge_queue'`.
 *   3. On API error (auth, network, 404 for repos without ruleset access),
 *      log a warning and return `false`. Safe fallback per learning #8 —
 *      defaulting to true could enqueue PRs into a non-existent queue.
 */
export async function isMergeQueueEnabled(
  opts: DetectMergeQueueOptions,
): Promise<boolean> {
  if (opts.override === true || opts.override === false) {
    return opts.override;
  }
  // override === 'auto'
  try {
    const { data: rules } = await opts.octokit.rest.repos.getBranchRules({
      owner: opts.owner,
      repo: opts.repo,
      branch: opts.branch,
    });
    // `merge_queue` is a valid rule type at the GitHub API but isn't in the
    // older Octokit type union. Cast to a wider shape for the comparison.
    return rules.some((r) => (r as { type: string }).type === 'merge_queue');
  } catch (err) {
    // Surface the auth/API error as a warning — silent false-defaults
    // hid real misconfigurations in the bash version (learning #8).
    const message = err instanceof Error ? err.message : String(err);
    core.warning(
      `merge-queue detection failed for ${opts.owner}/${opts.repo}@${opts.branch}: ${message}. Defaulting to false.`,
    );
    return false;
  }
}
