import { describe, it, expect, vi } from 'vitest';
import { upsertPullRequest } from './upsert-pr.js';
import type { Octokit } from '../github/octokit.js';

function fakeOctokit(): {
  octokit: Octokit;
  list: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
} {
  const list = vi.fn().mockResolvedValue({ data: [] });
  const update = vi.fn().mockResolvedValue({ data: {} });
  const create = vi.fn().mockResolvedValue({ data: { number: 42 } });
  const octokit = {
    rest: {
      pulls: { list, update, create },
    },
  } as unknown as Octokit;
  return { octokit, list, update, create };
}

describe('upsertPullRequest', () => {
  it('creates a new PR when none exists for (head, base)', async () => {
    const { octokit, list, update, create } = fakeOctokit();
    list.mockResolvedValue({ data: [] });
    create.mockResolvedValue({ data: { number: 42 } });

    const result = await upsertPullRequest({
      octokit,
      owner: 'point-source',
      repo: 'sandbox',
      head: 'develop',
      base: 'staging',
      title: 'chore(release): promote develop → staging [v1.3.0-rc.1]',
      body: '# changelog body',
    });

    expect(result).toEqual({ number: 42, created: true });
    expect(create).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
  });

  it('updates the existing PR (idempotent re-run)', async () => {
    const { octokit, list, update, create } = fakeOctokit();
    list.mockResolvedValue({ data: [{ number: 7 }] });

    const result = await upsertPullRequest({
      octokit,
      owner: 'point-source',
      repo: 'sandbox',
      head: 'develop',
      base: 'staging',
      title: 'updated title',
      body: 'updated body',
    });

    expect(result).toEqual({ number: 7, created: false });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        pull_number: 7,
        title: 'updated title',
        body: 'updated body',
      }),
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('passes head as owner:branch to disambiguate cross-fork PRs', async () => {
    const { octokit, list } = fakeOctokit();
    list.mockResolvedValue({ data: [] });

    await upsertPullRequest({
      octokit,
      owner: 'point-source',
      repo: 'sandbox',
      head: 'develop',
      base: 'staging',
      title: 't',
      body: 'b',
    });

    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ head: 'point-source:develop', base: 'staging' }),
    );
  });
});
