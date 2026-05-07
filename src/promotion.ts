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
  | { kind: "in-sync" }
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
    gh.listBranchCommits(source.name),
    gh.listBranchCommits(target.name),
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
  const closesRefs = await aggregateClosesRefs(gh, pending);
  const body = formatPromotionBody({
    pending,
    sourceName: source.name,
    targetName: target.name,
    matchKey,
    eligible,
    targetBranch: target,
    closesRefs,
  });
  // Promotion PRs always use a true merge commit. Squash on this edge severs
  // ancestry between source and target — see docs/design/decisions/0001-hybrid-merge-strategy.md.
  const method: MergeMethod = "MERGE";

  const existing = await gh.listOpenPRs({ head: source.name, base: target.name });

  if (existing.length === 0) {
    let created;
    try {
      created = await gh.createPR({
        title,
        body,
        head: source.name,
        base: target.name,
      });
    } catch (err) {
      if (isNoCommitsBetweenError(err)) {
        // Race: pending detection saw bumping commits but GitHub's compare
        // says target is already up to date. Happens after a back-merge that
        // fast-forwards source to target's tip — see #71.
        log.info(
          `promotion: ${source.name} → ${target.name} already in sync per GitHub (createPR 422) — skipping.`,
        );
        return { kind: "in-sync" };
      }
      throw err;
    }
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
  const { sourceCommits, targetCommits } = input;

  // Fast-path: source and target tips equal → nothing to promote. Aligns
  // pending detection with GitHub's compare view after a back-merge
  // fast-forwards source to target's tip; without it the createPR call
  // below would 422 on "No commits between" — see #71.
  if (
    sourceCommits.length > 0 &&
    targetCommits.length > 0 &&
    sourceCommits[0]!.sha === targetCommits[0]!.sha
  ) {
    return [];
  }

  // Approximate `git log target..source` from the two reachable-history
  // listings: a source commit is pending iff it isn't already on target.
  // Under hybrid mode promotion PRs land as true merge commits, so source
  // commits become reachable from target and SHA equality is authoritative
  // once the streams have been promoted at least once. Title equality is
  // only a sound fallback in the initial-seed case (no SHAs overlap yet) —
  // applying it after the first promotion silently drops a legitimately
  // pending commit whose title happens to match an already-promoted one
  // (two distinct PRs with identical titles). See #102.
  const targetShas = new Set(targetCommits.map((c) => c.sha));
  const hasShaOverlap = sourceCommits.some((c) => targetShas.has(c.sha));
  if (hasShaOverlap) {
    return sourceCommits.filter((c) => !targetShas.has(c.sha));
  }

  // Initial-seed path: no SHA overlap yet, so SHA-difference can't tell
  // pending from already-on-target. Fall back to title-difference (after
  // stripping GitHub's `(#NN)` squash-merge suffix).
  const targetTitles = new Set(targetCommits.map((c) => normalizeTitle(c.title)));
  return sourceCommits.filter(
    (c) => !targetShas.has(c.sha) && !targetTitles.has(normalizeTitle(c.title)),
  );
}

function buildPromotionTitleRegex(source: string, target: string): RegExp {
  const escapedSource = escapeRegex(source);
  const escapedTarget = escapeRegex(target);
  return new RegExp(
    `^[a-z]+(\\([^)]+\\))?!?: promote ${escapedSource} → ${escapedTarget}$`,
  );
}

// True when (headRef → baseRef) is a configured promotion edge AND the title
// matches the promotion-PR shape this module emits. pr-flow consults this so
// it can leave promotion PRs to runPromotion (different merge method, body
// owned by formatPromotionBody) instead of treating them as feature PRs.
export function isPromotionPR(
  config: FlywheelConfig,
  headRef: string,
  baseRef: string,
  title: string,
): boolean {
  for (const stream of config.streams) {
    for (let i = 0; i < stream.branches.length - 1; i++) {
      const source = stream.branches[i]!;
      const target = stream.branches[i + 1]!;
      if (source.name === headRef && target.name === baseRef) {
        return buildPromotionTitleRegex(source.name, target.name).test(title);
      }
    }
  }
  return false;
}

