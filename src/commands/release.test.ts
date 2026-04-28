import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as core from '@actions/core';
import { runReleaseWithOctokit } from './release.js';
import type { Octokit } from '../github/octokit.js';
import type { Config } from '../core/config.js';
import type { GitProvider } from '../core/version.js';

interface MockOctokit {
  octokit: Octokit;
  compareCommits: ReturnType<typeof vi.fn>;
  listCommits: ReturnType<typeof vi.fn>;
  getBranch: ReturnType<typeof vi.fn>;
  createRef: ReturnType<typeof vi.fn>;
  createRelease: ReturnType<typeof vi.fn>;
  getContent: ReturnType<typeof vi.fn>;
  createOrUpdateFile: ReturnType<typeof vi.fn>;
  dispatch: ReturnType<typeof vi.fn>;
  /** Records the order of every mutating call by name. */
  callOrder: string[];
}

function buildMockOctokit(): MockOctokit {
  const callOrder: string[] = [];
  const track = <T>(name: string, fn: () => T): T => {
    callOrder.push(name);
    return fn();
  };

  const compareCommits = vi.fn().mockResolvedValue({ data: { commits: [] } });
  const listCommits = vi.fn().mockResolvedValue({ data: [] });
  const getBranch = vi.fn().mockResolvedValue({ data: { commit: { sha: 'sha_main_tip' } } });
  const createRef = vi.fn().mockImplementation(() =>
    Promise.resolve(track('createRef', () => ({ data: {} }))),
  );
  const createRelease = vi.fn().mockImplementation(() =>
    Promise.resolve(track('createRelease', () => ({ data: { id: 1 } }))),
  );
  const getContent = vi.fn().mockResolvedValue({
    data: {
      type: 'file',
      content: Buffer.from('# Old CHANGELOG\n\n## 1.0.0\n', 'utf8').toString('base64'),
      sha: 'changelog_blob_sha',
    },
  });
  const createOrUpdateFile = vi.fn().mockImplementation(() =>
    Promise.resolve(track('createOrUpdateFileContents', () => ({ data: {} }))),
  );
  const dispatch = vi.fn().mockImplementation(() =>
    Promise.resolve(track('createWorkflowDispatch', () => ({}))),
  );

  const octokit = {
    rest: {
      repos: {
        compareCommits,
        listCommits,
        getBranch,
        createRelease,
        getContent,
        createOrUpdateFileContents: createOrUpdateFile,
      },
      git: { createRef },
      actions: { createWorkflowDispatch: dispatch },
    },
  } as unknown as Octokit;

  return {
    octokit,
    compareCommits,
    listCommits,
    getBranch,
    createRef,
    createRelease,
    getContent,
    createOrUpdateFile,
    dispatch,
    callOrder,
  };
}

function buildGitProvider(opts: {
  baseTag?: string | null;
  preReleaseTags?: string[];
} = {}): GitProvider {
  const baseTag = 'baseTag' in opts ? opts.baseTag : 'v1.0.0';
  return {
    describeReachableReleaseTag: vi.fn().mockResolvedValue(baseTag),
    listTagsMatching: vi.fn().mockResolvedValue(opts.preReleaseTags ?? []),
  };
}

function buildConfig(overrides: Partial<Config['pipeline']> = {}): Config {
  return {
    pipeline: {
      branches: { develop: true, staging: true, main: true },
      merge_strategy: 'squash',
      auto_merge_types: ['fix', 'chore', 'refactor', 'perf', 'style', 'test'],
      publish_on_develop: true,
      publish_on_staging: true,
      merge_queue: 'auto',
      workflows: {
        build: 'pipeline-build.yml',
        publish: 'pipeline-publish.yml',
        quality: '',
      },
      ...overrides,
    },
    initial_version: '0.1.0',
  };
}

const setCommits = (mock: MockOctokit, messages: string[]): void => {
  mock.compareCommits.mockResolvedValue({
    data: {
      commits: messages.map((m, i) => ({ sha: `sha${i}`.padEnd(40, '0'), commit: { message: m } })),
    },
  });
};

beforeEach(() => {
  vi.spyOn(core, 'info').mockImplementation(() => undefined);
  vi.spyOn(core, 'warning').mockImplementation(() => undefined);
});

describe('runReleaseWithOctokit > full release flow', () => {
  it('tags, releases, commits CHANGELOG, dispatches build for fix commits', async () => {
    const mock = buildMockOctokit();
    setCommits(mock, ['fix: handle null token']);

    await runReleaseWithOctokit(mock.octokit, buildConfig(), buildGitProvider(), {
      branch: 'main',
      dryRun: false,
      repo: 'point-source/sandbox',
    });

    expect(mock.createRef.mock.calls[0]![0].ref).toBe('refs/tags/v1.0.1');
    expect(mock.createRef.mock.calls[0]![0].sha).toBe('sha_main_tip');

    expect(mock.createRelease).toHaveBeenCalledOnce();
    const releaseCall = mock.createRelease.mock.calls[0]![0];
    expect(releaseCall.tag_name).toBe('v1.0.1');
    expect(releaseCall.body).toContain('### Bug Fixes');

    expect(mock.createOrUpdateFile).toHaveBeenCalledOnce();
    const fileCall = mock.createOrUpdateFile.mock.calls[0]![0];
    expect(fileCall.path).toBe('CHANGELOG.md');
    expect(fileCall.message).toContain('v1.0.1');
    expect(fileCall.message).toContain('[skip ci]');

    expect(mock.dispatch).toHaveBeenCalledOnce();
    const buildCall = mock.dispatch.mock.calls[0]![0];
    expect(buildCall.workflow_id).toBe('pipeline-build.yml');
    expect(buildCall.inputs.environment).toBe('production');
    expect(buildCall.inputs.version).toBe('1.0.1');
  });
});

