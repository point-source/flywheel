import {
  computeIncrement,
  detectBreakingInBody,
  isBumping,
  mostImpactfulType,
  parseTitle,
  type CommitForRanking,
} from "./conventional.js";
import {
  FLYWHEEL_AUTO_MERGE_LABEL,
  FLYWHEEL_NEEDS_REVIEW_LABEL,
  type Commit,
  type GitHubClient,
  type MergeMethod,
} from "./github.js";
import { sanitizeSkipCi } from "./skip-ci.js";
import type { Branch, FlywheelConfig, Stream } from "./types.js";

export type PromotionOutcome =
  | { kind: "unmanaged" }
  | { kind: "terminal" }
  | { kind: "no-bumping" }
  | { kind: "created"; prNumber: number; label: string }
  | { kind: "updated"; prNumber: number; label: string }
  | { kind: "no-change"; prNumber: number };

export interface PromotionDeps {
  branchRef: string;
  config: FlywheelConfig;
  gh: GitHubClient;
  log: PromotionLogger;
}

export interface PromotionLogger {
  info(msg: string): void;
  warning(msg: string): void;
}

export async function runPromotion(deps: PromotionDeps): Promise<PromotionOutcome> {
  const { branchRef, config, gh, log } = deps;
  const located = locateBranch(config, branchRef);
  if (!located) {
    log.info(`promotion: branch ${branchRef} is not in any stream — no promotion PR.`);
    return { kind: "unmanaged" };
  }
  const { stream, branchIdx } = located;
  if (branchIdx === stream.branches.length - 1) {
    log.info(
      `promotion: branch ${branchRef} is the terminal branch of stream ${stream.name} — no promotion PR.`,
    );
    return { kind: "terminal" };
  }

  const source = stream.branches[branchIdx]!;
  const target = stream.branches[branchIdx + 1]!;

  const [sourceCommits, targetCommits] = await Promise.all([
    gh.listBranchCommits(source.name, 200),
    gh.listBranchCommits(target.name, 200),
  ]);

  const pending = computePendingCommits({
    sourceCommits,
    targetCommits,
    sourceName: source.name,
    targetName: target.name,
  });

  if (pending.length === 0) {
    log.info(
      `promotion: ${source.name} → ${target.name} has no pending commits.`,
    );
    return { kind: "no-bumping" };
  }

  const ranked: CommitForRanking[] = pending.map((c) => {
    const parsed = parseTitle(c.title);
    const breaking = (parsed?.breaking ?? false) || detectBreakingInBody(c.body);
    return { type: parsed?.type ?? "other", breaking };
  });

  const anyBumping = ranked.some((c) => isBumping(c.type, c.breaking));
  if (!anyBumping) {
    log.info(
      `promotion: ${source.name} → ${target.name} has only non-bumping pending commits — skipping upsert.`,
    );
    return { kind: "no-bumping" };
  }

  const top = mostImpactfulType(ranked);
  if (!top) return { kind: "no-bumping" };

  const title = formatPromotionTitle(top.type, top.breaking, source.name, target.name);
  const matchKey = top.breaking ? `${top.type}!` : top.type;
  const eligible = target.auto_merge.includes(matchKey);
  const label = eligible ? FLYWHEEL_AUTO_MERGE_LABEL : FLYWHEEL_NEEDS_REVIEW_LABEL;
  const body = formatPromotionBody({
    pending,
    sourceName: source.name,
    targetName: target.name,
    matchKey,
    eligible,
    targetBranch: target,
  });
  const method = mergeMethodFor(config);

  const existing = await gh.listOpenPRs({ head: source.name, base: target.name });

  if (existing.length === 0) {
    const created = await gh.createPR({
      title,
      body,
      head: source.name,
      base: target.name,
    });
    await applyLabel(gh, created.number, label);
    if (eligible) {
      const result = await gh.enableAutoMerge(created.nodeId, method);
      if (!result.ok) {
        log.warning(
          `promotion PR #${created.number}: could not enable native auto-merge — ${result.reason}.`,
        );
      }
    }
    log.info(
      `promotion: created PR #${created.number} (${source.name} → ${target.name}, ${label}).`,
    );
    return { kind: "created", prNumber: created.number, label };
  }

  const pr = existing[0]!;
  const titleChanged = pr.title !== title;
  const bodyChanged = (pr.body ?? "") !== body;

  if (titleChanged || bodyChanged) {
    await gh.updatePR(pr.number, {
      ...(titleChanged ? { title } : {}),
      ...(bodyChanged ? { body } : {}),
    });
  }
  await applyLabel(gh, pr.number, label);
  if (eligible) {
    const result = await gh.enableAutoMerge(pr.nodeId, method);
    if (!result.ok) {
      log.warning(
        `promotion PR #${pr.number}: could not enable native auto-merge — ${result.reason}.`,
      );
    }
  } else {
    await gh.disableAutoMerge(pr.nodeId);
  }

  if (!titleChanged && !bodyChanged) {
    return { kind: "no-change", prNumber: pr.number };
  }
  log.info(
    `promotion: updated PR #${pr.number} (${source.name} → ${target.name}, ${label}).`,
  );
  return { kind: "updated", prNumber: pr.number, label };
}

