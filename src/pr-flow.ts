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
  | {
      kind: "labeled";
      label: typeof FLYWHEEL_AUTO_MERGE_LABEL | typeof FLYWHEEL_NEEDS_REVIEW_LABEL;
      autoMergeEnabled: boolean;
      merged: boolean;
      autoMergeReason?: string;
      directMergeReason?: string;
    };

export const FLYWHEEL_TITLE_CHECK = "flywheel/conventional-commit";

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
      name: FLYWHEEL_TITLE_CHECK,
      conclusion: "failure",
      summary,
      details: `Got: ${pr.title}`,
      headSha: pr.headSha,
    });
    log.warning(`PR #${pr.number}: invalid conventional commit title — failing check posted.`);
    return { kind: "parse-failed" };
  }

  // Title is valid — always post a passing check so adopters can require
  // flywheel/conventional-commit in branch protection without it disappearing
  // for non-failing cases (which would surface as "Expected — Waiting for status").
  await gh.createCheck({
    name: FLYWHEEL_TITLE_CHECK,
    conclusion: "success",
    summary: `Valid conventional commit title.`,
    headSha: pr.headSha,
  });

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
    // Always issue the opposite-label removal — pr.labels can be a stale
    // read (GitHub's labels endpoint serves slightly outdated state when a
    // recent write hasn't fully propagated). Skipping based on a stale
    // includes() check leaves the wrong label permanently attached.
    // removeLabel is 404-tolerant so this is a no-op when the label
    // isn't actually present.
    await gh.removeLabel(pr.number, FLYWHEEL_NEEDS_REVIEW_LABEL);
    const method = mergeMethod(config);
    const result = await gh.enableAutoMerge(pr.nodeId, method);
    if (result.ok) {
      log.info(`PR #${pr.number}: auto-merge enabled (${method.toLowerCase()}).`);
      return {
        kind: "labeled",
        label: FLYWHEEL_AUTO_MERGE_LABEL,
        autoMergeEnabled: true,
        merged: false,
      };
    }

    // Native auto-merge declined. Most common cause when an adopter has no
    // required status checks: the PR is in clean state, so GitHub considers
    // there's nothing to schedule auto-merge against. Fall back to a direct
    // merge — the App's installation token can perform it provided branch
    // protection rules are satisfied.
    log.info(
      `PR #${pr.number}: native auto-merge declined (${result.reason}); attempting direct merge.`,
    );
    const directMerge = await gh.mergePR(pr.number, method);
    if (directMerge.ok) {
      log.info(`PR #${pr.number}: direct merge succeeded (${directMerge.sha.slice(0, 7)}).`);
      return {
        kind: "labeled",
        label: FLYWHEEL_AUTO_MERGE_LABEL,
        autoMergeEnabled: false,
        merged: true,
        autoMergeReason: result.reason,
      };
    }

    log.warning(
      `PR #${pr.number}: native auto-merge and direct merge both failed — auto-merge: ${result.reason}; direct: ${directMerge.reason}. Label applied; merge requires manual action.`,
    );
    return {
      kind: "labeled",
      label: FLYWHEEL_AUTO_MERGE_LABEL,
      autoMergeEnabled: false,
      merged: false,
      autoMergeReason: result.reason,
      directMergeReason: directMerge.reason,
    };
  }

  await gh.addLabels(pr.number, [FLYWHEEL_NEEDS_REVIEW_LABEL]);
  // See parallel comment on the eligible path above: pr.labels can be
  // a stale read; gate-skipping the cleanup leaves stuck labels.
  // removeLabel is 404-tolerant and disableAutoMerge swallows
  // "not enabled" errors, so both are safe to call unconditionally.
  await gh.removeLabel(pr.number, FLYWHEEL_AUTO_MERGE_LABEL);
  await gh.disableAutoMerge(pr.nodeId);
  log.info(`PR #${pr.number}: ${matchKey} not in auto_merge list for ${branch.name} → needs review.`);
  return {
    kind: "labeled",
    label: FLYWHEEL_NEEDS_REVIEW_LABEL,
    autoMergeEnabled: false,
    merged: false,
  };
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