// Back-merge fallback PRs are opened by push.yml's back-merge step when an
// automatic main → develop merge can't be done locally (the merge drivers
// should make this rare; see #119). They look like normal `chore` PRs but
// must NOT be auto-merged by pr-flow: a SQUASH would collapse the released
// commit out of the upstream branch's ancestry, leaving no post-release
// common ancestor and re-opening the same divergence on the next promotion
// (#120). pr-flow short-circuits on these so the PR sits with
// `flywheel:needs-review` until a human resolves the conflicts and merges
// with a true merge commit.
//
// Detection is by head-branch shape — push.yml sets it deterministically as
// `chore/back-merge-<safe_tag>-into-<upstream>`. The base must be a managed
// branch in the config. We deliberately don't validate the title; push.yml
// sets it but a human resolving the conflict might rewrite it.
export function isBackMergePR(
  config: FlywheelConfig,
  headRef: string,
  baseRef: string,
): boolean {
  if (locateBranch(config, baseRef) === null) return false;
  const escaped = escapeRegex(baseRef);
  return new RegExp(`^chore/back-merge-.+-into-${escaped}$`).test(headRef);
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
  closesRefs: number[];
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
  // Closes-keyword references aggregated from each pending sub-PR's body
  // (see aggregateClosesRefs). When the promotion PR merges into the
  // production branch GitHub auto-closes these issues — without this line
  // they stay open because GitHub only auto-closes from PRs/commits that
  // land on the default branch, and sub-PRs land on develop. See #77.
  if (p.closesRefs.length > 0) {
    lines.push(
      p.closesRefs.map((n) => `Closes #${n}`).join("\n"),
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

// Squash-merge titles end with `(#NN)` appended by GitHub — that's the PR
// number whose body we want. Original PR titles can also contain (#NN)
// references (issue links typed by the author), so we take the LAST match,
// not the first. Returns null when no trailing PR-number suffix is present
// (e.g. a chore(release) commit pushed by the bot, or a directly-pushed
// commit on the source branch).
function extractTrailingPrNumber(title: string): number | null {
  const m = title.match(/\(#(\d+)\)\s*$/);
  return m ? Number.parseInt(m[1]!, 10) : null;
}

// GitHub recognizes these closing keywords (case-insensitive) in PR
// descriptions and auto-closes the referenced issue when the PR merges
// into the default branch. We extract the same set so the aggregated
// promotion PR body triggers the same behavior. Same-repo refs only —
// cross-repo `owner/repo#N` is intentionally skipped (the issue lives
// elsewhere and propagating it from a flywheel-owned PR risks
// closing unrelated issues).
const CLOSES_KEYWORD_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)[\s:]+#(\d+)\b/gi;

export function extractClosesRefs(body: string | null): number[] {
  if (!body) return [];
  const out: number[] = [];
  for (const m of body.matchAll(CLOSES_KEYWORD_RE)) {
    out.push(Number.parseInt(m[1]!, 10));
  }
  return out;
}

// Cap on parallel getPullBody calls during Closes-aggregation. Unbounded
// Promise.all over a large `pending` list trips GitHub's secondary rate
// limit (the limit is on bursts of concurrent requests, not total volume),
// which fails the whole runPromotion. 5 in flight stays well under
// GitHub's published guidance of "no more than 100 concurrent requests"
// while still parallelizing enough to keep a typical promotion fast.
const GET_PULL_BODY_CONCURRENCY = 5;

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function aggregateClosesRefs(
  gh: GitHubClient,
  pending: Commit[],
): Promise<number[]> {
  const subPrNumbers = pending
    .map((c) => extractTrailingPrNumber(c.title))
    .filter((n): n is number => n !== null);
  if (subPrNumbers.length === 0) return [];
  const bodies = await mapWithConcurrency(
    subPrNumbers,
    GET_PULL_BODY_CONCURRENCY,
    (n) => gh.getPullBody(n),
  );
  const refs = bodies.flatMap(extractClosesRefs);
  // Drop self-references — a sub-PR whose body says "closes #<itself>" is
  // either a typo or a reference to a future-numbered issue that GitHub
  // already linked separately. Either way, repeating it on the promotion
  // PR is noise.
  const filtered = refs.filter((n) => !subPrNumbers.includes(n));
  return Array.from(new Set(filtered)).sort((a, b) => a - b);
}

function isNoCommitsBetweenError(err: unknown): boolean {
  const e = err as { status?: number; message?: string } | undefined;
  if (!e) return false;
  if (e.status !== 422) return false;
  const msg = e.message ?? "";
  return msg.includes("No commits between");
}

async function applyLabel(gh: GitHubClient, prNumber: number, label: string): Promise<void> {
  await gh.addLabels(prNumber, [label]);
  const opposite = label === FLYWHEEL_AUTO_MERGE_LABEL ? FLYWHEEL_NEEDS_REVIEW_LABEL : FLYWHEEL_AUTO_MERGE_LABEL;
  await gh.removeLabel(prNumber, opposite);
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
