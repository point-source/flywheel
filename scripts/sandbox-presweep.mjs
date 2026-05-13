// Close stranded open PRs in the flywheel-sandbox repo before an e2e run.
// Required because e2e.yml uses concurrency.cancel-in-progress: true — a
// SIGTERM-cancelled run cannot reliably finish its in-process afterEach
// teardown, leaving open PRs behind. The next run heals at startup so the
// cancelled run can die fast and free.
//
// Scope: PR head ref matches one of:
//   - `e2e-*`            — test branches (uniqueBranch("e2e-*")) plus
//                          promotion PRs whose head is a managed e2e-*
//                          branch (e2e-staging → e2e-main, etc.).
//   - `chore/back-merge-*` — fallback PRs the back-merge script opens
//                          when a merge can't be auto-resolved. These
//                          are tied to a specific release tag (e.g.
//                          chore/back-merge-v1.0.0-rc.37-into-e2e-develop)
//                          and become stale immediately once the next
//                          release supersedes that tag. They were not
//                          covered by the original presweep, so they
//                          accumulated indefinitely and false-positived
//                          scenario 10's "no fallback PR opened"
//                          assertion on every run.
//
// Excluded: integration test PRs (head: promote-src-*, pr-title-*, etc.)
// which run concurrently in the same sandbox and must not be touched.
//
// Idempotent: against a clean sandbox it lists, finds nothing, exits 0.
//
// Inputs (env):
//   SANDBOX_GH_TOKEN - installation token with pull-requests:write on sandbox

import { getOctokit } from "@actions/github";

const OWNER = "point-source";
const REPO = "flywheel-sandbox";
// Head-ref prefixes the presweep is allowed to close. The matcher is
// strict prefix (not regex) — anything not starting with one of these
// is left alone, which keeps integration-test PRs (promote-src-*,
// pr-title-*, …) running in parallel from getting wiped out.
const SWEEP_HEAD_PREFIXES = ["e2e-", "chore/back-merge-"];

const token = process.env.SANDBOX_GH_TOKEN;
if (!token) throw new Error("SANDBOX_GH_TOKEN is not set");

const octokit = getOctokit(token);

const open = await octokit.paginate(octokit.rest.pulls.list, {
  owner: OWNER,
  repo: REPO,
  state: "open",
  per_page: 100,
});

const targets = open.filter((pr) =>
  SWEEP_HEAD_PREFIXES.some((prefix) => pr.head.ref.startsWith(prefix)),
);
if (targets.length === 0) {
  console.log(
    `presweep: no stranded PRs (${open.length} open total, none match head:[${SWEEP_HEAD_PREFIXES.join("|")}]*)`,
  );
  process.exit(0);
}

let closed = 0;
for (const pr of targets) {
  try {
    await octokit.rest.pulls.update({
      owner: OWNER,
      repo: REPO,
      pull_number: pr.number,
      state: "closed",
    });
    closed += 1;
    console.log(`presweep: closed #${pr.number} ${pr.head.ref} → ${pr.base.ref}`);
  } catch (err) {
    const status = err?.status;
    if (status !== 404 && status !== 422) throw err;
  }
}
console.log(`presweep: closed ${closed} stranded PR(s)`);
