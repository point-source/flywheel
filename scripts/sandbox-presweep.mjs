// Close stranded open PRs in the flywheel-sandbox repo before an e2e run.
// Required because e2e.yml uses concurrency.cancel-in-progress: true — a
// SIGTERM-cancelled run cannot reliably finish its in-process afterEach
// teardown, leaving open PRs behind. The next run heals at startup so the
// cancelled run can die fast and free.
//
// Scope: only PRs whose head ref starts with `e2e-`. This catches every
// e2e test branch (uniqueBranch("e2e-*")) plus promotion PRs whose head
// is a managed e2e-* branch (e2e-staging → e2e-main, etc.). It explicitly
// excludes integration test PRs (head: promote-src-*, pr-title-*, etc.)
// which run concurrently in the same sandbox and must not be touched.
//
// Idempotent: against a clean sandbox it lists, finds nothing, exits 0.
//
// Inputs (env):
//   SANDBOX_GH_TOKEN - installation token with pull-requests:write on sandbox

import { getOctokit } from "@actions/github";

const OWNER = "point-source";
const REPO = "flywheel-sandbox";
const HEAD_PREFIX = "e2e-";

const token = process.env.SANDBOX_GH_TOKEN;
if (!token) throw new Error("SANDBOX_GH_TOKEN is not set");

const octokit = getOctokit(token);

const open = await octokit.paginate(octokit.rest.pulls.list, {
  owner: OWNER,
  repo: REPO,
  state: "open",
  per_page: 100,
});

const targets = open.filter((pr) => pr.head.ref.startsWith(HEAD_PREFIX));
if (targets.length === 0) {
  console.log(`presweep: no stranded e2e PRs (${open.length} open total, none match head:${HEAD_PREFIX}*)`);
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
console.log(`presweep: closed ${closed} stranded e2e PR(s)`);
