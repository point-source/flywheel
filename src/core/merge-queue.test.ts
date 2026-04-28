import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as core from '@actions/core';
import { isMergeQueueEnabled } from './merge-queue.js';
import type { Octokit } from '../github/octokit.js';

function fakeOctokit(getBranchRules: ReturnType<typeof vi.fn>): Octokit {
  return {
    rest: { repos: { getBranchRules } },
  } as unknown as Octokit;
}

beforeEach(() => {
  vi.spyOn(core, 'warning').mockImplementation(() => undefined);
});

describe('isMergeQueueEnabled > overrides', () => {
  it('returns true without API call when override is true', async () => {
    const getBranchRules = vi.fn();
    const result = await isMergeQueueEnabled({
      octokit: fakeOctokit(getBranchRules),
      owner: 'o',
      repo: 'r',
      branch: 'main',
      override: true,
    });
    expect(result).toBe(true);
    expect(getBranchRules).not.toHaveBeenCalled();
  });

  it('returns false without API call when override is false', async () => {
    const getBranchRules = vi.fn();
    const result = await isMergeQueueEnabled({
      octokit: fakeOctokit(getBranchRules),
      owner: 'o',
      repo: 'r',
      branch: 'main',
      override: false,
    });
    expect(result).toBe(false);
    expect(getBranchRules).not.toHaveBeenCalled();
  });
});

describe('isMergeQueueEnabled > auto detection', () => {
  it('returns true when a merge_queue rule is present', async () => {
    const getBranchRules = vi.fn().mockResolvedValue({
      data: [{ type: 'pull_request' }, { type: 'merge_queue' }],
    });
    const result = await isMergeQueueEnabled({
      octokit: fakeOctokit(getBranchRules),
      owner: 'o',
      repo: 'r',
      branch: 'main',
      override: 'auto',
    });
    expect(result).toBe(true);
  });

  it('returns false when no merge_queue rule is present', async () => {
    const getBranchRules = vi.fn().mockResolvedValue({
      data: [{ type: 'pull_request' }, { type: 'required_status_checks' }],
    });
    const result = await isMergeQueueEnabled({
      octokit: fakeOctokit(getBranchRules),
      owner: 'o',
      repo: 'r',
      branch: 'main',
      override: 'auto',
    });
    expect(result).toBe(false);
  });
});

// Learning #8: safe fallback to false on auth errors, with a warning.
describe('isMergeQueueEnabled > error handling', () => {
  it('returns false on 401 and surfaces a core.warning', async () => {
    const err = Object.assign(new Error('Bad credentials'), { status: 401 });
    const getBranchRules = vi.fn().mockRejectedValue(err);
    const warnSpy = vi.spyOn(core, 'warning');

    const result = await isMergeQueueEnabled({
      octokit: fakeOctokit(getBranchRules),
      owner: 'o',
      repo: 'r',
      branch: 'main',
      override: 'auto',
    });

    expect(result).toBe(false);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]![0]).toMatch(/merge-queue detection failed/);
    expect(warnSpy.mock.calls[0]![0]).toMatch(/Bad credentials/);
  });

  it('returns false on 404 (no rules access) without throwing', async () => {
    const err = Object.assign(new Error('Not Found'), { status: 404 });
    const getBranchRules = vi.fn().mockRejectedValue(err);
    const result = await isMergeQueueEnabled({
      octokit: fakeOctokit(getBranchRules),
      owner: 'o',
      repo: 'r',
      branch: 'main',
      override: 'auto',
    });
    expect(result).toBe(false);
  });
});
