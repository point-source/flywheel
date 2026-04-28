import { type Commit, type ConventionalCommit } from 'release-please';
// release-please re-exports the Commit/ConventionalCommit *types* from its
// main entrypoint but does NOT re-export the `parseConventionalCommits`
// function. Deep-import it from the same internal module per spec.md §41
// ("release-please as a library"). If the path breaks in a future major,
// our unit tests catch it.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no .d.ts at this path; the function is exported in commit.js
import { parseConventionalCommits } from 'release-please/build/src/commit.js';

/**
 * The version-bump signal computed from a set of commits, per spec.md §424.
 *
 * `none` is distinct from `patch` because chore-only / style-only / test-only
 * pushes produce no version tag (spec §427) — but may still publish a build
 * artifact (spec §440).
 */
export type Bump = 'major' | 'minor' | 'patch' | 'none';

/** Re-export for callers who only depend on this module. */
export type { Commit, ConventionalCommit };

/**
 * Parse raw git commits into conventional-commits using release-please's
 * library, per spec.md §41 ("release-please as a library, not orchestrator").
 *
 * release-please's parser handles BREAKING CHANGE footers, ! suffix on type,
 * multiline bodies, and the conventional-commits AST. We don't reimplement.
 */
export function parseCommits(raw: Commit[]): ConventionalCommit[] {
  return parseConventionalCommits(raw);
}

/**
 * Determine the version-bump signal across a set of conventional commits, per
 * spec.md §423–427.
 *
 *   - any breaking change (`!` or `BREAKING CHANGE` footer)  → major
 *   - any feat                                                → minor
 *   - any fix or perf                                         → patch
 *   - everything else (chore, style, test, docs, refactor)    → none
 *
 * Spec §427 explicitly groups `refactor` under "no version bump". This differs
 * from release-please's default mapping (which treats refactor as patch), so
 * we don't delegate this — we encode spec rules directly.
 */
export function computeBump(commits: ConventionalCommit[]): Bump {
  let bump: Bump = 'none';
  for (const c of commits) {
    if (c.breaking) return 'major';
    if (c.type === 'feat') {
      bump = bump === 'none' ? 'minor' : bump;
      // keep scanning — a later commit may be breaking
      if (bump === 'patch') bump = 'minor';
    } else if (c.type === 'fix' || c.type === 'perf') {
      if (bump === 'none') bump = 'patch';
    }
  }
  return bump;
}

/**
 * Returns true if every commit's type is in the allowlist AND no commit is
 * breaking. Per spec.md §22, breaking-change is a non-configurable override —
 * even types in the allowlist are gated for human review when ! is present.
 */
export function isAutoMergeable(
  commits: ConventionalCommit[],
  allowedTypes: readonly string[],
): boolean {
  if (commits.length === 0) return false;
  if (commits.some((c) => c.breaking)) return false;
  return commits.every((c) => allowedTypes.includes(c.type));
}

export class InvalidCommitError extends Error {
  constructor(
    public readonly invalidCount: number,
    public readonly examples: string[],
  ) {
    super(
      `${invalidCount} commit(s) do not match conventional-commit format. Examples: ${examples.slice(0, 3).join('; ')}`,
    );
    this.name = 'InvalidCommitError';
  }
}

/**
 * Parse and reject if any commits are non-conventional. Used in pr-lifecycle
 * to gate the PR's required check on commit format compliance.
 *
 * release-please's parser silently drops malformed commits (treats them as
 * having an empty type). To reject, we count input vs output and surface the
 * difference. The first 3 invalid commits are included as examples.
 */
export function parseCommitsStrict(raw: Commit[]): ConventionalCommit[] {
  const parsed = parseConventionalCommits(raw);
  // Map parsed back to source by sha. A commit may produce multiple parsed
  // entries (split on BREAKING CHANGE footer), but every input sha should
  // appear in at least one parsed entry with a non-empty type.
  const validShas = new Set(parsed.filter((c) => c.type !== '').map((c) => c.sha));
  const invalid = raw.filter((c) => !validShas.has(c.sha));
  if (invalid.length > 0) {
    throw new InvalidCommitError(
      invalid.length,
      invalid.map((c) => c.message.split('\n')[0] ?? c.sha),
    );
  }
  return parsed;
}
