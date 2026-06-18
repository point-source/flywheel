import { describe, expect, it } from "vitest";

import {
  FLYWHEEL_AUTO_MERGE_LABEL,
  FLYWHEEL_NEEDS_REVIEW_LABEL,
  FLYWHEEL_TITLE_CHECK,
  postDegradedTitleCheck,
} from "../src/github.js";
import { createFakeGh, silentLogger } from "./helpers/fakeGh.js";

// Regression guard for §spec:dependabot-deadlock-test (§req:dependabot-deadlock).
//
// A Dependabot-triggered run sources secrets from the Dependabot store, not the
// Actions store, so `app-private-key` arrives empty. Before this fix the
// conductor returned early on an empty key and never posted the required
// `flywheel/conventional-commit` check — leaving every Dependabot PR stranded
// at `Expected` in a repo that requires the check. The degraded empty-key path
// (`postDegradedTitleCheck`) posts a pass/fail check from the built-in token and
// performs NO App-only action. These assertions pin both halves of that
// contract so a future change can't silently re-strand Dependabot PRs.
//
// This is a deterministic unit test on the conductor's degraded branch — it
// draws on no rate-limited e2e sandbox installation (§spec:sandbox-test-budget).

const HEAD_SHA = "abcdef01234567890abcdef01234567890abcdef";

describe("postDegradedTitleCheck — empty-key Dependabot path", () => {
  // Real Dependabot titles: `build(deps): …` and `chore(deps): …` (and the
  // `deps-dev` scope). All are valid conventional commits, so the degraded
  // path must post `success` — the same verdict a first-party PR gets, since
  // it runs the identical parser and posts the identical check name.
  it.each([
    "build(deps): bump actions/checkout from 4 to 5",
    "chore(deps): bump lodash from 4.17.20 to 4.17.21",
    "chore(deps-dev): bump vitest from 1.6.0 to 2.0.0",
  ])("posts a success check for a well-formed Dependabot title: %s", async (title) => {
    const gh = createFakeGh();
    const { log } = silentLogger();

    const result = await postDegradedTitleCheck(gh, { title, headSha: HEAD_SHA }, log);

    expect(result).toEqual({ conclusion: "success", posted: true });
    const checks = gh.createdChecks;
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      name: FLYWHEEL_TITLE_CHECK,
      conclusion: "success",
      headSha: HEAD_SHA,
    });

    // No App-only action ran: only createCheck was called, no label applied,
    // no title rewrite, no auto-merge.
    expect(gh.calls.map((c) => c.method)).toEqual(["createCheck"]);
    expect(gh.prLabels[7]).toBeUndefined();
  });

  // A malformed title (no conventional-commit prefix) must post `failure` —
  // again matching the first-party verdict — so the required check concludes
  // and the maintainer sees a red gate rather than a permanently `Expected` one.
  it.each([
    "Bump lodash from 4.17.20 to 4.17.21",
    "update dependencies",
    "build deps bump without a colon",
  ])("posts a failure check for a malformed Dependabot title: %s", async (title) => {
    const gh = createFakeGh();
    const { log } = silentLogger();

    const result = await postDegradedTitleCheck(gh, { title, headSha: HEAD_SHA }, log);

    expect(result).toEqual({ conclusion: "failure", posted: true });
    const checks = gh.createdChecks;
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      name: FLYWHEEL_TITLE_CHECK,
      conclusion: "failure",
      headSha: HEAD_SHA,
    });

    expect(gh.calls.map((c) => c.method)).toEqual(["createCheck"]);
    expect(gh.prLabels[7]).toBeUndefined();
  });

  it("never applies an auto-merge or needs-review label on the degraded path", async () => {
    // Belt-and-suspenders across both verdicts: the degraded path must grant
    // none of the App-only outcomes (labels, rewrite, native/direct merge).
    for (const title of ["build(deps): bump x from 1 to 2", "not a conventional commit"]) {
      const gh = createFakeGh();
      const { log } = silentLogger();

      await postDegradedTitleCheck(gh, { title, headSha: HEAD_SHA }, log);

      const methods = gh.calls.map((c) => c.method);
      expect(methods).not.toContain("addLabels");
      expect(methods).not.toContain("updatePR");
      expect(methods).not.toContain("enableAutoMerge");
      expect(methods).not.toContain("mergePR");
      expect(methods).not.toContain("disableAutoMerge");
      for (const labels of Object.values(gh.prLabels)) {
        expect(labels).not.toContain(FLYWHEEL_AUTO_MERGE_LABEL);
        expect(labels).not.toContain(FLYWHEEL_NEEDS_REVIEW_LABEL);
      }
    }
  });

  it("fails gracefully when the built-in token is read-only (fork case, #162)", async () => {
    // A fork PR's built-in token is forced read-only by GitHub, so createCheck
    // throws (e.g. 403 "Resource not accessible by integration"). The path must
    // log and return `posted: false` rather than throw and error the run —
    // fork behaviour stays out of scope (#162).
    const error = Object.assign(new Error("Resource not accessible by integration"), {
      status: 403,
    });
    const gh = {
      async createCheck(): Promise<void> {
        throw error;
      },
    };
    const { log, warnings } = silentLogger();

    const result = await postDegradedTitleCheck(
      gh,
      { title: "build(deps): bump x from 1 to 2", headSha: HEAD_SHA },
      log,
    );

    expect(result).toEqual({ conclusion: "success", posted: false });
    expect(warnings.some((w) => w.includes(FLYWHEEL_TITLE_CHECK))).toBe(true);
  });
});
