import { describe, expect, it } from "vitest";

import {
  MANAGED_BRANCHES_RULESET_NAME,
  MANAGED_BRANCHES_REVIEW_RULESET_NAME,
  TAG_NAMESPACE_INCLUDE,
  TAG_NAMESPACE_RULESET_NAME,
  expectedBranchIncludes,
  syncRulesets,
  type RulesetApi,
  type RulesetDetail,
  type RulesetSummary,
  type RulesetUpdatePayload,
} from "../src/rulesets.js";
import type { FlywheelConfig } from "../src/types.js";

const baseConfig: FlywheelConfig = {
  streams: [
    {
      name: "main-line",
      branches: [
        { name: "develop", release: "prerelease", suffix: "dev", auto_merge: ["fix"] },
        { name: "main", release: "production", auto_merge: [] },
      ],
    },
    {
      name: "customer-acme",
      branches: [
        { name: "customer-acme", release: "prerelease", suffix: "acme", auto_merge: ["fix"] },
      ],
    },
  ],
};

interface FakeApiInit {
  rulesets?: Array<{ summary: RulesetSummary; detail: RulesetDetail }>;
  listError?: { status: number };
}

function createFakeApi(init: FakeApiInit = {}): {
  api: RulesetApi;
  updates: Array<{ id: number; payload: RulesetUpdatePayload }>;
} {
  const updates: Array<{ id: number; payload: RulesetUpdatePayload }> = [];
  const items = init.rulesets ?? [];
  return {
    api: {
      async list() {
        if (init.listError) {
          throw Object.assign(new Error("denied"), init.listError);
        }
        return items.map((i) => i.summary);
      },
      async get(id) {
        const found = items.find((i) => i.summary.id === id);
        if (!found) throw Object.assign(new Error("not found"), { status: 404 });
        return found.detail;
      },
      async update(id, payload) {
        updates.push({ id, payload });
      },
    },
    updates,
  };
}

function silentLogger() {
  const infos: string[] = [];
  const warnings: string[] = [];
  return {
    log: {
      info: (m: string) => infos.push(m),
      warning: (m: string) => warnings.push(m),
    },
    infos,
    warnings,
  };
}

function makeBranchRuleset(include: string[]): {
  summary: RulesetSummary;
  detail: RulesetDetail;
} {
  return {
    summary: { id: 100, name: MANAGED_BRANCHES_RULESET_NAME, target: "branch" },
    detail: {
      id: 100,
      name: MANAGED_BRANCHES_RULESET_NAME,
      target: "branch",
      enforcement: "active",
      // Destruction-protection ruleset: NO bypass, even for the App.
      bypass_actors: [],
      conditions: { ref_name: { include, exclude: [] } },
      rules: [{ type: "deletion" }, { type: "non_fast_forward" }],
    },
  };
}

function makeReviewRuleset(include: string[]): {
  summary: RulesetSummary;
  detail: RulesetDetail;
} {
  return {
    summary: {
      id: 150,
      name: MANAGED_BRANCHES_REVIEW_RULESET_NAME,
      target: "branch",
    },
    detail: {
      id: 150,
      name: MANAGED_BRANCHES_REVIEW_RULESET_NAME,
      target: "branch",
      enforcement: "active",
      // Review ruleset: App bypass for direct semantic-release pushes.
      bypass_actors: [
        { actor_id: 12345, actor_type: "Integration", bypass_mode: "always" },
      ],
      conditions: { ref_name: { include, exclude: [] } },
      rules: [{ type: "pull_request" }],
    },
  };
}

function makeTagRuleset(include: string[]): {
  summary: RulesetSummary;
  detail: RulesetDetail;
} {
  return {
    summary: { id: 200, name: TAG_NAMESPACE_RULESET_NAME, target: "tag" },
    detail: {
      id: 200,
      name: TAG_NAMESPACE_RULESET_NAME,
      target: "tag",
      enforcement: "active",
      bypass_actors: [],
      conditions: { ref_name: { include, exclude: [] } },
      rules: [{ type: "deletion" }, { type: "non_fast_forward" }],
    },
  };
}

