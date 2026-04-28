import type { IncrementType, ParsedTitle } from "./types.js";

export const VALID_TYPES = [
  "feat",
  "fix",
  "chore",
  "refactor",
  "perf",
  "style",
  "test",
  "docs",
  "build",
  "ci",
  "revert",
] as const;

export const ALLOWED_AUTO_MERGE_ENTRIES = new Set<string>([
  ...VALID_TYPES,
  ...VALID_TYPES.map((t) => `${t}!`),
]);

const TITLE_RE = /^([a-z]+)(?:\(([^)]+)\))?(!?):\s+(.+)$/;

export function parseTitle(title: string): ParsedTitle | null {
  const match = TITLE_RE.exec(title.trim());
  if (!match) return null;
  const [, type, scope, bang, description] = match;
  if (!type || !description) return null;
  if (!VALID_TYPES.includes(type as (typeof VALID_TYPES)[number])) return null;
  return {
    type,
    scope: scope ?? null,
    breaking: bang === "!",
    description: description.trim(),
    raw: title.trim(),
  };
}

const BREAKING_FOOTER_RE = /(^|\n)BREAKING[ -]CHANGE:\s*\S/;

export function detectBreakingInBody(body: string | null | undefined): boolean {
  if (!body) return false;
  return BREAKING_FOOTER_RE.test(body);
}

export function computeIncrement(
  parsed: ParsedTitle,
  breakingFromBodies = false,
): IncrementType {
  if (parsed.breaking || breakingFromBodies) return "major";
  if (parsed.type === "feat") return "minor";
  if (parsed.type === "fix" || parsed.type === "perf") return "patch";
  return "none";
}

const TYPE_RANK: Record<string, number> = {
  feat: 4,
  fix: 3,
  perf: 2,
  refactor: 1,
  chore: 0,
  style: 0,
  test: 0,
  docs: 0,
  revert: 0,
  build: -1,
  ci: -1,
};

export interface CommitForRanking {
  type: string;
  breaking: boolean;
}

export interface MostImpactful {
  type: string;
  breaking: boolean;
}

export function mostImpactfulType(
  commits: CommitForRanking[],
): MostImpactful | null {
  if (commits.length === 0) return null;
  return commits.reduce<MostImpactful>((best, c) => {
    const cRank = scoreOf(c);
    const bRank = scoreOf(best);
    return cRank > bRank ? { type: c.type, breaking: c.breaking } : best;
  }, { type: commits[0]!.type, breaking: commits[0]!.breaking });
}

function scoreOf(c: CommitForRanking): number {
  const base = TYPE_RANK[c.type] ?? -1;
  if (c.breaking) {
    if (c.type === "feat") return 1000;
    if (c.type === "fix") return 900;
    return 800;
  }
  return base;
}

export function isBumping(type: string, breaking: boolean): boolean {
  if (breaking) return true;
  return type === "feat" || type === "fix" || type === "perf";
}
