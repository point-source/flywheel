import { SANDBOX_OWNER, SANDBOX_REPO, sandboxOctokit } from "../../integration/helpers/sandbox-client.js";
import { pollUntil } from "./poll-until.js";

export type WorkflowFile = "flywheel-pr.yml" | "flywheel-push.yml";

export interface BaselineRunIds {
  push: number;
  pr: number;
}

export interface WorkflowRunSummary {
  id: number;
  status: string;
  conclusion: string | null;
  headSha: string;
  htmlUrl: string;
}

async function highestRunId(workflow: WorkflowFile, branch: string): Promise<number> {
  const octokit = sandboxOctokit();
  const res = await octokit.rest.actions.listWorkflowRuns({
    owner: SANDBOX_OWNER,
    repo: SANDBOX_REPO,
    workflow_id: workflow,
    branch,
    per_page: 1,
  });
  const top = res.data.workflow_runs[0];
  return top?.id ?? 0;
}

export async function snapshotRunIds(branches: string[]): Promise<Map<string, BaselineRunIds>> {
  const out = new Map<string, BaselineRunIds>();
  for (const branch of branches) {
    const [push, pr] = await Promise.all([
      highestRunId("flywheel-push.yml", branch),
      highestRunId("flywheel-pr.yml", branch),
    ]);
    out.set(branch, { push, pr });
  }
  return out;
}

// Conclusions we accept by default. `success` is the obvious one; the rest
// would silently absorb real failure modes a scenario should reject. Tests
// that legitimately want to accept a different outcome (e.g. asserting a
// run was cancelled) must opt in via `allowConclusions`.
const DEFAULT_ALLOWED_CONCLUSIONS: readonly string[] = ["success"] as const;

/** Outcome classifier extracted for direct unit testing — the version
 *  embedded inside the polling loop is wired to live API responses, which
 *  is integration territory. Keeping the logic pure lets us exercise the
 *  three branches (wait / done / fail-fast) without mocking octokit.
 *
 *  `wait` — run hasn't reached a terminal state; keep polling.
 *  `done` — run completed with an allowed conclusion; the wait is over.
 *  `fail` — run completed with a disallowed conclusion; abort immediately
 *           with a message that names the run URL. This is the behavior
 *           change in #135: before, `fail` was treated the same as `done`
 *           and the scenario's downstream assertions ran against the
 *           side-effects of a red run (root cause of #134 going undetected
 *           on the sandbox for 5 days).
 */
export type RunOutcome =
  | { kind: "wait" }
  | { kind: "done"; summary: WorkflowRunSummary }
  | { kind: "fail"; summary: WorkflowRunSummary; message: string };

export function classifyRunOutcome(
  summary: WorkflowRunSummary | null,
  allowConclusions: readonly string[] = DEFAULT_ALLOWED_CONCLUSIONS,
): RunOutcome {
  if (summary === null) return { kind: "wait" };
  if (summary.status !== "completed") return { kind: "wait" };
  if (allowConclusions.includes(summary.conclusion ?? "")) {
    return { kind: "done", summary };
  }
  return {
    kind: "fail",
    summary,
    message:
      `workflow run ${summary.id} concluded "${summary.conclusion ?? "unknown"}" ` +
      `(allowed: ${allowConclusions.join(", ")}). See ${summary.htmlUrl}`,
  };
}

/** Wait for a workflow run to reach a terminal state and assert its
 *  conclusion. Default is `success`-only — a run that concludes `failure`,
 *  `cancelled`, `timed_out`, `action_required`, or `neutral` throws
 *  immediately with the run URL embedded in the message. Pass
 *  `allowConclusions` to widen the accepted set (rare; scenarios that
 *  intentionally provoke a non-success outcome). See #135.
 */
export async function waitForRunAfter(
  workflow: WorkflowFile,
  branch: string,
  sinceId: number,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    allowConclusions?: readonly string[];
  } = {},
): Promise<WorkflowRunSummary> {
  const octokit = sandboxOctokit();
  const allow = options.allowConclusions ?? DEFAULT_ALLOWED_CONCLUSIONS;

  // The polling fetcher throws (not returns) on a terminal-but-disallowed
  // conclusion so `pollUntil`'s try/catch surface — if there were one —
  // wouldn't be needed; the throw aborts the poll loop with the run URL
  // already in the error message. Before #135 this branch ended the loop
  // with `kind: "done"` and the scenario's next assertion ran against the
  // side-effects of a failed run (root cause of #134's silence).
  return pollUntil(
    async () => {
      const res = await octokit.rest.actions.listWorkflowRuns({
        owner: SANDBOX_OWNER,
        repo: SANDBOX_REPO,
        workflow_id: workflow,
        branch,
        per_page: 10,
      });
      const newest = res.data.workflow_runs.find((r) => r.id > sinceId);
      const summary: WorkflowRunSummary | null = newest
        ? {
            id: newest.id,
            status: newest.status ?? "unknown",
            conclusion: newest.conclusion ?? null,
            headSha: newest.head_sha,
            htmlUrl: newest.html_url,
          }
        : null;
      const outcome = classifyRunOutcome(summary, allow);
      if (outcome.kind === "fail") {
        throw new Error(
          `${workflow} on ${branch} (after id ${sinceId}): ${outcome.message}`,
        );
      }
      // Returning `null` keeps pollUntil's predicate false; the existing
      // predicate (`status === "completed"`) is preserved as the "done"
      // signal — the new classifier only changes whether a *completed*
      // run is accepted or rejected.
      return outcome.kind === "done" ? outcome.summary : null;
    },
    (run): run is WorkflowRunSummary => run !== null && run.status === "completed",
    {
      // Pass `intervalMs` through only when the caller supplied one — otherwise
      // inherit `pollUntil`'s centralized default. Keeping a local fallback
      // here would create a second source of truth for per-poll cost and
      // defeat the single-file budget rule in §spec:sandbox-test-budget.
      // `waitForRunAfter`'s correctness does not depend on a particular
      // polling frequency: it observes a workflow run reaching a terminal
      // state, and the 120 s default timeout absorbs the slower default
      // cadence (≤ 12 polls vs. the previous ≤ 24).
      intervalMs: options.intervalMs,
      timeoutMs: options.timeoutMs ?? 120_000,
      description:
        `${workflow} run on ${branch} after id ${sinceId} to complete with conclusion in ` +
        `[${allow.join(", ")}]`,
    },
  ) as Promise<WorkflowRunSummary>;
}
