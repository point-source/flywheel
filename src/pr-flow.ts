import type { Branch, FlywheelConfig, IncrementType, ParsedTitle } from "./types.js";
import {
  computeIncrement,
  detectBreakingInBody,
  parseTitle,
  VALID_TYPES,
} from "./conventional.js";
import {
  FLYWHEEL_AUTO_MERGE_LABEL,
  FLYWHEEL_NEEDS_REVIEW_LABEL,
  type Commit,
  type GitHubClient,
  type MergeMethod,
  type PullRequest,
} from "./github.js";

export type PrFlowOutcome =
  | { kind: "unmanaged" }
  | { kind: "parse-failed" }
  | { kind: "labeled"; label: typeof FLYWHEEL_AUTO_MERGE_LABEL | typeof FLYWHEEL_NEEDS_REVIEW_LABEL; autoMergeEnabled: boolean; autoMergeReason?: string };

export interface PrFlowDeps {
  pr: PullRequest;
  config: FlywheelConfig;
  gh: GitHubClient;
  log: Logger;
}

export interface Logger {
  info(msg: string): void;
  warning(msg: string): void;
}

export async function runPrFlow({ pr, config, gh, log }: PrFlowDeps): Promise<PrFlowOutcome> {
  const branch = findBranch(config, pr.baseRef);
  if (!branch) {
    log.info(`PR #${pr.number}: target branch ${pr.baseRef} is not in any stream — skipping.`);
    return { kind: "unmanaged" };
  }

  const parsed = parseTitle(pr.title);
  if (!parsed) {
    const summary = `Title is not a valid conventional commit. Expected \`<type>[(<scope>)][!]: <description>\` where type is one of ${VALID_TYPES.join(", ")}.`;
    await gh.createCheck({
      name: "flywheel/conventional-commit",
      conclusion: "failure",
      summary,
      details: `Got: ${pr.title}`,
      headSha: pr.headSha,
    });
    log.warning(`PR #${pr.number}: invalid conventional commit title — failing check posted.`);
    return { kind: "parse-failed" };
  }

  const commits = await gh.listPullCommits(pr.number);
  const breakingFromBodies = commits.some((c) => detectBreakingInBody(c.body));
  const increment = computeIncrement(parsed, breakingFromBodies);
  const matchKey = parsed.breaking || breakingFromBodies ? `${parsed.type}!` : parsed.type;
  const eligible = branch.auto_merge.includes(matchKey);

  const newTitle = formatTitle(parsed, breakingFromBodies);
  const newBody = renderBody({
    parsed,
    breakingFromBodies,
    commits,
    increment,
    branchName: branch.name,
    eligible,
    matchKey,
  });

  if (newTitle !== pr.title || newBody !== pr.body) {
    await gh.updatePR(pr.number, {
      ...(newTitle !== pr.title ? { title: newTitle } : {}),
      ...(newBody !== pr.body ? { body: newBody } : {}),
    });
  }

  if (eligible) {
    await gh.addLabels(pr.number, [FLYWHEEL_AUTO_MERGE_LABEL]);
    if (pr.labels.includes(FLYWHEEL_NEEDS_REVIEW_LABEL)) {
      await gh.removeLabel(pr.number, FLYWHEEL_NEEDS_REVIEW_LABEL);
    }
    const method = mergeMethod(config);
    const result = await gh.enableAutoMerge(pr.nodeId, method);
    if (result.ok) {
      log.info(`PR #${pr.number}: auto-merge enabled (${method.toLowerCase()}).`);
      return { kind: "labeled", label: FLYWHEEL_AUTO_MERGE_LABEL, autoMergeEnabled: true };
    }
    log.warning(
      `PR #${pr.number}: could not enable native auto-merge — ${result.reason}. Label applied; merge requires manual action.`,
    );
    return {
      kind: "labeled",
      label: FLYWHEEL_AUTO_MERGE_LABEL,
      autoMergeEnabled: false,
      autoMergeReason: result.reason,
    };
  }

  await gh.addLabels(pr.number, [FLYWHEEL_NEEDS_REVIEW_LABEL]);
  if (pr.labels.includes(FLYWHEEL_AUTO_MERGE_LABEL)) {
    await gh.removeLabel(pr.number, FLYWHEEL_AUTO_MERGE_LABEL);
    await gh.disableAutoMerge(pr.nodeId);
  }
  log.info(`PR #${pr.number}: ${matchKey} not in auto_merge list for ${branch.name} → needs review.`);
  return { kind: "labeled", label: FLYWHEEL_NEEDS_REVIEW_LABEL, autoMergeEnabled: false };
}

function findBranch(config: FlywheelConfig, baseRef: string): Branch | null {
  for (const stream of config.streams) {
    for (const branch of stream.branches) {
      if (branch.name === baseRef) return branch;
    }
  }
  return null;
}

function mergeMethod(config: FlywheelConfig): MergeMethod {
  return config.merge_strategy === "rebase" ? "REBASE" : "SQUASH";
}

function formatTitle(parsed: ParsedTitle, breakingFromBodies: boolean): string {
  const breaking = parsed.breaking || breakingFromBodies;
  const scope = parsed.scope ? `(${parsed.scope})` : "";
  const bang = breaking ? "!" : "";
  return `${parsed.type}${scope}${bang}: ${parsed.description}`;
}

interface BodyParams {
  parsed: ParsedTitle;
  breakingFromBodies: boolean;
  commits: Commit[];
  increment: IncrementType;
  branchName: string;
  eligible: boolean;
  matchKey: string;
}

function renderBody(p: BodyParams): string {
  const grouped = groupCommits(p.commits, p.parsed);
  const sections: string[] = ["## Summary", "", p.parsed.description, ""];

  sections.push("## Changes", "");
  for (const [type, items] of grouped) {
    sections.push(`### ${type}`, "");
    for (const item of items) {
      sections.push(`- ${item.desc}${item.shaShort ? ` (${item.shaShort})` : ""}`);
    }
    sections.push("");
  }

  if (p.breakingFromBodies && !p.parsed.breaking) {
    sections.push(
      "> ⚠ A `BREAKING CHANGE:` footer was detected in one or more commit bodies — this PR is treated as a major-bump release.",
      "",
    );
  }

  sections.push("---", "");
  sections.push(`**Increment type:** ${p.increment}`);
  sections.push(`**Target branch:** ${p.branchName}`);
  if (p.eligible) {
    sections.push(
      `**Status:** ✅ \`${FLYWHEEL_AUTO_MERGE_LABEL}\` — \`${p.matchKey}\` is in auto_merge list for \`${p.branchName}\``,
    );
  } else {
    sections.push(
      `**Status:** 👀 \`${FLYWHEEL_NEEDS_REVIEW_LABEL}\` — \`${p.matchKey}\` is not in auto_merge list for \`${p.branchName}\``,
    );
  }
  sections.push("**Quality checks:** see required status checks for live state.");

  return sections.join("\n");
}

interface GroupedItem {
  desc: string;
  shaShort: string;
}

function groupCommits(
  commits: Commit[],
  fallbackTitle: ParsedTitle,
): Map<string, GroupedItem[]> {
  const groups = new Map<string, GroupedItem[]>();
  for (const c of commits) {
    const parsed = parseTitle(c.title);
    if (!parsed) continue;
    const list = groups.get(parsed.type) ?? [];
    list.push({ desc: parsed.description, shaShort: c.sha.slice(0, 7) });
    groups.set(parsed.type, list);
  }
  if (groups.size === 0) {
    groups.set(fallbackTitle.type, [{ desc: fallbackTitle.description, shaShort: "" }]);
  }
  return groups;
}
