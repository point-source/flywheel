import { describe, it, expect } from 'vitest';
import { renderChangelogFragment, prependFragment } from './changelog.js';
import type { ConventionalCommit } from './commits.js';

function commit(partial: Partial<ConventionalCommit> & { sha: string; type: string }): ConventionalCommit {
  return {
    sha: partial.sha,
    message: partial.message ?? '',
    type: partial.type,
    scope: partial.scope ?? null,
    bareMessage: partial.bareMessage ?? 'a change',
    notes: partial.notes ?? [],
    references: partial.references ?? [],
    breaking: partial.breaking ?? false,
  } as ConventionalCommit;
}

describe('renderChangelogFragment', () => {
  it('emits a compare-link header when previousVersion is provided', () => {
    const out = renderChangelogFragment({
      commits: [commit({ sha: 'a'.repeat(40), type: 'feat', bareMessage: 'add thing' })],
      version: '1.2.0',
      previousVersion: '1.1.0',
      owner: 'point-source',
      repository: 'sandbox',
      date: '2026-04-27',
    });
    expect(out).toContain(
      '## [1.2.0](https://github.com/point-source/sandbox/compare/v1.1.0...v1.2.0) (2026-04-27)',
    );
  });

  it('emits a plain header when no previousVersion (initial release)', () => {
    const out = renderChangelogFragment({
      commits: [commit({ sha: 'a'.repeat(40), type: 'feat', bareMessage: 'first feature' })],
      version: '0.1.0',
      owner: 'point-source',
      repository: 'sandbox',
      date: '2026-04-27',
    });
    expect(out).toContain('## 0.1.0 (2026-04-27)');
    expect(out).not.toContain('compare/');
  });

  it('groups commits by section in the conventional-commits order', () => {
    const out = renderChangelogFragment({
      commits: [
        commit({ sha: '1'.repeat(40), type: 'fix', bareMessage: 'fixed thing' }),
        commit({ sha: '2'.repeat(40), type: 'feat', bareMessage: 'added thing' }),
        commit({ sha: '3'.repeat(40), type: 'chore', bareMessage: 'bumped thing' }),
      ],
      version: '1.2.0',
      owner: 'point-source',
      repository: 'sandbox',
      date: '2026-04-27',
    });
    const featIdx = out.indexOf('### Features');
    const fixIdx = out.indexOf('### Bug Fixes');
    const choreIdx = out.indexOf('### Miscellaneous Chores');
    expect(featIdx).toBeGreaterThan(0);
    expect(fixIdx).toBeGreaterThan(featIdx);
    expect(choreIdx).toBeGreaterThan(fixIdx);
  });

  it('places BREAKING CHANGES section at the top above all other sections', () => {
    const out = renderChangelogFragment({
      commits: [
        commit({ sha: '1'.repeat(40), type: 'feat', bareMessage: 'add x' }),
        commit({ sha: '2'.repeat(40), type: 'feat', breaking: true, bareMessage: 'remove legacy y' }),
      ],
      version: '2.0.0',
      previousVersion: '1.9.0',
      owner: 'o',
      repository: 'r',
      date: '2026-04-27',
    });
    const breakingIdx = out.indexOf('### ⚠ BREAKING CHANGES');
    const featIdx = out.indexOf('### Features');
    expect(breakingIdx).toBeGreaterThan(0);
    expect(featIdx).toBeGreaterThan(breakingIdx);
  });

  it('renders commit lines with scope prefix and short sha link', () => {
    const out = renderChangelogFragment({
      commits: [
        commit({ sha: 'abc123def456'.padEnd(40, '0'), type: 'fix', scope: 'auth', bareMessage: 'tighten token check' }),
      ],
      version: '1.0.1',
      owner: 'point-source',
      repository: 'sandbox',
      date: '2026-04-27',
    });
    expect(out).toContain('**auth:** tighten token check');
    expect(out).toMatch(/\(\[abc123d\]\(https:\/\/github\.com\/point-source\/sandbox\/commit\/abc123def456/);
  });
});

describe('prependFragment', () => {
  it('prepends fragment with a single blank line separator', () => {
    const out = prependFragment('## 1.0.0\n\nold stuff\n', '## 2.0.0\n\nnew stuff\n');
    // No triple-newline, exactly one blank line between.
    expect(out).toBe('## 2.0.0\n\nnew stuff\n\n## 1.0.0\n\nold stuff\n');
    expect(out).not.toMatch(/\n\n\n/);
  });

  it('handles empty existing CHANGELOG cleanly', () => {
    const out = prependFragment('', '## 1.0.0\n\nfresh\n');
    expect(out).toBe('## 1.0.0\n\nfresh\n');
  });
});
