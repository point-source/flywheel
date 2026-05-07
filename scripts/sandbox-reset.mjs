// Reset the flywheel-sandbox repo to a clean baseline. Manual-run only —
// not on any CI critical path. Run when accumulated test pollution
// (large pending lists, stranded PRs, drifted branch heads) starts
// causing cascading failures in the e2e or integration suites and you
// don't care to preserve any state on the sandbox.
//
// Operations (in order):
//   1. Resolve a base SHA from --base (defaults to "main").
//   2. Force-update each managed branch to the base SHA.
//   3. Delete every git tag in the repo (semantic-release version tags).
//   4. Close every open PR.
//
// What this preserves: the GitHub App installation, Actions vars/secrets,
// branch protection rulesets, allow_auto_merge — everything outside the
// branch/tag/PR data layer.
//
// Inputs (env):
//   SANDBOX_GH_TOKEN - installation token with contents:write,
//                      pull-requests:write, metadata:read on sandbox.
//                      The flywheel-build-e2e App installation token
//                      (used by e2e.yml) works.
//
// Args:
//   --base <ref>   Base ref to rewind branches to. Default: "main".
//   --dry-run      Print what would change; make no API mutations.
//
// Idempotent: re-running on a clean sandbox is a no-op.

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

function parseArgs(argv) {
  const out = { base: "main", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base") out.base = argv[++i];
    else if (argv[i] === "--dry-run") out.dryRun = true;
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("Usage: sandbox-reset.mjs [--base <ref>] [--dry-run]");
      process.exit(0);
    } else throw new Error(`unknown arg: ${argv[i]}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

const token = process.env.SANDBOX_GH_TOKEN;
if (!token) throw new Error("SANDBOX_GH_TOKEN is not set");

if (MANAGED_BRANCHES.includes(args.base)) {
  throw new Error(
    `--base ${args.base} is itself a managed branch — pick a control ref ` +
      `(e.g. main, or a pinned SHA via --base <sha>) so the rewind has a stable target`,
  );
}

const octokit = getOctokit(token);

// 1. Resolve base.
const baseRef = await octokit.rest.git.getRef({
  owner: OWNER,
  repo: REPO,
  ref: `heads/${args.base}`,
});
const baseSha = baseRef.data.object.sha;
console.log(`base: ${args.base} → ${baseSha}`);

// 2. Rewind managed branches.
for (const branch of MANAGED_BRANCHES) {
  let currentSha = null;
  try {
    const ref = await octokit.rest.git.getRef({
      owner: OWNER,
      repo: REPO,
      ref: `heads/${branch}`,
    });
    currentSha = ref.data.object.sha;
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  if (currentSha === baseSha) {
    console.log(`${branch}: already at base — skip`);
    continue;
  }
  const fromLabel = currentSha ? currentSha.slice(0, 7) : "(absent)";
  if (args.dryRun) {
    console.log(`${branch}: would rewind ${fromLabel} → ${baseSha.slice(0, 7)}`);
    continue;
  }
  if (currentSha === null) {
    await octokit.rest.git.createRef({
      owner: OWNER,
      repo: REPO,
      ref: `refs/heads/${branch}`,
      sha: baseSha,
    });
  } else {
    await octokit.rest.git.updateRef({
      owner: OWNER,
      repo: REPO,
      ref: `heads/${branch}`,
      sha: baseSha,
      force: true,
    });
  }
  console.log(`${branch}: rewound ${fromLabel} → ${baseSha.slice(0, 7)}`);
}

// 3. Delete all tags. The sandbox only carries semantic-release version
// tags; there's nothing else worth keeping. Resetting them prevents
// semantic-release from computing the next version against stale state
// after the branch rewind.
const tagRefs = await octokit.paginate(octokit.rest.git.listMatchingRefs, {
  owner: OWNER,
  repo: REPO,
  ref: "tags/",
  per_page: 100,
});
console.log(`tags: ${tagRefs.length} to delete`);
for (const t of tagRefs) {
  const name = t.ref.replace(/^refs\/tags\//, "");
  if (args.dryRun) {
    console.log(`  would delete tag ${name}`);
    continue;
  }
  try {
    await octokit.rest.git.deleteRef({
      owner: OWNER,
      repo: REPO,
      ref: `tags/${name}`,
    });
    console.log(`  deleted tag ${name}`);
  } catch (err) {
    if (err.status !== 422 && err.status !== 404) throw err;
  }
}

// 4. Close all open PRs. Every open PR on the sandbox is test debris —
// either an in-flight test PR from a cancelled run or a stale promotion
// PR whose source branch is about to be rewound out from under it.
const openPRs = await octokit.paginate(octokit.rest.pulls.list, {
  owner: OWNER,
  repo: REPO,
  state: "open",
  per_page: 100,
});
console.log(`PRs: ${openPRs.length} open to close`);
for (const pr of openPRs) {
  if (args.dryRun) {
    console.log(`  would close #${pr.number} (${pr.head.ref} → ${pr.base.ref})`);
    continue;
  }
  try {
    await octokit.rest.pulls.update({
      owner: OWNER,
      repo: REPO,
      pull_number: pr.number,
      state: "closed",
    });
    console.log(`  closed #${pr.number} (${pr.head.ref} → ${pr.base.ref})`);
  } catch (err) {
    if (err.status !== 404 && err.status !== 422) throw err;
  }
}

console.log(args.dryRun ? "dry-run: no mutations performed" : "reset complete");
