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
import { extractClosesRefs, isBackMergePR, isPromotionPR } from "./promotion.js";
import { findSkipCiMarkers } from "./skip-ci.js";

export type PrFlowOutcome =
  | { kind: "unmanaged" }
  | { kind: "parse-failed" }
  | { kind: "skip-ci-found" }
  | { kind: "promotion-pr" }
  | { kind: "back-merge-pr" }
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

  // Promotion PRs are owned by runPromotion: it sets the title and body
  // (formatPromotionBody), applies the label, and enables native auto-merge
  // with MERGE method. If pr-flow keeps going it would rewrite the body via
  // renderBody and re-enable auto-merge with SQUASH — squashing on the
  // promotion edge collapses the changelog to one commit on the production
  // branch (see #78). Post the conventional-commit success check so adopters
  // can require it in branch protection without stalling the promotion, and
  // exit.
  if (isPromotionPR(config, pr.headRef, pr.baseRef, pr.title)) {
    await gh.createCheck({
      name: FLYWHEEL_TITLE_CHECK,
      conclusion: "success",
      summary: `Valid conventional commit title.`,
      headSha: pr.headSha,
    });
    log.info(`PR #${pr.number}: promotion PR — owned by runPromotion, skipping pr-flow rewrite.`);
    return { kind: "promotion-pr" };
  }

  // Back-merge fallback PRs (opened by push.yml when an automatic merge from
  // the released branch into an upstream branch hits an unexpected conflict)
  // must NOT be auto-merged: pr-flow's default SQUASH would collapse the
  // released `chore(release)` commit out of the upstream's ancestry, leaving
  // no post-release common ancestor and re-opening the same divergence on
  // the next promotion (#120). Short-circuit so the PR sits with the
  // `flywheel:needs-review` label push.yml applied at creation; a human
  // resolves the conflicts and uses GitHub's "Create a merge commit" option
  // to produce a true two-parent merge that preserves lineage.
  if (isBackMergePR(config, pr.headRef, pr.baseRef)) {
    await gh.createCheck({
      name: FLYWHEEL_TITLE_CHECK,
      conclusion: "success",
      summary: `Valid conventional commit title.`,
      headSha: pr.headSha,
    });
    log.info(
      `PR #${pr.number}: back-merge fallback PR — needs human resolution + true merge, skipping pr-flow rewrite.`,
    );
    return { kind: "back-merge-pr" };
  }

  const commits = await gh.listPullCommits(pr.number);

  // Skip-ci markers anywhere in the PR title, body, or any commit message
  // would propagate into the squash-merge commit body and silently suppress
  // every workflow on the merged commit. Block before they can reach the
  // merge commit. See src/skip-ci.ts for the recognized variants.
  const skipCiHits = findSkipCiMarkers([
    { source: "PR title", text: pr.title },
    { source: "PR body", text: pr.body ?? "" },
    ...commits.flatMap((c): { source: string; text: string }[] => [
      { source: `commit ${c.sha.slice(0, 7)} title`, text: c.title },
      { source: `commit ${c.sha.slice(0, 7)} body`, text: c.body ?? "" },
    ]),
  ]);
  if (skipCiHits.length > 0) {
    const summary = `PR contains GitHub Actions skip-ci marker(s). These suppress workflows on the merged commit and must be removed before merging.`;
    const details = skipCiHits.map((h) => `- ${h.source}: \`${h.marker}\``).join("\n");
    await gh.createCheck({
      name: FLYWHEEL_TITLE_CHECK,
      conclusion: "failure",
      summary,
      details,
      headSha: pr.headSha,
    });
    log.warning(`PR #${pr.number}: skip-ci marker(s) found — failing check posted.`);
    return { kind: "skip-ci-found" };
  }

  // Title is valid and no skip-ci markers. The passing flywheel/conventional-commit
  // check is posted further down — after native auto-merge is scheduled on the
  // eligible path (see the comment there), and unconditionally on the
  // needs-review path. Adopters can require this check in branch protection
  // without it disappearing for non-failing cases ("Expected — Waiting for
  // status").
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
    existingBody: pr.body,
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
    // Feature PRs into stream branches always squash so each PR contributes
    // exactly one CHANGELOG entry (per the conventional-commit title) and
    // intermediate WIP commits stay invisible.
    const method: MergeMethod = "SQUASH";
    // Schedule native auto-merge *before* posting the flywheel/conventional-commit
    // check. While that required check is still unreported the PR sits in a
    // `blocked` state, so `enablePullRequestAutoMerge` is accepted and the
    // squash is scheduled; posting the success check immediately after clears
    // the gate and GitHub merges via native auto-merge — which honors every
    // required status check. Posting the check first leaves the PR `clean`,
    // GitHub refuses to schedule auto-merge (nothing to wait on), and the PR
    // falls through to the direct merge below — which runs under the App token
    // and bypasses required checks via the review ruleset's `bypass_actors`
    // entry (#147).
    const result = await gh.enableAutoMerge(pr.nodeId, method);
    await gh.createCheck({
      name: FLYWHEEL_TITLE_CHECK,
      conclusion: "success",
      summary: `Valid conventional commit title.`,
      headSha: pr.headSha,
    });
    if (result.ok) {
      log.info(`PR #${pr.number}: auto-merge enabled (${method.toLowerCase()}).`);
      return {
        kind: "labeled",
        label: FLYWHEEL_AUTO_MERGE_LABEL,
        autoMergeEnabled: true,
        merged: false,
      };
    }

    // Native auto-merge declined. Fall back to a direct merge only when the
    // PR is genuinely already mergeable with nothing outstanding — GitHub's
    // mergeable_state "clean". That is the no-required-checks adopter, where
    // an immediate merge is exactly what auto-merge would have done. Any other
    // state — in particular "blocked", which is what a repo that has required
    // checks but `allow_auto_merge` disabled reports — means a direct merge
    // under the App token would bypass the gate via the review ruleset's
    // `bypass_actors` entry (#147). "unknown" (GitHub still computing
    // mergeability) is treated as non-clean: fail safe and leave the PR for
    // manual action. (Gating on the decline *reason* string was too brittle —
    // GitHub's wording is not contractual and broke the no-required-checks
    // path; mergeable_state is a stable enum.)
    const mergeableState = await gh.getMergeableState(pr.number);
    if (mergeableState !== "clean") {
      log.warning(
        `PR #${pr.number}: native auto-merge declined (${result.reason}) and PR mergeable_state is "${mergeableState}" (not "clean") — NOT falling back to a direct merge, which would bypass required checks. Label applied; merge requires manual action — check the repository 'Allow auto-merge' setting and branch protection.`,
      );
      return {
        kind: "labeled",
        label: FLYWHEEL_AUTO_MERGE_LABEL,
        autoMergeEnabled: false,
        merged: false,
        autoMergeReason: result.reason,
      };
    }

    // mergeable_state is "clean": the PR is already mergeable with nothing to
    // wait on. Fall back to a direct merge — the App's installation token can
    // perform it.
    log.info(
      `PR #${pr.number}: native auto-merge declined (${result.reason}); mergeable_state is "clean" — attempting direct merge.`,
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
      `PR #${pr.number}: native auto-merge declined (${result.reason}) and direct merge failed — direct: ${directMerge.reason}. Label applied; merge requires manual action.`,
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
  // Post the passing conventional-commit check. There is no auto-merge to
  // schedule on this path, so ordering relative to the check doesn't matter
  // here — but the check must still be posted so an adopter requiring it in
  // branch protection doesn't see a permanent "Expected — Waiting for status".
  await gh.createCheck({
    name: FLYWHEEL_TITLE_CHECK,
    conclusion: "success",
    summary: `Valid conventional commit title.`,
    headSha: pr.headSha,
  });
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
  // Existing PR body, read so issue-closing trailers (Closes/Fixes/Resolves)
  // survive renderBody's full-body rewrite and reach aggregateClosesRefs on
  // the develop→main promotion. Without this, GitHub never auto-closes the
  // linked issues — the promotion lands on the default branch but its body
  // has no closing keywords to act on. See #115.
  existingBody?: string | null;
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

  const closesRefs = Array.from(new Set(extractClosesRefs(p.existingBody ?? null))).sort(
    (a, b) => a - b,
  );
  if (closesRefs.length > 0) {
    for (const n of closesRefs) sections.push(`Closes #${n}`);
    sections.push("");
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
