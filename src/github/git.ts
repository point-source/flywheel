import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitProvider } from '../core/version.js';

const execFileAsync = promisify(execFile);

/**
 * Production GitProvider that shells out to the git CLI. The runner has git
 * pre-installed, so no extra dependency. Tests don't use this — they
 * inject in-memory fakes (see version.test.ts).
 */
export function createCliGitProvider(cwd?: string): GitProvider {
  return {
    async describeReachableReleaseTag(): Promise<string | null> {
      // --abbrev=0 returns just the tag name (no extra suffix)
      // --exclude='*-*' excludes pre-release tags (anything with hyphen)
      // The reachability is implicit: describe walks back from HEAD.
      try {
        const { stdout } = await execFileAsync(
          'git',
          ['describe', '--tags', '--abbrev=0', '--exclude=*-*'],
          { cwd },
        );
        return stdout.trim() || null;
      } catch (err) {
        // git describe exits non-zero when no matching tag exists. That's
        // not an error from our perspective — caller falls back to
        // `initialVersion`.
        if (isNoTagFoundError(err)) return null;
        throw err;
      }
    },

    async listTagsMatching(pattern: string): Promise<string[]> {
      const { stdout } = await execFileAsync('git', ['tag', '--list', pattern], { cwd });
      return stdout
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    },
  };
}

function isNoTagFoundError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const stderr = (err as { stderr?: string }).stderr;
  return typeof stderr === 'string' && /No (names|tags) found/i.test(stderr);
}