interface PendingDetectionInput {
  sourceCommits: Commit[];
  targetCommits: Commit[];
  sourceName: string;
  targetName: string;
}

export function computePendingCommits(input: PendingDetectionInput): Commit[] {
  const { sourceCommits, targetCommits, sourceName, targetName } = input;

  // Strategy A: if target has a prior `promote source → target` squash commit,
  // use its committer.date as the cutoff. This handles the squash-merge case
  // where underlying feature commits don't propagate to target.
  const lastPromotion = findLastPromotionCommit(targetCommits, sourceName, targetName);
  if (lastPromotion) {
    const cutoff = Date.parse(lastPromotion.committerDate);
    if (Number.isFinite(cutoff)) {
      return sourceCommits.filter((c) => Date.parse(c.committerDate) > cutoff);
    }
  }

  // Strategy B (initial seed): title set-difference.
  // Normalize both sides — strip "(#NN)" suffix added by GitHub on squash merges.
  const targetTitles = new Set(targetCommits.map((c) => normalizeTitle(c.title)));
  return sourceCommits.filter((c) => !targetTitles.has(normalizeTitle(c.title)));
}

function findLastPromotionCommit(
  targetCommits: Commit[],
  sourceName: string,
  targetName: string,
): Commit | null {
  const re = buildPromotionTitleRegex(sourceName, targetName);
  for (const c of targetCommits) {
    if (re.test(stripPrSuffix(c.title))) return c;
  }
  return null;
}

function buildPromotionTitleRegex(source: string, target: string): RegExp {
  const escapedSource = escapeRegex(source);
  const escapedTarget = escapeRegex(target);
  return new RegExp(
    `^[a-z]+(\\([^)]+\\))?!?: promote ${escapedSource} → ${escapedTarget}$`,
  );
}

function normalizeTitle(title: string): string {
  return stripPrSuffix(title).trim();
}

function stripPrSuffix(title: string): string {
  return title.replace(/\s*\(#\d+\)\s*$/, "");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatPromotionTitle(
  type: string,
  breaking: boolean,
  source: string,
  target: string,
): string {
  return `${type}${breaking ? "!" : ""}: promote ${source} → ${target}`;
}

interface BodyParams {
  pending: Commit[];
  sourceName: string;
  targetName: string;
  matchKey: string;
  eligible: boolean;
  targetBranch: Branch;
}

function formatPromotionBody(p: BodyParams): string {
  const groups = new Map<string, Array<{ desc: string; sha: string }>>();
  let unrecognised = 0;
  for (const c of p.pending) {
    const parsed = parseTitle(stripPrSuffix(c.title));
    if (!parsed) {
      unrecognised++;
      continue;
    }
    const list = groups.get(parsed.type) ?? [];
    list.push({ desc: sanitizeSkipCi(parsed.description), sha: c.sha.slice(0, 7) });
    groups.set(parsed.type, list);
  }

  const lines: string[] = [];
  lines.push(`## Promote \`${p.sourceName}\` → \`${p.targetName}\``, "");
  lines.push(`Pending commits (${p.pending.length} total):`, "");
  for (const [type, items] of groups) {
    lines.push(`### ${type}`, "");
    for (const item of items) lines.push(`- ${item.desc} (${item.sha})`);
    lines.push("");
  }
  if (unrecognised > 0) {
    lines.push(
      `> Note: ${unrecognised} commit${unrecognised === 1 ? "" : "s"} did not parse as a conventional commit and ${unrecognised === 1 ? "was" : "were"} omitted from the per-type sections above.`,
      "",
    );
  }
  lines.push("---", "");
  if (p.eligible) {
    lines.push(
      `**Status:** ✅ \`${FLYWHEEL_AUTO_MERGE_LABEL}\` — \`${p.matchKey}\` is in auto_merge list for \`${p.targetName}\``,
    );
  } else {
    lines.push(
      `**Status:** 👀 \`${FLYWHEEL_NEEDS_REVIEW_LABEL}\` — \`${p.matchKey}\` is not in auto_merge list for \`${p.targetName}\``,
    );
  }
  return lines.join("\n");
}

async function applyLabel(gh: GitHubClient, prNumber: number, label: string): Promise<void> {
  await gh.addLabels(prNumber, [label]);
  const opposite = label === FLYWHEEL_AUTO_MERGE_LABEL ? FLYWHEEL_NEEDS_REVIEW_LABEL : FLYWHEEL_AUTO_MERGE_LABEL;
  await gh.removeLabel(prNumber, opposite);
}

function mergeMethodFor(config: FlywheelConfig): MergeMethod {
  return config.merge_strategy === "rebase" ? "REBASE" : "SQUASH";
}

interface BranchLocation {
  stream: Stream;
  branchIdx: number;
}

function locateBranch(config: FlywheelConfig, branchRef: string): BranchLocation | null {
  for (const stream of config.streams) {
    for (let i = 0; i < stream.branches.length; i++) {
      if (stream.branches[i]!.name === branchRef) return { stream, branchIdx: i };
    }
  }
  return null;
}

// Re-export for any caller that wants increment for diagnostics.
export { computeIncrement };
