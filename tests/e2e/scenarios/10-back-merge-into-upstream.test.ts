import { afterEach, describe, expect, it } from "vitest";

import {
  SANDBOX_OWNER,
  SANDBOX_REPO,
  sandboxOctokit,
  hasSandboxToken,
} from "../../integration/helpers/sandbox-client.js";
import { createTestPR, uniqueBranch } from "../../integration/helpers/test-pr.js";
import { registerForTeardown, runTeardown } from "../../integration/helpers/teardown.js";
import { pollUntil } from "../helpers/poll-until.js";
import { getRefSha, mergePR } from "../helpers/sandbox-e2e.js";
import { snapshotRunIds, waitForRunAfter } from "../helpers/run-baseline.js";
import { cleanupNewTags, snapshotTags, type TagBaseline } from "../helpers/tag-cleanup.js";

const E2E_DEVELOP = "e2e-develop";
const E2E_STAGING = "e2e-staging";
// Staging releases tag as `1.x.x-rc.N` — no scoped prefix on the main-line
// stream — so the bare `v` prefix matches them (along with develop's
// `1.x.x-dev.N` tags). Per-test cleanup diffs against a snapshot taken
// at the top of the test so we only delete tags this run produced.
const MAIN_LINE_TAG_PREFIX = "v";

// Why staging-into-develop, not main-into-{staging,develop}? The main-line
// stream is [develop → staging → main]. A release on staging back-merges
// into one upstream (develop); a release on main back-merges into two.
// Staging is the smallest path that exercises a non-empty
// `back_merge_targets`, which is the entire failure surface this scenario
// guards. customer-acme is single-branch (`back_merge_targets` always
// empty), which is why scenario 08 didn't catch #134 — the back-merge
// step's `if:` gate skipped it on every run. This scenario fills that gap.
//
// Five production-halting bugs have landed in the back-merge step
// (#112, #119, #128, #134, plus the apostrophe-escape typo within #128's
// own fix) and none were caught by the suite before adopters hit them.
// `tests/back-merge.test.ts` covers the script in isolation; this
// scenario is the *integration* — the workflow's `if:` gate, the action's
// `back_merge_targets` output, the env passed to the script, the runner
// having `scripts/back-merge.sh` on disk in the first place (the #134
// gap), and the merge actually landing on the protected upstream ref.
describe.skipIf(!hasSandboxToken)(
  "e2e/10: back-merge replays a staging release into develop",
  () => {
    let tagBaseline: TagBaseline;

    afterEach(async () => {
      // Tags first, branches/PRs second — semantic-release tags are
      // independent of the test branch so they outlive the PR cleanup.
      await cleanupNewTags(tagBaseline);
      await runTeardown();
    });

    it("a fix merged into e2e-staging back-merges into e2e-develop", async () => {
      tagBaseline = await snapshotTags(MAIN_LINE_TAG_PREFIX);

      const baseline = await snapshotRunIds([E2E_STAGING]);
      const baselinePush = baseline.get(E2E_STAGING)!.push;
      // Capture develop's tip *before* the staging release so we can
      // detect the back-merge by ref movement. Fast-forward and merge-
      // commit paths both advance the tip — we don't need to disambiguate.
      const developBaselineSha = await getRefSha(E2E_DEVELOP);

      const branch = uniqueBranch("e2e-back-merge");
      const pr = await createTestPR({
        branch,
        base: E2E_STAGING,
        title: "fix: e2e back-merge seed",
      });
      registerForTeardown({ branch, prNumber: pr.number });

      await mergePR(pr.number, "squash");

      // Wait for the push run on staging to complete. Once #135 lands,
      // `waitForRunAfter` rejects non-success conclusions — a back-merge
      // step that errors throws here with the run URL embedded in the
      // message, instead of silently letting the develop-tip assertion
      // race a stale ref. Today (pre-#135) this still works: a failed
      // back-merge leaves develop's tip unchanged and the next poll
      // times out with the unchanged SHA as the diagnostic.
      await waitForRunAfter("flywheel-push.yml", E2E_STAGING, baselinePush, {
        timeoutMs: 300_000,
      });

      // Back-merge signature: develop's tip moved past its baseline.
      // The script picks fast-forward (`git merge --ff-only`) when
      // develop is an ancestor of staging — common on a clean sandbox —
      // and a no-ff merge commit otherwise. Either path advances the
      // ref; we don't need to inspect the commit message. Brief poll
      // because the back-merge runs inside the same workflow run we
      // already waited on, so the ref should be updated by the time
      // we get here.
      const developAfterSha = await pollUntil(
        () => getRefSha(E2E_DEVELOP),
        (sha) => sha !== developBaselineSha,
        {
          intervalMs: 2000,
          timeoutMs: 30_000,
          description: `e2e-develop tip to advance past ${developBaselineSha.slice(0, 7)}`,
        },
      );
      expect(developAfterSha).not.toBe(developBaselineSha);

      // Negative: the script's fallback path opens a
      // `chore/back-merge-<tag>-into-<upstream>` PR when the merge
      // can't be auto-resolved. On a clean sandbox the registered
      // merge drivers (`flywheel-changelog` regenerator,
      // `flywheel-release-file` driver=true) eliminate the only
      // expected conflict surface (CHANGELOG.md + release_files),
      // so this path should not fire. If it does, the conflict-
      // resolution wiring has regressed — the test surfaces that
      // explicitly rather than silently degrading to "PR was opened
      // for human review."
      const fallbackPRs = await sandboxOctokit().rest.pulls.list({
        owner: SANDBOX_OWNER,
        repo: SANDBOX_REPO,
        state: "open",
        base: E2E_DEVELOP,
        per_page: 50,
      });
      const fallback = fallbackPRs.data.find((p) =>
        p.head.ref.startsWith("chore/back-merge-"),
      );
      expect(
        fallback,
        fallback
          ? `unexpected fallback PR #${fallback.number} (${fallback.html_url}) — ` +
              "back-merge took the conflict-recovery path; investigate merge-driver wiring"
          : undefined,
      ).toBeUndefined();
    });
  },
);
