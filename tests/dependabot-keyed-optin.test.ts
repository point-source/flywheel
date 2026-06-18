import { describe, expect, it } from "vitest";

import { runPrFlow } from "../src/pr-flow.js";
import {
  FLYWHEEL_AUTO_MERGE_LABEL,
  FLYWHEEL_NEEDS_REVIEW_LABEL,
  postDegradedTitleCheck,
  type PullRequest,
} from "../src/github.js";
import type { FlywheelConfig } from "../src/types.js";
import { createFakeGh, makeCommit, silentLogger } from "./helpers/fakeGh.js";

// Two-sided invariant guard for §spec:dependabot-full-conductor-optin
// (§req:dependabot-deadlock): "a Dependabot PR never auto-merges unless the App
// key is reachable on the run."
//
// HALF 1 — key ABSENT (Dependabot secret store has no `app-private-key`): the
//   conductor takes the degraded empty-key branch, posting only the
//   `flywheel/conventional-commit` check (pass for a well-formed `build(deps):`
//   / `chore(deps):` title, fail for a malformed one) and performing NO App-only
//   action — no auto-merge, no label, no title rewrite. The exhaustive coverage
//   of that branch lives in tests/dependabot-deadlock.test.ts; here we restate
//   only the load-bearing "no auto-merge without the key" half so this file
//   reads as a self-contained statement of the invariant.
//
// HALF 2 — key PRESENT (secret registered, conductor falls through to the full
//   flow): runPrFlow runs identically to a first-party PR. Auto-merge is decided
//   purely by the existing `auto_merge` title-type matching — there is NO
//   Dependabot special-casing. A `build(deps)` bump whose type is in the target
//   branch's `auto_merge` set auto-merges; one whose type is not gets
//   needs-review — the same outcome a first-party PR with the same title gets.
//
// Both halves are deterministic conductor-level unit tests — neither draws on
// the rate-limited e2e sandbox installation (§spec:sandbox-test-budget).

const HEAD_SHA = "abcdef01234567890abcdef01234567890abcdef";

// develop auto-merges the Dependabot title types (`build`/`chore`); main
// auto-merges nothing. Retargeting the same bump from develop to main is how
// these tests drive an eligible vs. an ineligible Dependabot PR off one config.
const config: FlywheelConfig = {
  streams: [
    {
      name: "main-line",
      branches: [
        {
          name: "develop",
          release: "prerelease",
          suffix: "dev",
          auto_merge: ["build", "chore"],
        },
        { name: "main", release: "production", auto_merge: [] },
      ],
    },
  ],
};

// Most HALF-2 tests load a single head commit whose message matches the PR
// title; this builds a fake gh client pre-loaded with that commit.
function ghWithCommit(message: string) {
  return createFakeGh({ pullCommits: { 7: [makeCommit("aaaaaaa", message)] } });
}

function makePR(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 7,
    title: "build(deps): bump actions/checkout from 4 to 5",
    body: "Bumps actions/checkout from 4 to 5.",
    baseRef: "develop",
    headRef: "dependabot/github_actions/actions/checkout-5",
    headSha: HEAD_SHA,
    nodeId: "PR_node_7",
    labels: [],
    draft: false,
    ...overrides,
  };
}