describe("expectedBranchIncludes", () => {
  it("returns refs/heads/<name> for every branch across all streams", () => {
    expect(expectedBranchIncludes(baseConfig)).toEqual([
      "refs/heads/develop",
      "refs/heads/main",
      "refs/heads/customer-acme",
    ]);
  });
});

describe("syncRulesets", () => {
  it("updates managed-branches ruleset when include drifted from config", async () => {
    const branch = makeBranchRuleset(["refs/heads/develop", "refs/heads/main"]);
    const review = makeReviewRuleset([
      "refs/heads/develop",
      "refs/heads/main",
      "refs/heads/customer-acme",
    ]);
    const tag = makeTagRuleset(TAG_NAMESPACE_INCLUDE);
    const { api, updates } = createFakeApi({ rulesets: [branch, review, tag] });
    const { log } = silentLogger();

    const result = await syncRulesets({ api, config: baseConfig, log });

    expect(result.branchUpdated).toBe(true);
    expect(result.reviewUpdated).toBe(false);
    expect(result.tagUpdated).toBe(false);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.id).toBe(100);
    expect(updates[0]!.payload.conditions.ref_name.include).toEqual([
      "refs/heads/develop",
      "refs/heads/main",
      "refs/heads/customer-acme",
    ]);
  });

  it("preserves rules and bypass_actors when reconciling include", async () => {
    const branch = makeBranchRuleset(["refs/heads/develop"]);
    const { api, updates } = createFakeApi({ rulesets: [branch] });
    const { log } = silentLogger();

    await syncRulesets({ api, config: baseConfig, log });

    expect(updates[0]!.payload.rules).toEqual(branch.detail.rules);
    expect(updates[0]!.payload.bypass_actors).toEqual(branch.detail.bypass_actors);
    expect(updates[0]!.payload.enforcement).toBe("active");
    expect(updates[0]!.payload.target).toBe("branch");
  });

  it("is idempotent — no PUT when include already matches", async () => {
    const branch = makeBranchRuleset([
      "refs/heads/develop",
      "refs/heads/main",
      "refs/heads/customer-acme",
    ]);
    const review = makeReviewRuleset([
      "refs/heads/develop",
      "refs/heads/main",
      "refs/heads/customer-acme",
    ]);
    const tag = makeTagRuleset(TAG_NAMESPACE_INCLUDE);
    const { api, updates } = createFakeApi({ rulesets: [branch, review, tag] });
    const { log } = silentLogger();

    const result = await syncRulesets({ api, config: baseConfig, log });

    expect(result.branchUpdated).toBe(false);
    expect(result.reviewUpdated).toBe(false);
    expect(result.tagUpdated).toBe(false);
    expect(updates).toEqual([]);
  });

  it("reorders include array but treats it as same set (no spurious PUT)", async () => {
    const branch = makeBranchRuleset([
      "refs/heads/customer-acme",
      "refs/heads/main",
      "refs/heads/develop",
    ]);
    const { api, updates } = createFakeApi({ rulesets: [branch] });
    const { log } = silentLogger();

    const result = await syncRulesets({ api, config: baseConfig, log });

    expect(result.branchUpdated).toBe(false);
    expect(updates).toEqual([]);
  });

  it("reconciles the review ruleset's include alongside the destruction one", async () => {
    // Both branch rulesets cover the same set of refs, so syncRulesets has
    // to PUT both when the config grows a new branch.
    const branch = makeBranchRuleset(["refs/heads/develop", "refs/heads/main"]);
    const review = makeReviewRuleset(["refs/heads/develop", "refs/heads/main"]);
    const { api, updates } = createFakeApi({ rulesets: [branch, review] });
    const { log } = silentLogger();

    const result = await syncRulesets({ api, config: baseConfig, log });

    expect(result.branchUpdated).toBe(true);
    expect(result.reviewUpdated).toBe(true);
    expect(updates).toHaveLength(2);
    const reviewUpdate = updates.find((u) => u.id === 150);
    expect(reviewUpdate).toBeDefined();
    expect(reviewUpdate!.payload.conditions.ref_name.include).toEqual([
      "refs/heads/develop",
      "refs/heads/main",
      "refs/heads/customer-acme",
    ]);
    // Bypass on the review ruleset is preserved on PUT.
    expect(reviewUpdate!.payload.bypass_actors).toEqual(review.detail.bypass_actors);
  });

  it("warns when only the legacy combined ruleset exists (review missing) — pre-#81 adopter migration prompt", async () => {
    // Pre-#81 adopters have a single "Flywheel managed branches" ruleset
    // that bundles deletion + non_fast_forward + pull_request with the App
    // on the bypass list. syncRulesets reconciles the include array (so
    // they keep working) but warns that apply-rulesets.sh needs to re-run
    // to split the bypass scope.
    const branch = makeBranchRuleset(["refs/heads/develop", "refs/heads/main"]);
    const tag = makeTagRuleset(TAG_NAMESPACE_INCLUDE);
    const { api, updates } = createFakeApi({ rulesets: [branch, tag] });
    const { log, warnings } = silentLogger();

    const result = await syncRulesets({ api, config: baseConfig, log });

    expect(result.reviewUpdated).toBe(false);
    expect(warnings.some((w) => w.includes(MANAGED_BRANCHES_REVIEW_RULESET_NAME))).toBe(true);
    expect(warnings.some((w) => w.includes("#81"))).toBe(true);
    // Destruction ruleset still gets reconciled — adopter isn't blocked.
    expect(updates.find((u) => u.id === 100)).toBeDefined();
  });

  it("upgrades tag ruleset to multi-stream include when missing the */v* pattern", async () => {
    const branch = makeBranchRuleset([
      "refs/heads/develop",
      "refs/heads/main",
      "refs/heads/customer-acme",
    ]);
    const review = makeReviewRuleset([
      "refs/heads/develop",
      "refs/heads/main",
      "refs/heads/customer-acme",
    ]);
    const tag = makeTagRuleset(["refs/tags/v*"]);
    const { api, updates } = createFakeApi({ rulesets: [branch, review, tag] });
    const { log } = silentLogger();

    const result = await syncRulesets({ api, config: baseConfig, log });

    expect(result.tagUpdated).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.id).toBe(200);
    expect(updates[0]!.payload.conditions.ref_name.include).toEqual([
      "refs/tags/v*",
      "refs/tags/*/v*",
    ]);
  });

  it("warns and continues when a ruleset is missing", async () => {
    const tag = makeTagRuleset(TAG_NAMESPACE_INCLUDE);
    const { api, updates } = createFakeApi({ rulesets: [tag] });
    const { log, warnings } = silentLogger();

    const result = await syncRulesets({ api, config: baseConfig, log });

    expect(result.branchUpdated).toBe(false);
    expect(updates).toEqual([]);
    expect(warnings.some((w) => w.includes(MANAGED_BRANCHES_RULESET_NAME))).toBe(true);
  });

  it("returns skipped: forbidden on 403 list response", async () => {
    const { api, updates } = createFakeApi({ listError: { status: 403 } });
    const { log, warnings } = silentLogger();

    const result = await syncRulesets({ api, config: baseConfig, log });

    expect(result.skipped).toBe("forbidden");
    expect(updates).toEqual([]);
    expect(warnings.some((w) => w.includes("administration"))).toBe(true);
  });

  it("returns skipped: forbidden on 404 list response (no rulesets endpoint)", async () => {
    const { api, updates } = createFakeApi({ listError: { status: 404 } });
    const { log } = silentLogger();

    const result = await syncRulesets({ api, config: baseConfig, log });

    expect(result.skipped).toBe("forbidden");
    expect(updates).toEqual([]);
  });

  it("rethrows on unexpected list error (e.g. 500)", async () => {
    const { api } = createFakeApi({ listError: { status: 500 } });
    const { log } = silentLogger();

    await expect(syncRulesets({ api, config: baseConfig, log })).rejects.toThrow();
  });
});
