// Close stranded open PRs in the flywheel-sandbox repo before an e2e run.
// Required because e2e.yml uses concurrency.cancel-in-progress: true — a
// SIGTERM-cancelled run cannot reliably finish its in-process afterEach
// teardown, leaving open PRs behind. The next run heals at startup so the
// cancelled run can die fast and free.
//
// Idempotent: against a clean sandbox it lists, finds nothing, exits 0.
//
// Inputs (env):
//   SANDBOX_GH_TOKEN - installation token with pull-requests:write on sandbox

import { getOctokit } from "@actions/github";

const OWNER = "point-source";
const REPO = "flywheel-sandbox";

const token = process.env.SANDBOX_GH_TOKEN;
if (!token) throw new Error("SANDBOX_GH_TOKEN is not set");

const octokit = getOctokit(token);

const open = await octokit.paginate(octokit.rest.pulls.list, {
  owner: OWNER,
  repo: REPO,
  state: "open",
  per_page: 100,
});

if (open.length === 0) {
  console.log("presweep: sandbox is clean");
  process.exit(0);
}

let closed = 0;
for (const pr of open) {
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
