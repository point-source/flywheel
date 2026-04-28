import type { ConventionalCommit } from './commits.js';
import type { Bump } from './commits.js';

/**
 * Quality-check status as it appears on the PR body. `undefined` means no
 * quality workflow is configured — in that case the line is OMITTED entirely
 * (learning #6 from docs/adr/0001-typescript-rewrite.md). Showing "pending"
 * forever for repos without a quality workflow misleads reviewers.
 */
export type QualityStatus = 'pending' | 'passed' | 'failed' | undefined;

export interface FeatureBodyOptions {
  commits: readonly ConventionalCommit[];
  bump: Bump;
  target: string;
  quality: QualityStatus;
}

export interface PromotionBodyOptions {
  commits: readonly ConventionalCommit[];
  bump: Bump;
  source: string;
  target: string;
  version: string;
}

/**
 * Render the body for a feature/fix PR (per spec.md §336).
 *
 *   - Commits grouped by type with 7-char SHAs and breaking markers
 *   - "Version bump:" shows the bump signal (major/minor/patch), NOT a
 *     specific version — version is JIT on push (spec §419)
 *   - "Quality checks:" line only emitted if `quality` is defined
 */
export function renderFeatureBody(opts: FeatureBodyOptions): string {
  const groups = groupByType(opts.commits);
  const lines: string[] = ['## Changes', '', '<!-- Generated from conventional commits -->'];
  for (const type of typeOrder(groups)) {
    lines.push(`### ${type}`);
    for (const c of groups[type]!) {
      lines.push(`- ${formatCommitLine(c)}`);
    }
    lines.push('');
  }
  lines.push('---');
  lines.push(`**Version bump:** ${opts.bump}`);
  lines.push(`**Target:** ${opts.target}`);
  if (opts.quality !== undefined) {
    lines.push(`**Quality checks:** ${formatQuality(opts.quality)}`);
  }
  return lines.join('\n').trimEnd() + '\n';
}

/**
 * Render the body for a promotion PR (per spec.md §362).
 *
 * Promotion PRs show the cumulative changelog of all commits pending in the
 * promotion, with the computed version (which IS known for promotions, since
 * it's just the next pre-release/release on the source branch).
 */
export function renderPromotionBody(opts: PromotionBodyOptions): string {
  const groups = groupByType(opts.commits);
  const lines: string[] = [
    `## Promote ${opts.source} → ${opts.target}`,
    '',
    `**Version:** v${opts.version}`,
    `**Bump:** ${opts.bump}`,
    '',
    '<!-- Cumulative changelog of commits pending in this promotion -->',
  ];
  for (const type of typeOrder(groups)) {
    lines.push(`### ${type}`);
    for (const c of groups[type]!) {
      lines.push(`- ${formatCommitLine(c)}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}

function formatCommitLine(c: ConventionalCommit): string {
  const scope = c.scope ? `**${c.scope}:** ` : '';
  const breaking = c.breaking ? ' [⚠ BREAKING]' : '';
  const sha = c.sha.slice(0, 7);
  return `${scope}${c.bareMessage} (${sha})${breaking}`;
}

function groupByType(
  commits: readonly ConventionalCommit[],
): Record<string, ConventionalCommit[]> {
  const out: Record<string, ConventionalCommit[]> = {};
  for (const c of commits) {
    if (!c.type) continue; // skip parser-rejected entries
    (out[c.type] ??= []).push(c);
  }
  return out;
}

const TYPE_ORDER = ['feat', 'fix', 'perf', 'refactor', 'docs', 'style', 'test', 'chore'] as const;

function typeOrder(groups: Record<string, unknown>): string[] {
  const known = TYPE_ORDER.filter((t) => groups[t]);
  const other = Object.keys(groups).filter((t) => !TYPE_ORDER.includes(t as never));
  return [...known, ...other];
}

function formatQuality(q: 'pending' | 'passed' | 'failed'): string {
  switch (q) {
    case 'pending':
      return 'pending';
    case 'passed':
      return '✅ passed';
    case 'failed':
      return '❌ failed';
  }
}
