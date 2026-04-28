import { describe, it, expect } from 'vitest';
import { parseCommits } from './commits.js';
import { selectTitleCommit, formatTitle } from './pr-title.js';

const c = (sha: string, message: string) => ({ sha, message });

describe('selectTitleCommit', () => {
  it('returns null for empty input', () => {
    expect(selectTitleCommit([])).toBeNull();
  });

  // Learning #4: highest bump wins so squash-on-merge produces the right
  // version on push.
  it('selects feat over fix when both present', () => {
    const commits = parseCommits([c('a', 'fix: bug'), c('b', 'feat: new flow')]);
    const selected = selectTitleCommit(commits);
    expect(selected?.type).toBe('feat');
  });

  it('selects breaking over feat', () => {
    const commits = parseCommits([
      c('a', 'feat: new flow'),
      c('b', 'fix!: drop legacy behavior'),
    ]);
    const selected = selectTitleCommit(commits);
    expect(selected?.breaking).toBe(true);
  });

  it('falls back to first valid commit when no bump-worthy types present', () => {
    const commits = parseCommits([c('a', 'chore: bump deps'), c('b', 'docs: clarify')]);
    const selected = selectTitleCommit(commits);
    expect(selected?.sha).toBe('a');
  });

  it('preserves order on ties (first wins)', () => {
    const commits = parseCommits([c('a', 'fix: first'), c('b', 'fix: second')]);
    const selected = selectTitleCommit(commits);
    expect(selected?.sha).toBe('a');
  });
});

describe('formatTitle', () => {
  it('formats with scope', () => {
    const [parsed] = parseCommits([c('a', 'feat(auth): add OAuth flow')]);
    expect(formatTitle(parsed!)).toBe('feat(auth): add OAuth flow');
  });

  it('formats without scope', () => {
    const [parsed] = parseCommits([c('a', 'fix: handle null')]);
    expect(formatTitle(parsed!)).toBe('fix: handle null');
  });

  it('preserves the breaking ! marker', () => {
    const [parsed] = parseCommits([c('a', 'feat!: drop legacy')]);
    expect(formatTitle(parsed!)).toBe('feat!: drop legacy');
  });

  it('preserves scope and ! together', () => {
    const [parsed] = parseCommits([c('a', 'refactor(api)!: rename endpoints')]);
    expect(formatTitle(parsed!)).toBe('refactor(api)!: rename endpoints');
  });
});
