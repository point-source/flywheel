import { describe, it, expect } from 'vitest';
import {
  parseCommits,
  parseCommitsStrict,
  computeBump,
  isAutoMergeable,
  InvalidCommitError,
  type Commit,
} from './commits.js';

const c = (sha: string, message: string): Commit => ({ sha, message });

describe('parseCommits', () => {
  it('extracts type, scope, breaking from a typical fix', () => {
    const [parsed] = parseCommits([c('a1', 'fix(auth): handle empty token')]);
    expect(parsed).toBeDefined();
    expect(parsed!.type).toBe('fix');
    expect(parsed!.scope).toBe('auth');
    expect(parsed!.breaking).toBe(false);
  });

  it('marks ! suffix as breaking', () => {
    const [parsed] = parseCommits([c('a1', 'feat!: drop legacy auth')]);
    expect(parsed!.type).toBe('feat');
    expect(parsed!.breaking).toBe(true);
  });

  it('marks BREAKING CHANGE footer as breaking on multiline body', () => {
    const [parsed] = parseCommits([
      c('a1', 'feat: new flow\n\nBody text.\n\nBREAKING CHANGE: removes the old API'),
    ]);
    expect(parsed!.breaking).toBe(true);
  });
});

describe('computeBump', () => {
  it('returns none for chore/style/test/docs/refactor only (spec §427)', () => {
    const commits = parseCommits([
      c('a', 'chore: bump deps'),
      c('b', 'style: format'),
      c('c', 'test: cover edge case'),
      c('d', 'docs: clarify'),
      c('e', 'refactor: rename'),
    ]);
    expect(computeBump(commits)).toBe('none');
  });

  it('returns patch for fix-only and perf-only', () => {
    expect(computeBump(parseCommits([c('a', 'fix: bug')]))).toBe('patch');
    expect(computeBump(parseCommits([c('a', 'perf: faster')]))).toBe('patch');
  });

  it('returns minor when feat is present', () => {
    const commits = parseCommits([c('a', 'fix: bug'), c('b', 'feat: new')]);
    expect(computeBump(commits)).toBe('minor');
  });

  // Learning #4: highest bump wins — a feat alongside a fix MUST yield minor,
  // otherwise the squash-merged commit (with PR title = the feat) would
  // under-bump on push.
  it('returns major when any commit is breaking, regardless of order', () => {
    const ordered = parseCommits([c('a', 'feat: x'), c('b', 'fix!: dropped')]);
    expect(computeBump(ordered)).toBe('major');
    const reversed = parseCommits([c('a', 'fix!: dropped'), c('b', 'feat: x')]);
    expect(computeBump(reversed)).toBe('major');
  });

  it('returns none for empty input', () => {
    expect(computeBump([])).toBe('none');
  });
});

describe('isAutoMergeable', () => {
  const ALLOWED = ['fix', 'chore', 'refactor', 'perf', 'style', 'test'] as const;

  it('rejects empty commit list (no PR is auto-mergeable with zero commits)', () => {
    expect(isAutoMergeable([], ALLOWED)).toBe(false);
  });

  it('accepts when every commit type is in allowlist', () => {
    const commits = parseCommits([c('a', 'fix: bug'), c('b', 'chore: deps')]);
    expect(isAutoMergeable(commits, ALLOWED)).toBe(true);
  });

  it('rejects feat (not in default allowlist per spec §16)', () => {
    const commits = parseCommits([c('a', 'feat: new flow')]);
    expect(isAutoMergeable(commits, ALLOWED)).toBe(false);
  });

  it('rejects breaking change even for allowed types (spec §22 override)', () => {
    const commits = parseCommits([c('a', 'fix!: dropped behavior')]);
    expect(isAutoMergeable(commits, ALLOWED)).toBe(false);
  });
});

describe('parseCommitsStrict > invalid conventional commits', () => {
  it('throws InvalidCommitError on bare unprefixed messages', () => {
    expect(() => parseCommitsStrict([c('a1', 'update foo')])).toThrow(InvalidCommitError);
  });

  it('reports invalid count and first 3 example messages', () => {
    try {
      parseCommitsStrict([
        c('a', 'update foo'),
        c('b', 'WIP'),
        c('c', 'fix: ok'),
        c('d', 'broken commit'),
        c('e', 'another bad one'),
      ]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidCommitError);
      const e = err as InvalidCommitError;
      expect(e.invalidCount).toBe(4);
      expect(e.examples).toHaveLength(4);
      expect(e.message).toContain('4 commit(s)');
    }
  });

  it('accepts valid mixed-type batches', () => {
    const result = parseCommitsStrict([
      c('a', 'fix: bug'),
      c('b', 'feat(auth): add flow'),
      c('c', 'chore: bump deps'),
    ]);
    expect(result).toHaveLength(3);
  });
});
