import type { Octokit } from '../github/octokit.js';

export interface UpsertPullRequestOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
  /** If creating a new PR, mark it as draft. Defaults to false. */
  draft?: boolean;
}

export interface UpsertResult {
  number: number;
  created: boolean;
}

/**
 * Idempotent "find an existing PR by (head, base) and update its title/body,
 * or create a new one if none exists." Used by promote.ts to maintain
 * promotion PRs whose body should always reflect the cumulative changelog.
 *
 * GitHub's `head` filter on listPullRequests requires the `owner:branch`
 * form when filtering across forks, but for in-repo PRs the bare branch
 * name works. We match on both base and head to be unambiguous.
 */
export async function upsertPullRequest(opts: UpsertPullRequestOptions): Promise<UpsertResult> {
  const { octokit, owner, repo, head, base, title, body } = opts;

  // List open PRs with this head + base. There should be 0 or 1.
  const { data: existing } = await octokit.rest.pulls.list({
    owner,
    repo,
    state: 'open',
    head: `${owner}:${head}`,
    base,
    per_page: 1,
  });

  if (existing.length > 0) {
    const pr = existing[0]!;
    await octokit.rest.pulls.update({
      owner,
      repo,
      pull_number: pr.number,
      title,
      body,
    });
    return { number: pr.number, created: false };
  }

  const { data: created } = await octokit.rest.pulls.create({
    owner,
    repo,
    head,
    base,
    title,
    body,
    draft: opts.draft ?? false,
  });
  return { number: created.number, created: true };
}
