import type { FlywheelConfig } from "./types.js";

// Branch protection is split across two rulesets so the App's bypass scope
// is correctly narrow:
//
//   MANAGED_BRANCHES_RULESET_NAME — destruction protection. Rules: deletion
//     + non_fast_forward. No bypass actors, including the App. This blocks
//     GitHub's delete_branch_on_merge from wiping a stream branch when the
//     App auto-merges a promotion or feature PR. See #81.
//
//   MANAGED_BRANCHES_REVIEW_RULESET_NAME — review requirements. Rules:
//     pull_request (+ optional required_status_checks). The App is on the
//     bypass list so semantic-release can push the chore(release) commit
//     and back-merge directly to a stream branch without a PR.
//
// syncRulesets reconciles the include array on both, since they cover the
// same set of refs.
export const MANAGED_BRANCHES_RULESET_NAME = "Flywheel managed branches";
export const MANAGED_BRANCHES_REVIEW_RULESET_NAME = "Flywheel managed branches — review";
export const TAG_NAMESPACE_RULESET_NAME = "Flywheel tag namespace (v*)";

// Two patterns: primary stream tags (v1.2.3) and secondary stream tags
// (customer-acme/v1.2.3 etc.). Stream-prefixed tags are emitted when a
// secondary stream has its own tagFormat — see src/release-rc.ts.
export const TAG_NAMESPACE_INCLUDE = ["refs/tags/v*", "refs/tags/*/v*"];

export type RulesetTarget = "branch" | "tag" | "push";
export type RulesetEnforcement = "active" | "disabled" | "evaluate";

export interface RulesetSummary {
  id: number;
  name: string;
  target: RulesetTarget;
}

export interface RefNameCondition {
  include: string[];
  exclude: string[];
}

export interface RulesetDetail {
  id: number;
  name: string;
  target: RulesetTarget;
  enforcement: RulesetEnforcement;
  bypass_actors?: unknown[];
  conditions: { ref_name?: RefNameCondition } & Record<string, unknown>;
  rules: unknown[];
}

export interface RulesetUpdatePayload {
  name: string;
  target: RulesetTarget;
  enforcement: RulesetEnforcement;
  bypass_actors: unknown[];
  conditions: { ref_name: RefNameCondition } & Record<string, unknown>;
  rules: unknown[];
}

export interface RulesetApi {
  list(): Promise<RulesetSummary[]>;
  get(id: number): Promise<RulesetDetail>;
  update(id: number, payload: RulesetUpdatePayload): Promise<void>;
}

export interface SyncLogger {
  info(msg: string): void;
  warning(msg: string): void;
}

export interface SyncRulesetsResult {
  /** True if the destruction-protection branch ruleset's include drifted and was PUT. */
  branchUpdated: boolean;
  /** True if the review branch ruleset's include drifted and was PUT. */
  reviewUpdated: boolean;
  tagUpdated: boolean;
  skipped?: "forbidden";
}

/**
 * Re-aligns the managed-branches and tag-namespace rulesets with the current
 * .flywheel.yml. Idempotent: PUTs only if the include array drifted. Preserves
 * rules, bypass_actors, and any other fields the maintainer set via
 * apply-rulesets.sh — this only touches conditions.ref_name.include.
 *
 * Returns skipped: "forbidden" when the App lacks repository administration
 * scope (HTTP 403 on list). Caller logs and continues.
 */
export async function syncRulesets(deps: {
  api: RulesetApi;
  config: FlywheelConfig;
  log: SyncLogger;
}): Promise<SyncRulesetsResult> {
  const { api, config, log } = deps;

  const expectedBranches = expectedBranchIncludes(config);

  let rulesets: RulesetSummary[];
  try {
    rulesets = await api.list();
  } catch (err) {
    if (statusOf(err) === 403 || statusOf(err) === 404) {
      log.warning(
        "ruleset sync skipped: App lacks repository administration scope " +
          "(needed to read/update branch & tag rulesets). Re-run scripts/apply-rulesets.sh manually.",
      );
      return {
        branchUpdated: false,
        reviewUpdated: false,
        tagUpdated: false,
        skipped: "forbidden",
      };
    }
    throw err;
  }

  const branchSummary = rulesets.find(
    (r) => r.name === MANAGED_BRANCHES_RULESET_NAME,
  );
  const reviewSummary = rulesets.find(
    (r) => r.name === MANAGED_BRANCHES_REVIEW_RULESET_NAME,
  );
  const tagSummary = rulesets.find(
    (r) => r.name === TAG_NAMESPACE_RULESET_NAME,
  );

  let branchUpdated = false;
  let reviewUpdated = false;
  let tagUpdated = false;

  if (branchSummary) {
    branchUpdated = await reconcileInclude(
      api,
      branchSummary.id,
      expectedBranches,
      log,
      "managed-branches",
    );
  } else {
    log.warning(
      `ruleset '${MANAGED_BRANCHES_RULESET_NAME}' not found — bootstrap with scripts/apply-rulesets.sh.`,
    );
  }

  if (reviewSummary) {
    reviewUpdated = await reconcileInclude(
      api,
      reviewSummary.id,
      expectedBranches,
      log,
      "managed-branches-review",
    );
  } else {
    // Pre-#81 adopters still have a single combined ruleset under
    // MANAGED_BRANCHES_RULESET_NAME with the pull_request rule baked in.
    // Don't error — they keep working — but flag the recovery path so
    // the App-bypass-scoping fix gets applied.
    log.warning(
      `ruleset '${MANAGED_BRANCHES_REVIEW_RULESET_NAME}' not found — re-run scripts/apply-rulesets.sh to split ruleset bypass (see #81).`,
    );
  }

  if (tagSummary) {
    tagUpdated = await reconcileInclude(
      api,
      tagSummary.id,
      TAG_NAMESPACE_INCLUDE,
      log,
      "tag-namespace",
    );
  } else {
    log.warning(
      `ruleset '${TAG_NAMESPACE_RULESET_NAME}' not found — bootstrap with scripts/apply-rulesets.sh.`,
    );
  }

  return { branchUpdated, reviewUpdated, tagUpdated };
}

export function expectedBranchIncludes(config: FlywheelConfig): string[] {
  return config.streams.flatMap((s) =>
    s.branches.map((b) => `refs/heads/${b.name}`),
  );
}

async function reconcileInclude(
  api: RulesetApi,
  rulesetId: number,
  expected: string[],
  log: SyncLogger,
  label: string,
): Promise<boolean> {
  const detail = await api.get(rulesetId);
  const current = detail.conditions.ref_name?.include ?? [];
  if (sameSet(current, expected)) return false;

  const payload: RulesetUpdatePayload = {
    name: detail.name,
    target: detail.target,
    enforcement: detail.enforcement,
    bypass_actors: detail.bypass_actors ?? [],
    conditions: {
      ...detail.conditions,
      ref_name: {
        include: expected,
        exclude: detail.conditions.ref_name?.exclude ?? [],
      },
    },
    rules: detail.rules,
  };
  await api.update(rulesetId, payload);
  log.info(
    `${label} ruleset include updated: [${current.join(", ")}] → [${expected.join(", ")}]`,
  );
  return true;
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
  return true;
}

function statusOf(err: unknown): number | undefined {
  return (err as { status?: number } | undefined)?.status;
}
