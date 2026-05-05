// Sync the workflow templates + the e2e .flywheel.yml fixture into the
// flywheel-sandbox repo's managed branches before the e2e suite runs.
// This treats the sandbox's workflow files as ephemeral artifacts derived
// from scripts/templates/ at the SHA under test, so a PR that updates a
// template is exercised end-to-end on the same run, without manual
// sandbox-repo maintenance.
//
// Inputs (env):
//   SANDBOX_GH_TOKEN     - installation token with contents:write on sandbox
//   FLYWHEEL_ACTION_REF  - git ref (commit SHA preferred) to substitute for
//                          __FLYWHEEL_VERSION__ in the templates
//
// Idempotent: pushes only when at least one of the three files differs from
// the branch's current content. Each commit carries [skip ci] so it does
// not retrigger the sandbox's own Flywheel — Push.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getOctokit } from "@actions/github";

const OWNER = "point-source";
const REPO = "flywheel-sandbox";
const MANAGED_BRANCHES = [
  "e2e-develop",
  "e2e-staging",
  "e2e-main",
  "e2e-customer-acme",
  "integration-test-base",
];

const token = process.env.SANDBOX_GH_TOKEN;
const actionRef = process.env.FLYWHEEL_ACTION_REF;
if (!token) throw new Error("SANDBOX_GH_TOKEN is not set");
if (!actionRef) throw new Error("FLYWHEEL_ACTION_REF is not set");

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pushTpl = readFileSync(join(repoRoot, "scripts/templates/flywheel-push.yml"), "utf8")
  .replaceAll("__FLYWHEEL_VERSION__", actionRef);
const prTpl = readFileSync(join(repoRoot, "scripts/templates/flywheel-pr.yml"), "utf8")
  .replaceAll("__FLYWHEEL_VERSION__", actionRef);
const fwYml = readFileSync(join(repoRoot, "tests/e2e/fixtures/sandbox.flywheel.yml"), "utf8");

const FILES = [
  { path: ".github/workflows/flywheel-push.yml", content: pushTpl },
  { path: ".github/workflows/flywheel-pr.yml", content: prTpl },
  { path: ".flywheel.yml", content: fwYml },
];

const octokit = getOctokit(token);

async function getFileContent(branch, path) {
  try {
    const res = await octokit.rest.repos.getContent({
      owner: OWNER,
      repo: REPO,
      path,
      ref: branch,
    });
    if (Array.isArray(res.data) || res.data.type !== "file") {
      throw new Error(`${path}@${branch} is not a file`);
    }
    return Buffer.from(res.data.content, res.data.encoding).toString("utf8");
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function syncBranch(branch) {
  let drift = false;
  for (const f of FILES) {
    const existing = await getFileContent(branch, f.path);
    if (existing !== f.content) {
      drift = true;
      break;
    }
  }
  if (!drift) {
    console.log(`${branch}: in sync`);
    return;
  }

  const ref = await octokit.rest.git.getRef({
    owner: OWNER,
    repo: REPO,
    ref: `heads/${branch}`,
  });
  const parentSha = ref.data.object.sha;
  const parent = await octokit.rest.git.getCommit({
    owner: OWNER,
    repo: REPO,
    commit_sha: parentSha,
  });
  const tree = await octokit.rest.git.createTree({
    owner: OWNER,
    repo: REPO,
    base_tree: parent.data.tree.sha,
    tree: FILES.map((f) => ({
      path: f.path,
      mode: "100644",
      type: "blob",
      content: f.content,
    })),
  });
  const commit = await octokit.rest.git.createCommit({
    owner: OWNER,
    repo: REPO,
    message: `ci: sync e2e fixtures from ${actionRef.slice(0, 7)} [skip ci]`,
    tree: tree.data.sha,
    parents: [parentSha],
  });
  // force: true because integration tests merge PRs into integration-test-base
  // (and e2e tests advance e2e-* branches), so the ref may have moved between
  // getRef above and updateRef here. The sync's intent is "reset sandbox to
  // the SHA under test", so non-FF overwrites are correct — those intermediate
  // commits are throwaway test artifacts.
  await octokit.rest.git.updateRef({
    owner: OWNER,
    repo: REPO,
    ref: `heads/${branch}`,
    sha: commit.data.sha,
    force: true,
  });
  console.log(`${branch}: synced ${commit.data.sha.slice(0, 7)}`);
}

for (const branch of MANAGED_BRANCHES) {
  await syncBranch(branch);
}
