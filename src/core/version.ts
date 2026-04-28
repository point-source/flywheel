import semver from 'semver';
import type { Bump } from './commits.js';

/**
 * Abstraction over the small set of git operations version computation needs.
 * The real implementation lives in `src/github/git.ts`; tests use an in-memory
 * fake. This is what makes version.ts unit-testable without git fixtures.
 */
export interface GitProvider {
  /**
   * Find the latest release tag reachable from HEAD, excluding pre-release
   * tags (anything with a hyphen). Returns null if no matching tag exists.
   *
   * Implementation detail: `git describe --tags --abbrev=0 --exclude='*-*'`.
   * The `--exclude='*-*'` is the reachability-aware filter (learning #1).
   */
  describeReachableReleaseTag(): Promise<string | null>;

  /**
   * List all tags matching a glob (e.g. `v1.2.3-dev.*`). Used to compute the
   * next pre-release counter at a given base version.
   */
  listTagsMatching(pattern: string): Promise<string[]>;
}

export interface ComputeVersionInput {
  /** Branch we're computing for. Determines the pre-release suffix. */
  branch: 'develop' | 'staging' | 'main';
  /** Bump signal from commits since the last release tag. */
  bump: Bump;
  /** Fallback when there's no reachable release tag. */
  initialVersion: string;
  git: GitProvider;
}

export interface ComputedVersion {
  /** Full semver string, e.g. "1.2.0", "1.2.0-dev.3", "1.2.0-rc.1". */
  version: string;
  /** Base version stripped of pre-release suffix. */
  baseVersion: string;
  /** True if a new tag should be created (false for chore-only on main). */
  hasChanges: boolean;
}

/**
 * Compute the next version per spec.md §417. Pure function modulo the
 * GitProvider — pass an in-memory provider in tests.
 *
 * Rules:
 *   1. Find latest reachable release tag (or `initialVersion` if none).
 *   2. Apply bump to get the next base version. For bump=none, treat as
 *      patch when computing PRE-RELEASE versions (so chore-only develop
 *      pushes get a build identifier), but mark hasChanges=false.
 *   3. On develop: append `-dev.N` where N increments from existing
 *      `<base>-dev.*` tags. Spec §428 says "for this base version" —
 *      counters are scoped to the base, not global.
 *   4. On staging: append `-rc.N` similarly.
 *   5. On main: no suffix. If bump=none, hasChanges=false (no release).
 */
export async function computeVersion(input: ComputeVersionInput): Promise<ComputedVersion> {
  const reachableTag = await input.git.describeReachableReleaseTag();
  const reachableBase = reachableTag ? stripV(reachableTag) : input.initialVersion;
  // Defensive: if the tag isn't valid semver, fall back to initialVersion.
  const validatedBase = semver.valid(reachableBase) ? reachableBase : input.initialVersion;

  const hasRealBump = input.bump !== 'none';
  // For pre-release builds we always need a "next" version; treat bump=none
  // as patch-implied. For main releases, bump=none means no tag at all.
  const effectiveBump: Exclude<Bump, 'none'> = hasRealBump ? (input.bump as Exclude<Bump, 'none'>) : 'patch';
  const nextBase = bumpBase(validatedBase, effectiveBump);

  if (input.branch === 'main') {
    return {
      version: nextBase,
      baseVersion: nextBase,
      hasChanges: hasRealBump,
    };
  }

  const suffix = input.branch === 'develop' ? 'dev' : 'rc';
  const counter = await nextPreReleaseCounter(nextBase, suffix, input.git);
  return {
    version: `${nextBase}-${suffix}.${counter}`,
    baseVersion: nextBase,
    // Pre-release "tags" still get created on every push to develop/staging
    // EXCEPT chore-only pushes (where no version tag is produced per spec).
    hasChanges: hasRealBump,
  };
}

function stripV(tag: string): string {
  return tag.startsWith('v') ? tag.slice(1) : tag;
}

function bumpBase(base: string, bump: Exclude<Bump, 'none'>): string {
  const next = semver.inc(base, bump);
  if (!next) {
    throw new Error(`semver.inc returned null for base="${base}" bump="${bump}"`);
  }
  return next;
}

/**
 * Find the next pre-release counter for the given base version + suffix
 * (`dev` or `rc`). Returns 1 if no prior pre-release exists at this base.
 *
 * Pre-release counters are scoped to the base version per spec.md §428
 * ("for this base version"). The reachability-aware base lookup is what
 * keeps counters from drifting across branches in practice — develop and
 * staging share the same release-tag base when their histories haven't
 * diverged yet.
 */
async function nextPreReleaseCounter(
  base: string,
  suffix: 'dev' | 'rc',
  git: GitProvider,
): Promise<number> {
  const pattern = `v${base}-${suffix}.*`;
  const tags = await git.listTagsMatching(pattern);
  let max = 0;
  for (const tag of tags) {
    const match = tag.match(new RegExp(`^v${escapeRegex(base)}-${suffix}\\.(\\d+)$`));
    if (!match) continue;
    const n = Number.parseInt(match[1]!, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
