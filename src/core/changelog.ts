import type { ConventionalCommit } from './commits.js';

/**
 * Render a release changelog fragment in the conventional-commits style used
 * by release-please's default writer. We render manually rather than calling
 * release-please's `DefaultChangelogNotes` because:
 *
 *   1. Its async + presetFactory + conventional-changelog-writer chain
 *      pulls heavy deps and is brittle to mock in unit tests.
 *   2. Output format is what spec.md cares about, and it's stable enough
 *      to encode here.
 *
 * If a future version needs richer output (issue cross-links, scope sorting),
 * swap this for `DefaultChangelogNotes` from release-please at that point.
 */
export interface RenderChangelogOptions {
  commits: readonly ConventionalCommit[];
  version: string;
  owner: string;
  repository: string;
  /** Used for the compare-link in the header. Omit on the very first release. */
  previousVersion?: string;
  /** ISO date string for the header (defaults to today). */
  date?: string;
  /** Github host (e.g. `https://github.com`). Defaults to GitHub.com. */
  host?: string;
}

const SECTION_TITLES: Record<string, string> = {
  feat: 'Features',
  fix: 'Bug Fixes',
  perf: 'Performance Improvements',
  refactor: 'Code Refactoring',
  docs: 'Documentation',
  style: 'Styles',
  test: 'Tests',
  chore: 'Miscellaneous Chores',
};

const SECTION_ORDER = ['feat', 'fix', 'perf', 'refactor', 'docs', 'style', 'test', 'chore'] as const;

export function renderChangelogFragment(opts: RenderChangelogOptions): string {
  const host = opts.host ?? 'https://github.com';
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const repoUrl = `${host}/${opts.owner}/${opts.repository}`;

  // Header: `## [v1.2.3](compareUrl) (date)` if we have a previous version,
  // else `## v1.2.3 (date)`.
  let header: string;
  if (opts.previousVersion) {
    const compareUrl = `${repoUrl}/compare/v${opts.previousVersion}...v${opts.version}`;
    header = `## [${opts.version}](${compareUrl}) (${date})`;
  } else {
    header = `## ${opts.version} (${date})`;
  }

  const groups = groupByType(opts.commits);
  const sections: string[] = [];

  // Breaking-change section first if any commits are breaking.
  const breaking = opts.commits.filter((c) => c.breaking);
  if (breaking.length > 0) {
    const lines = ['### ⚠ BREAKING CHANGES', ''];
    for (const c of breaking) {
      lines.push(`* ${formatCommitLine(c, repoUrl)}`);
    }
    sections.push(lines.join('\n'));
  }

  for (const type of SECTION_ORDER) {
    const group = groups[type];
    if (!group || group.length === 0) continue;
    const title = SECTION_TITLES[type] ?? type;
    const lines = [`### ${title}`, ''];
    for (const c of group) {
      lines.push(`* ${formatCommitLine(c, repoUrl)}`);
    }
    sections.push(lines.join('\n'));
  }

  // Other types (not in SECTION_ORDER) — append at end.
  const otherTypes = Object.keys(groups).filter(
    (t) => !SECTION_ORDER.includes(t as never),
  );
  for (const type of otherTypes) {
    const group = groups[type]!;
    const lines = [`### ${type}`, ''];
    for (const c of group) {
      lines.push(`* ${formatCommitLine(c, repoUrl)}`);
    }
    sections.push(lines.join('\n'));
  }

  if (sections.length === 0) {
    sections.push('_No notable changes._');
  }

  return [header, '', ...sections].join('\n\n') + '\n';
}

function formatCommitLine(c: ConventionalCommit, repoUrl: string): string {
  const scope = c.scope ? `**${c.scope}:** ` : '';
  const sha = c.sha.slice(0, 7);
  return `${scope}${c.bareMessage} ([${sha}](${repoUrl}/commit/${c.sha}))`;
}

function groupByType(
  commits: readonly ConventionalCommit[],
): Record<string, ConventionalCommit[]> {
  const out: Record<string, ConventionalCommit[]> = {};
  for (const c of commits) {
    if (!c.type) continue;
    (out[c.type] ??= []).push(c);
  }
  return out;
}

/**
 * Prepend a fragment to existing CHANGELOG.md content. Ensures exactly one
 * blank line between the new fragment and the prior content. Returns the
 * full new file contents.
 */
export function prependFragment(existing: string, fragment: string): string {
  const trimmedFragment = fragment.replace(/\s+$/, '');
  const trimmedExisting = existing.replace(/^\s+/, '');
  if (trimmedExisting === '') return trimmedFragment + '\n';
  return trimmedFragment + '\n\n' + trimmedExisting;
}
