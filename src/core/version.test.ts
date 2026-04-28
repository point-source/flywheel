import { describe, it, expect } from 'vitest';
import { computeVersion, type GitProvider } from './version.js';

/** In-memory GitProvider for tests. */
function fakeGit(opts: { reachableTag?: string | null; tags?: string[] } = {}): GitProvider {
  return {
    describeReachableReleaseTag: async () => opts.reachableTag ?? null,
    listTagsMatching: async (pattern: string) => {
      const tags = opts.tags ?? [];
      const re = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
      return tags.filter((t) => re.test(t));
    },
  };
}

describe('computeVersion > findBaseTag', () => {
  // Learning #1: reachability-aware lookup (we trust the GitProvider impl to
  // pass --exclude='*-*'). The contract is: describeReachableReleaseTag must
  // return a non-pre-release tag.
  it('excludes pre-release tags via reachability (provider contract)', async () => {
    // The provider returns only non-pre-release reachable tags. Simulating:
    const result = await computeVersion({
      branch: 'main',
      bump: 'patch',
      initialVersion: '0.1.0',
      git: fakeGit({ reachableTag: 'v1.0.0', tags: ['v1.0.0', 'v1.1.0-dev.5'] }),
    });
    // Should bump from v1.0.0, not from the dev tag.
    expect(result.baseVersion).toBe('1.0.1');
  });

  it('falls back to initialVersion when no reachable release tag', async () => {
    const result = await computeVersion({
      branch: 'main',
      bump: 'minor',
      initialVersion: '0.1.0',
      git: fakeGit({ reachableTag: null }),
    });
    expect(result.baseVersion).toBe('0.2.0');
  });
});

describe('computeVersion > bump application', () => {
  it('major bump increments major and zeroes minor/patch', async () => {
    const r = await computeVersion({
      branch: 'main',
      bump: 'major',
      initialVersion: '0.1.0',
      git: fakeGit({ reachableTag: 'v1.2.3' }),
    });
    expect(r.version).toBe('2.0.0');
  });

  it('minor bump increments minor and zeroes patch', async () => {
    const r = await computeVersion({
      branch: 'main',
      bump: 'minor',
      initialVersion: '0.1.0',
      git: fakeGit({ reachableTag: 'v1.2.3' }),
    });
    expect(r.version).toBe('1.3.0');
  });

  it('patch bump increments patch only', async () => {
    const r = await computeVersion({
      branch: 'main',
      bump: 'patch',
      initialVersion: '0.1.0',
      git: fakeGit({ reachableTag: 'v1.2.3' }),
    });
    expect(r.version).toBe('1.2.4');
  });
});

describe('computeVersion > pre-release suffix', () => {
  it('appends -dev.N on develop', async () => {
    const r = await computeVersion({
      branch: 'develop',
      bump: 'patch',
      initialVersion: '0.1.0',
      git: fakeGit({ reachableTag: 'v1.0.0' }),
    });
    expect(r.version).toBe('1.0.1-dev.1');
    expect(r.baseVersion).toBe('1.0.1');
  });

  it('appends -rc.N on staging', async () => {
    const r = await computeVersion({
      branch: 'staging',
      bump: 'minor',
      initialVersion: '0.1.0',
      git: fakeGit({ reachableTag: 'v1.0.0' }),
    });
    expect(r.version).toBe('1.1.0-rc.1');
  });

  it('no suffix on main', async () => {
    const r = await computeVersion({
      branch: 'main',
      bump: 'patch',
      initialVersion: '0.1.0',
      git: fakeGit({ reachableTag: 'v1.0.0' }),
    });
    expect(r.version).toBe('1.0.1');
  });
});

// Learning #2: pre-release counters scoped to the base version (spec §428).
describe('computeVersion > preReleaseCounter', () => {
  it('starts at .1 when no prior pre-release tags exist for this base', async () => {
    const r = await computeVersion({
      branch: 'develop',
      bump: 'patch',
      initialVersion: '0.1.0',
      git: fakeGit({ reachableTag: 'v1.0.0', tags: [] }),
    });
    expect(r.version).toBe('1.0.1-dev.1');
  });

  it('increments from the highest dev.N for this base', async () => {
    const r = await computeVersion({
      branch: 'develop',
      bump: 'patch',
      initialVersion: '0.1.0',
      git: fakeGit({
        reachableTag: 'v1.0.0',
        tags: ['v1.0.1-dev.1', 'v1.0.1-dev.2', 'v1.0.1-dev.5'],
      }),
    });
    expect(r.version).toBe('1.0.1-dev.6');
  });

  it('does not reuse N across branches with the same base', async () => {
    // Both develop and staging share base 1.0.0. develop has -dev.3,
    // staging has -rc.2. Computing next dev should be .4, not .1.
    const r = await computeVersion({
      branch: 'develop',
      bump: 'patch',
      initialVersion: '0.1.0',
      git: fakeGit({
        reachableTag: 'v1.0.0',
        tags: ['v1.0.1-dev.1', 'v1.0.1-dev.2', 'v1.0.1-dev.3', 'v1.0.1-rc.1', 'v1.0.1-rc.2'],
      }),
    });
    expect(r.version).toBe('1.0.1-dev.4');
  });

  it('treats different base versions independently', async () => {
    // Old base 1.0.x had dev.5; new base is 1.1.0; should start at .1.
    const r = await computeVersion({
      branch: 'develop',
      bump: 'minor',
      initialVersion: '0.1.0',
      git: fakeGit({
        reachableTag: 'v1.0.0',
        tags: ['v1.0.1-dev.5'],
      }),
    });
    expect(r.version).toBe('1.1.0-dev.1');
  });
});

describe('computeVersion > chore-only behavior', () => {
  // Spec §440: chore-only push gets no version tag (hasChanges=false), but
  // pre-release builds still need an identifier so the publish workflow can
  // tag artifacts.
  it('on main: hasChanges=false when bump=none', async () => {
    const r = await computeVersion({
      branch: 'main',
      bump: 'none',
      initialVersion: '0.1.0',
      git: fakeGit({ reachableTag: 'v1.0.0' }),
    });
    expect(r.hasChanges).toBe(false);
  });

  it('on develop: still produces a -dev.N identifier even for chore-only', async () => {
    const r = await computeVersion({
      branch: 'develop',
      bump: 'none',
      initialVersion: '0.1.0',
      git: fakeGit({ reachableTag: 'v1.0.0' }),
    });
    expect(r.version).toMatch(/^\d+\.\d+\.\d+-dev\.\d+$/);
    expect(r.hasChanges).toBe(false);
  });
});
