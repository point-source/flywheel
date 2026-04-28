import type { ConventionalCommit } from './commits.js';

/**
 * Select the commit whose conventional-commit title should become the PR title.
 *
 * Rule: highest version-bump signal wins (breaking > feat > fix/perf > others).
 * On ties, the earliest commit wins (stable order).
 *
 * Why: when squash merging is enabled (the spec default per §57), the squash
 * commit message defaults to the PR title. release-please re-parses the squash
 * commit on the target branch to compute the next version. If we picked a
 * lower-bump commit's title, the squashed commit would under-represent the
 * change set — e.g., a PR with [feat, fix] picking the fix as title becomes a
 * patch bump on push, not the minor it should be. Learning #4 from
 * docs/adr/0001-typescript-rewrite.md.
 */
export function selectTitleCommit(
  commits: readonly ConventionalCommit[],
): ConventionalCommit | null {
  if (commits.length === 0) return null;
  let best: ConventionalCommit | null = null;
  let bestRank = -1;
  for (const c of commits) {
    const rank = bumpRank(c);
    if (rank > bestRank) {
      best = c;
      bestRank = rank;
    }
  }
  return best;
}

function bumpRank(c: ConventionalCommit): number {
  if (c.breaking) return 4;
  if (c.type === 'feat') return 3;
  if (c.type === 'fix' || c.type === 'perf') return 2;
  if (c.type !== '') return 1; // other valid conventional types
  return 0;
}

/**
 * Format a single commit as a conventional-commit title:
 *   `<type>(<scope>)?<!>?: <description>`
 *
 * Preserves the `!` suffix for breaking changes (spec §22 — non-configurable).
 */
export function formatTitle(c: ConventionalCommit): string {
  const scope = c.scope ? `(${c.scope})` : '';
  const breaking = c.breaking ? '!' : '';
  return `${c.type}${scope}${breaking}: ${c.bareMessage}`;
}
