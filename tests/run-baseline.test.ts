import { describe, expect, it } from "vitest";

import {
  classifyRunOutcome,
  type WorkflowRunSummary,
} from "./e2e/helpers/run-baseline.js";

// Unit coverage for the helper extracted in #135. The polling wrapper
// `waitForRunAfter` is exercised end-to-end by the e2e scenarios against
// the live sandbox; the *classification* logic — wait / done / fail-fast —
// is pure and worth a direct test so the three branches don't drift
// silently. Before #135 there was no fail-fast branch: a completed run
// with `conclusion: "failure"` short-circuited the wait and the scenario's
// next assertion ran against the side-effects of a red run (root cause
// of #134 going undetected on the sandbox for five days).

function summary(overrides: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return {
    id: 12345,
    status: "completed",
    conclusion: "success",
    headSha: "deadbeef",
    htmlUrl: "https://example.invalid/runs/12345",
    ...overrides,
  };
}

describe("classifyRunOutcome", () => {
  it("returns `wait` when no matching run has been observed yet", () => {
    expect(classifyRunOutcome(null)).toEqual({ kind: "wait" });
  });

  it("returns `wait` for a run that hasn't reached terminal status", () => {
    expect(classifyRunOutcome(summary({ status: "in_progress", conclusion: null })))
      .toEqual({ kind: "wait" });
    expect(classifyRunOutcome(summary({ status: "queued", conclusion: null })))
      .toEqual({ kind: "wait" });
  });

  it("returns `done` for a completed-with-success run by default", () => {
    const s = summary({ status: "completed", conclusion: "success" });
    expect(classifyRunOutcome(s)).toEqual({ kind: "done", summary: s });
  });

  // The five conclusions the GitHub API can attach to a "completed" run
  // beyond `success`. None of them should pass through the default
  // accept-set — they're the exact states #135 exists to surface. See
  // https://docs.github.com/en/rest/actions/workflow-runs.
  it.each(["failure", "cancelled", "timed_out", "action_required", "neutral", "skipped"])(
    "fails fast with the run URL when a completed run has conclusion %s",
    (conclusion) => {
      const s = summary({ status: "completed", conclusion });
      const outcome = classifyRunOutcome(s);
      expect(outcome.kind).toBe("fail");
      if (outcome.kind === "fail") {
        expect(outcome.summary).toBe(s);
        expect(outcome.message).toContain(conclusion);
        expect(outcome.message).toContain(s.htmlUrl);
      }
    },
  );

  it("fails fast when conclusion is null but status is completed (degenerate API state)", () => {
    // A run that reports `completed` with no `conclusion` should not be
    // treated as success — that's an unrecognized state, surface it.
    const s = summary({ status: "completed", conclusion: null });
    const outcome = classifyRunOutcome(s);
    expect(outcome.kind).toBe("fail");
    if (outcome.kind === "fail") {
      expect(outcome.message).toContain("unknown");
    }
  });

  it("accepts a widened conclusion set via `allowConclusions`", () => {
    // Opt-in path for scenarios that legitimately provoke a non-success
    // outcome (none today, but the option exists so we don't have to
    // duplicate the whole helper if such a test arrives).
    const s = summary({ status: "completed", conclusion: "cancelled" });
    expect(classifyRunOutcome(s, ["success", "cancelled"])).toEqual({
      kind: "done",
      summary: s,
    });
  });

  it("error message lists the allowed conclusions so debuggers can spot a misconfigured opt-in", () => {
    const s = summary({ status: "completed", conclusion: "failure" });
    const outcome = classifyRunOutcome(s, ["success", "skipped"]);
    expect(outcome.kind).toBe("fail");
    if (outcome.kind === "fail") {
      expect(outcome.message).toContain("success");
      expect(outcome.message).toContain("skipped");
    }
  });
});
