import { getOctokit as actionsGetOctokit } from '@actions/github';

/**
 * Type of the Octokit instance returned by `@actions/github`'s `getOctokit`.
 * Exposed because callers throughout the codebase need to declare parameters
 * of this shape, and `@actions/github` doesn't export a named type.
 */
export type Octokit = ReturnType<typeof actionsGetOctokit>;

/**
 * Build a configured Octokit client from an installation token. Wraps
 * `@actions/github`'s factory so all our call sites have one place to
 * inject test doubles, retry policies, etc. as the project evolves.
 */
export function getOctokit(token: string): Octokit {
  return actionsGetOctokit(token);
}
