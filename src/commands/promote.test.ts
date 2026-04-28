import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as core from '@actions/core';
import { runPromoteWithOctokit } from './promote.js';
import type { Octokit } from '../github/octokit.js';
import type { Config } from '../core/config.js';
import type { GitProvider } from '../core/version.js';

interface MockOctokit {
  octokit: Octokit;
  compareCommits: ReturnType<typeof vi.fn>;
  listCommits: ReturnType<typeof vi.fn>;
  getBranch: ReturnType<typeof vi.fn>;
  createRef: ReturnType<typeof vi.fn>;
  dispatch: ReturnType<typeof vi.fn>;
  pullsList: ReturnType<typeof vi.fn>;
  pullsCreate: ReturnType<typeof vi.fn>;
  pullsUpdate: ReturnType<typeof vi.fn>;
}

function buildMockOctokit(): MockOctokit {
  const compareCommits = vi.fn().mockResolvedValue({ data: { commits: [] } });
  const listCommits = vi.fn().mockResolvedValue({ data: [] });
  const getBranch = vi
    .fn()
    .mockResolvedValue({ data: { commit: { sha: 'sha_branch_tip' } } });
  const createRef = vi.fn().mockResolvedValue({ data: {} });
  const dispatch = vi.fn().mockResolvedValue({});
  const pullsList = vi.fn().mockResolvedValue({ data: [] });
  const pullsCreate = vi.fn().mockResolvedValue({ data: { number: 77 } });
  const pullsUpdate = vi.fn().mockResolvedValue({ data: {} });
  const octokit = {
    rest: {
      repos: { compareCommits, listCommits, getBranch },
      git: { createRef },
      actions: { createWorkflowDispatch: dispatch },
      pulls: { list: pullsList, create: pullsCreate, update: pullsUpdate },
    },
  } as unknown as Octokit;
  return {
    octokit,
    compareCommits,
    listCommits,
    getBranch,
    createRef,
    dispatch,
    pullsList,
    pullsCreate,
    pullsUpdate,
  };
}

function buildGitProvider(opts: {
  baseTag?: string | null;
  preReleaseTags?: string[];
} = {}): GitProvider {
  // Honor explicit null for `baseTag` (greenfield case); only fall back to
  // 'v1.0.0' when the field is absent entirely.
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
      commits: messages.map((m, i) => ({ sha: `sha${i}`, commit: { message: m } })),
    },
  });
};

beforeEach(() => {
  vi.spyOn(core, 'info').mockImplementation(() => undefined);
  vi.spyOn(core, 'warning').mockImplementation(() => undefined);
});

describe('runPromoteWithOctokit > fix-only push to develop (full chain)', () => {
  it('tags branch tip, dispatches build, upserts promotion PR develop → staging', async () => {
    const mock = buildMockOctokit();
    setCommits(mock, ['fix: handle null token']);

    await runPromoteWithOctokit(mock.octokit, buildConfig(), buildGitProvider(), {
      branch: 'develop',
      dryRun: false,
      repo: 'point-source/sandbox',
    });

    // Tag created with -dev.N suffix on the branch tip SHA.
    expect(mock.createRef).toHaveBeenCalledOnce();
    const tagCall = mock.createRef.mock.calls[0]![0];
    expect(tagCall.ref).toBe('refs/tags/v1.0.1-dev.1');
    expect(tagCall.sha).toBe('sha_branch_tip');

    // Build dispatched with the same version + environment=develop.
    expect(mock.dispatch).toHaveBeenCalledOnce();
    const dispatchCall = mock.dispatch.mock.calls[0]![0];
    expect(dispatchCall.workflow_id).toBe('pipeline-build.yml');
    expect(dispatchCall.ref).toBe('develop');
    expect(dispatchCall.inputs.version).toBe('1.0.1-dev.1');
    expect(dispatchCall.inputs.environment).toBe('develop');

    // Promotion PR develop → staging created (no existing PR).
    expect(mock.pullsCreate).toHaveBeenCalledOnce();
    const prCall = mock.pullsCreate.mock.calls[0]![0];
    expect(prCall.head).toBe('develop');
    expect(prCall.base).toBe('staging');
    expect(prCall.title).toContain('v1.0.1-dev.1');
  });
});

// Learning #3: chore-only push must not create a tag (spec §440), but
// still dispatch build when publish_on_*=true. The promotion PR is also
// upserted so reviewers see the chore in the chain.
describe('runPromoteWithOctokit > chore-only push (learning #3)', () => {
  it('does NOT create a tag, but DOES dispatch build when publish_on_develop=true', async () => {
    const mock = buildMockOctokit();
    setCommits(mock, ['chore: bump deps', 'chore(deps): update lockfile']);

    await runPromoteWithOctokit(mock.octokit, buildConfig(), buildGitProvider(), {
      branch: 'develop',
      dryRun: false,
      repo: 'point-source/sandbox',
    });

    expect(mock.createRef).not.toHaveBeenCalled();
    expect(mock.dispatch).toHaveBeenCalledOnce();
    expect(mock.dispatch.mock.calls[0]![0].inputs.environment).toBe('develop');
    // Promotion PR still upserted (chores propagate through the chain).
    expect(mock.pullsCreate).toHaveBeenCalledOnce();
  });

  it('skips build dispatch when publish_on_develop=false', async () => {
    const mock = buildMockOctokit();
    setCommits(mock, ['chore: bump deps']);
    const config = buildConfig({ publish_on_develop: false });

    await runPromoteWithOctokit(mock.octokit, config, buildGitProvider(), {
      branch: 'develop',
      dryRun: false,
      repo: 'point-source/sandbox',
    });

    expect(mock.createRef).not.toHaveBeenCalled();
    expect(mock.dispatch).not.toHaveBeenCalled();
    // PR still upserted so the chore lands in the next branch eventually.
    expect(mock.pullsCreate).toHaveBeenCalledOnce();
  });
});