// Learning #11: tag and GitHub Release MUST be created before the
// CHANGELOG.md file commit. Recovery semantics depend on the tag being the
// authoritative "release happened" marker — if CHANGELOG.md were committed
// first and the run crashed before tagging, recovery would be ambiguous.
describe('runReleaseWithOctokit > order of side-effects (learning #11)', () => {
  it('tags before GitHub Release before CHANGELOG.md commit', async () => {
    const mock = buildMockOctokit();
    setCommits(mock, ['feat: add thing']);

    await runReleaseWithOctokit(mock.octokit, buildConfig(), buildGitProvider(), {
      branch: 'main',
      dryRun: false,
      repo: 'point-source/sandbox',
    });

    const tagIdx = mock.callOrder.indexOf('createRef');
    const releaseIdx = mock.callOrder.indexOf('createRelease');
    const fileIdx = mock.callOrder.indexOf('createOrUpdateFileContents');
    const buildIdx = mock.callOrder.indexOf('createWorkflowDispatch');

    expect(tagIdx).toBeGreaterThanOrEqual(0);
    expect(tagIdx).toBeLessThan(releaseIdx);
    expect(releaseIdx).toBeLessThan(fileIdx);
    // Build dispatch comes last.
    expect(fileIdx).toBeLessThan(buildIdx);
  });
});

describe('runReleaseWithOctokit > chore-only push to main', () => {
  it('does nothing — no tag, no release, no commit, no build', async () => {
    const mock = buildMockOctokit();
    setCommits(mock, ['chore: bump deps']);

    await runReleaseWithOctokit(mock.octokit, buildConfig(), buildGitProvider(), {
      branch: 'main',
      dryRun: false,
      repo: 'point-source/sandbox',
    });

    expect(mock.createRef).not.toHaveBeenCalled();
    expect(mock.createRelease).not.toHaveBeenCalled();
    expect(mock.createOrUpdateFile).not.toHaveBeenCalled();
    expect(mock.dispatch).not.toHaveBeenCalled();
  });
});

describe('runReleaseWithOctokit > CHANGELOG.md does not yet exist', () => {
  it('creates CHANGELOG.md without an `sha` argument when getContent returns 404', async () => {
    const mock = buildMockOctokit();
    setCommits(mock, ['feat: first feature']);
    const notFound = Object.assign(new Error('Not Found'), { status: 404 });
    mock.getContent.mockRejectedValue(notFound);

    await runReleaseWithOctokit(mock.octokit, buildConfig(), buildGitProvider(), {
      branch: 'main',
      dryRun: false,
      repo: 'point-source/sandbox',
    });

    expect(mock.createOrUpdateFile).toHaveBeenCalledOnce();
    const call = mock.createOrUpdateFile.mock.calls[0]![0];
    expect(call.sha).toBeUndefined();
  });
});

describe('runReleaseWithOctokit > greenfield (no prior release tag)', () => {
  it('uses listCommits and emits a header without a compare-link', async () => {
    const mock = buildMockOctokit();
    mock.listCommits.mockResolvedValue({
      data: [{ sha: 'sha0'.padEnd(40, '0'), commit: { message: 'feat: first' } }],
    });
    const notFound = Object.assign(new Error('Not Found'), { status: 404 });
    mock.getContent.mockRejectedValue(notFound);

    await runReleaseWithOctokit(mock.octokit, buildConfig(), buildGitProvider({ baseTag: null }), {
      branch: 'main',
      dryRun: false,
      repo: 'point-source/sandbox',
    });

    // Initial version 0.1.0 + minor bump → 0.2.0
    expect(mock.createRef.mock.calls[0]![0].ref).toBe('refs/tags/v0.2.0');
    const releaseBody = mock.createRelease.mock.calls[0]![0].body;
    expect(releaseBody).not.toContain('compare/');
  });
});

describe('runReleaseWithOctokit > dry-run', () => {
  it('makes no mutating API calls', async () => {
    const mock = buildMockOctokit();
    setCommits(mock, ['feat: thing']);

    await runReleaseWithOctokit(mock.octokit, buildConfig(), buildGitProvider(), {
      branch: 'main',
      dryRun: true,
      repo: 'point-source/sandbox',
    });

    expect(mock.createRef).not.toHaveBeenCalled();
    expect(mock.createRelease).not.toHaveBeenCalled();
    expect(mock.createOrUpdateFile).not.toHaveBeenCalled();
    expect(mock.dispatch).not.toHaveBeenCalled();
  });
});

describe('runReleaseWithOctokit > breaking change → major bump', () => {
  it('cuts a major release for breaking commits', async () => {
    const mock = buildMockOctokit();
    setCommits(mock, ['feat!: drop legacy API']);

    await runReleaseWithOctokit(mock.octokit, buildConfig(), buildGitProvider(), {
      branch: 'main',
      dryRun: false,
      repo: 'point-source/sandbox',
    });

    // 1.0.0 + major → 2.0.0
    expect(mock.createRef.mock.calls[0]![0].ref).toBe('refs/tags/v2.0.0');
    const releaseBody = mock.createRelease.mock.calls[0]![0].body;
    expect(releaseBody).toContain('### ⚠ BREAKING CHANGES');
  });
});