describe("Dependabot never auto-merges without the App key (§spec:dependabot-full-conductor-optin)", () => {
  describe("HALF 1 — key absent: degraded path posts the check but no App-only action", () => {
    // The conductor branches to the degraded path SOLELY on an empty
    // `app-private-key`; postDegradedTitleCheck is that branch's only effect.
    // A well-formed Dependabot title still concludes the required check (so the
    // PR isn't stranded at `Expected`) — but it does NOT auto-merge, because
    // auto-merge is an App-only action and the key is absent.
    it("posts the degraded check for a well-formed Dependabot title but never auto-merges or labels", async () => {
      const gh = createFakeGh();
      const { log } = silentLogger();

      const result = await postDegradedTitleCheck(
        gh,
        { title: "build(deps): bump actions/checkout from 4 to 5", headSha: HEAD_SHA },
        log,
      );

      expect(result).toEqual({ conclusion: "success", posted: true });
      // The degraded branch's ONLY GitHub call is createCheck — no auto-merge,
      // no label, no title rewrite.
      expect(gh.calls.map((c) => c.method)).toEqual(["createCheck"]);
      expect(gh.autoMergeEnabledFor).toEqual([]);
      expect(gh.directMergedPRs).toEqual([]);
      expect(Object.values(gh.prLabels).flat()).not.toContain(FLYWHEEL_AUTO_MERGE_LABEL);
      expect(Object.values(gh.prLabels).flat()).not.toContain(FLYWHEEL_NEEDS_REVIEW_LABEL);
    });

    it("posts a failing degraded check for a malformed Dependabot title and still never auto-merges", async () => {
      const gh = createFakeGh();
      const { log } = silentLogger();

      const result = await postDegradedTitleCheck(
        gh,
        { title: "Bump actions/checkout from 4 to 5", headSha: HEAD_SHA },
        log,
      );

      expect(result).toEqual({ conclusion: "failure", posted: true });
      expect(gh.calls.map((c) => c.method)).toEqual(["createCheck"]);
      expect(gh.autoMergeEnabledFor).toEqual([]);
      expect(gh.directMergedPRs).toEqual([]);
    });
  });

  describe("HALF 2 — key present: full conductor, no Dependabot special-casing", () => {
    // The PullRequest shape the conductor receives carries no author/actor
    // field, so there is nowhere for Dependabot-specific branching to hook in.
    // Auto-merge is decided purely by `auto_merge` title-type matching. These
    // tests drive runPrFlow with real Dependabot titles to prove that.

    it("(a) auto-merges a build(deps) bump whose type IS in the target auto_merge set — same as a first-party PR", async () => {
      const gh = ghWithCommit("build(deps): bump actions/checkout from 4 to 5");
      const { log } = silentLogger();

      const outcome = await runPrFlow({ pr: makePR(), config, gh, log });

      expect(outcome).toMatchObject({
        kind: "labeled",
        label: FLYWHEEL_AUTO_MERGE_LABEL,
        autoMergeEnabled: true,
      });
      expect(gh.prLabels[7]).toContain(FLYWHEEL_AUTO_MERGE_LABEL);
      expect(gh.autoMergeEnabledFor).toContain("PR_node_7");
    });

    it("(b) does NOT auto-merge a Dependabot bump whose type is NOT in auto_merge — applies needs-review instead", async () => {
      // Same Dependabot PR, retargeted to `main` (auto_merge: []). The build
      // type is no longer eligible, so the conductor applies needs-review and
      // schedules no auto-merge — exactly as it would for a first-party
      // `build:` PR into main.
      const gh = ghWithCommit("build(deps): bump actions/checkout from 4 to 5");
      const { log } = silentLogger();

      const outcome = await runPrFlow({
        pr: makePR({ baseRef: "main" }),
        config,
        gh,
        log,
      });

      expect(outcome).toMatchObject({
        kind: "labeled",
        label: FLYWHEEL_NEEDS_REVIEW_LABEL,
        autoMergeEnabled: false,
      });
      expect(gh.prLabels[7]).toContain(FLYWHEEL_NEEDS_REVIEW_LABEL);
      expect(gh.autoMergeEnabledFor).toEqual([]);
    });

    it("produces the identical outcome for a Dependabot PR and a first-party PR with the same title", async () => {
      // The proof of "no special-casing": two PRs with the same conventional
      // title — one Dependabot-shaped (dependabot/* head ref, Dependabot body),
      // one first-party (feature branch, hand-written body) — yield the same
      // auto-merge decision. The conductor cannot tell them apart, and doesn't
      // try.
      const dependabotGh = ghWithCommit("chore(deps): bump lodash from 4.17.20 to 4.17.21");
      const firstPartyGh = ghWithCommit("chore(deps): bump lodash from 4.17.20 to 4.17.21");
      const { log } = silentLogger();

      const dependabotOutcome = await runPrFlow({
        pr: makePR({
          title: "chore(deps): bump lodash from 4.17.20 to 4.17.21",
          headRef: "dependabot/npm_and_yarn/lodash-4.17.21",
          body: "Bumps lodash from 4.17.20 to 4.17.21.",
        }),
        config,
        gh: dependabotGh,
        log,
      });

      const firstPartyOutcome = await runPrFlow({
        pr: makePR({
          title: "chore(deps): bump lodash from 4.17.20 to 4.17.21",
          headRef: "feature/manual-lodash-bump",
          body: "Manually bumping lodash.",
        }),
        config,
        gh: firstPartyGh,
        log,
      });

      // Same eligibility decision, same auto-merge enablement.
      expect(dependabotOutcome).toMatchObject({
        kind: "labeled",
        label: FLYWHEEL_AUTO_MERGE_LABEL,
        autoMergeEnabled: true,
      });
      expect(firstPartyOutcome).toMatchObject({
        kind: "labeled",
        label: FLYWHEEL_AUTO_MERGE_LABEL,
        autoMergeEnabled: true,
      });
      expect(dependabotGh.autoMergeEnabledFor).toEqual(firstPartyGh.autoMergeEnabledFor);
      expect(dependabotGh.prLabels[7]).toEqual(firstPartyGh.prLabels[7]);
    });
  });
});