describe('runPromoteWithOctokit > branch chain routing', () => {
  it('routes develop → main when staging is disabled', async () => {
    const mock = buildMockOctokit();
    setCommits(mock, ['fix: thing']);
    const config = buildConfig({
      branches: { develop: true, staging: false, main: true },
    });

    await runPromoteWithOctokit(mock.octokit, config, buildGitProvider(), {
      branch: 'develop',
      dryRun: false,
      repo: 'point-source/sandbox',
    });

    expect(mock.pullsCreate).toHaveBeenCalledOnce();
    expect(mock.pullsCreate.mock.calls[0]![0].base).toBe('main');
  });

  it('skips promotion PR when no downstream branch is enabled (develop-only)', async () => {
    const mock = buildMockOctokit();
    setCommits(mock, ['fix: thing']);
    const config = buildConfig({
      branches: { develop: true, staging: false, main: false },
    });

    await runPromoteWithOctokit(mock.octokit, config, buildGitProvider(), {
      branch: 'develop',
      dryRun: false,
      repo: 'point-source/sandbox',
    });

    // Tag and build still happen (publish_on_develop=true by default).
    expect(mock.createRef).toHaveBeenCalledOnce();
    expect(mock.dispatch).toHaveBeenCalledOnce();
    // No PR — develop is the only enabled branch.
    expect(mock.pullsCreate).not.toHaveBeenCalled();
    expect(mock.pullsUpdate).not.toHaveBeenCalled();
  });

  it('routes staging → main with -rc.N tag', async () => {
    const mock = buildMockOctokit();
    setCommits(mock, ['feat: add something']);

    await runPromoteWithOctokit(mock.octokit, buildConfig(), buildGitProvider(), {
      branch: 'staging',
      dryRun: false,
      repo: 'point-source/sandbox',
    });

    // feat → minor bump → 1.1.0; staging → -rc.1
    expect(mock.createRef.mock.calls[0]![0].ref).toBe('refs/tags/v1.1.0-rc.1');
    expect(mock.dispatch.mock.calls[0]![0].inputs.environment).toBe('staging');
    expect(mock.pullsCreate.mock.calls[0]![0].base).toBe('main');
  });
});

describe('runPromoteWithOctokit > existing promotion PR is updated (idempotent)', () => {
  it('updates instead of creating when a develop → staging PR already exists', async () => {
    const mock = buildMockOctokit();
    setCommits(mock, ['fix: thing']);
    mock.pullsList.mockResolvedValue({ data: [{ number: 99 }] });

    await runPromoteWithOctokit(mock.octokit, buildConfig(), buildGitProvider(), {
      branch: 'develop',
      dryRun: false,
      repo: 'point-source/sandbox',
    });

    expect(mock.pullsCreate).not.toHaveBeenCalled();
    expect(mock.pullsUpdate).toHaveBeenCalledOnce();
    expect(mock.pullsUpdate.mock.calls[0]![0].pull_number).toBe(99);
  });
});

describe('runPromoteWithOctokit > dry-run', () => {
  it('makes no mutating API calls', async () => {
    const mock = buildMockOctokit();
    setCommits(mock, ['fix: thing']);

    await runPromoteWithOctokit(mock.octokit, buildConfig(), buildGitProvider(), {
      branch: 'develop',
      dryRun: true,
      repo: 'point-source/sandbox',
    });

    expect(mock.createRef).not.toHaveBeenCalled();
    expect(mock.dispatch).not.toHaveBeenCalled();
    expect(mock.pullsCreate).not.toHaveBeenCalled();
    expect(mock.pullsUpdate).not.toHaveBeenCalled();
  });
});

describe('runPromoteWithOctokit > pre-release counter increments', () => {
  it('uses next available -dev.N when prior dev tags exist for this base', async () => {
    const mock = buildMockOctokit();
    setCommits(mock, ['fix: thing']);
    const git = buildGitProvider({
      baseTag: 'v1.0.0',
      preReleaseTags: ['v1.0.1-dev.1', 'v1.0.1-dev.2', 'v1.0.1-dev.3'],
    });

    await runPromoteWithOctokit(mock.octokit, buildConfig(), git, {
      branch: 'develop',
      dryRun: false,
      repo: 'point-source/sandbox',
    });

    expect(mock.createRef.mock.calls[0]![0].ref).toBe('refs/tags/v1.0.1-dev.4');
  });
});

describe('runPromoteWithOctokit > greenfield (no release tag yet)', () => {
  it('falls back to listCommits when no base tag exists', async () => {
    const mock = buildMockOctokit();
    mock.listCommits.mockResolvedValue({
      data: [{ sha: 'sha0', commit: { message: 'feat: first feature' } }],
    });
    const git = buildGitProvider({ baseTag: null });
    const config = buildConfig();

    await runPromoteWithOctokit(mock.octokit, config, git, {
      branch: 'develop',
      dryRun: false,
      repo: 'point-source/sandbox',
    });

    // Falls back to listCommits since compareCommits requires a base tag.
    expect(mock.listCommits).toHaveBeenCalledOnce();
    expect(mock.compareCommits).not.toHaveBeenCalled();
    // Initial version 0.1.0 + minor bump → 0.2.0; develop → -dev.1
    expect(mock.createRef.mock.calls[0]![0].ref).toBe('refs/tags/v0.2.0-dev.1');
  });
});
