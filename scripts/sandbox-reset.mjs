// Reset the flywheel-sandbox repo to a clean baseline. Manual-run only —
// not on any CI critical path. Run when accumulated test pollution
// (large pending lists, stranded PRs, drifted branch heads) starts
// causing cascading failures in the e2e or integration suites and you
// don't care to preserve any state on the sandbox.
//
// Operations (in order):
//   1. Resolve a base SHA from --base (defaults to the e2e-baseline tag,
//      which points to the sandbox's initial seed commit).
//   2. Force-update each managed branch to the base SHA.
//   3. Delete every git tag in the repo except e2e-baseline (semantic-release
//      version tags accumulate per release; e2e-baseline is the recovery
//      reference and must survive).
//   4. Close every open PR.
//   5. Delete orphan test/* branches left behind by cancelled test runs.
//
// What this preserves: the GitHub App installation, Actions vars/secrets,
// branch protection rulesets, allow_auto_merge, the e2e-baseline tag —
// everything outside the branch/tag/PR data layer.
//
// Inputs (env):
//   SANDBOX_GH_TOKEN - installation token (or OAuth token) with
//                      contents:write, pull-requests:write, metadata:read
//                      on the sandbox. The flywheel-build-e2e App
//                      installation token (used by e2e.yml) works.
//
// Args:
//   --base <ref-or-sha>  Base to rewind branches to. Accepts a branch
//                        name, tag name, or raw SHA. Default: e2e-baseline.
//   --dry-run            Print what would change; make no API mutations.
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
// Tags preserved across resets. e2e-baseline points to the initial seed
// commit and is the canonical recovery reference — wiping it would orphan
// the only stable target a future reset could rewind to.
const PRESERVED_TAGS = new Set(["e2e-baseline"]);

function parseArgs(argv) {
  const out = { base: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base") out.base = argv[++i];
    else if (argv[i] === "--dry-run") out.dryRun = true;
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("Usage: sandbox-reset.mjs [--base <ref-or-sha>] [--dry-run]");
      process.exit(0);
    } else throw new Error(`unknown arg: ${argv[i]}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

const token = process.env.SANDBOX_GH_TOKEN;
if (!token) throw new Error("SANDBOX_GH_TOKEN is not set");

const octokit = getOctokit(token);

// 1. Resolve base. If --base wasn't given, use the e2e-baseline tag.
//    Accepts branch name (heads/<name>), tag name (tags/<name>), or raw
//    SHA; the SHA-fallback path lets you pin to a specific commit when
//    every named ref is suspect.
async function resolveBase(input) {
  if (!input) {
    input = "e2e-baseline";
    console.log(`base: defaulting to tag ${input} (initial seed commit)`);
  }
  // Try branch, then tag, then raw SHA — in that order.
  for (const refType of ["heads", "tags"]) {
    try {
      const ref = await octokit.rest.git.getRef({
        owner: OWNER,
        repo: REPO,
        ref: `${refType}/${input}`,
      });
      // Annotated tags resolve to a tag object, not a commit — peel one layer.
      if (ref.data.object.type === "tag") {
        const tag = await octokit.rest.git.getTag({
          owner: OWNER,
          repo: REPO,
          tag_sha: ref.data.object.sha,
        });
        return { label: input, sha: tag.data.object.sha };
      }
      return { label: input, sha: ref.data.object.sha };
    } catch (err) {
      if (err.status !== 404) throw err;
    }
  }
  const commit = await octokit.rest.git.getCommit({
    owner: OWNER,
    repo: REPO,
    commit_sha: input,
  });
  return { label: input, sha: commit.data.sha };
}

const { label: baseLabel, sha: baseSha } = await resolveBase(args.base);
console.log(`base: ${baseLabel} → ${baseSha}`);

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
const deletableTags = tagRefs.filter(
  (t) => !PRESERVED_TAGS.has(t.ref.replace(/^refs\/tags\//, "")),
);
const preservedCount = tagRefs.length - deletableTags.length;
console.log(
  `tags: ${tagRefs.length} total, ${deletableTags.length} to delete` +
    (preservedCount ? `, ${preservedCount} preserved (${[...PRESERVED_TAGS].join(", ")})` : ""),
);
for (const t of deletableTags) {
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

// 5. Delete orphan test branches. uniqueBranch() in
// tests/integration/helpers/test-pr.ts produces `test/<slug>-<ts>-<rand>`
// for every integration and e2e test PR; the sandbox has no other
// `test/` branches. Closing PRs above doesn't delete their head refs,
// so without this step the orphans accumulate forever.
const allBranches = await octokit.paginate(octokit.rest.repos.listBranches, {
  owner: OWNER,
  repo: REPO,
  per_page: 100,
});
const orphans = allBranches.filter(
  (b) => b.name.startsWith("test/") && !MANAGED_BRANCHES.includes(b.name),
);
console.log(`branches: ${allBranches.length} total, ${orphans.length} test/ orphans to delete`);
for (const b of orphans) {
  if (args.dryRun) {
    console.log(`  would delete branch ${b.name}`);
    continue;
  }
  try {
    await octokit.rest.git.deleteRef({
      owner: OWNER,
      repo: REPO,
      ref: `heads/${b.name}`,
    });
    console.log(`  deleted branch ${b.name}`);
  } catch (err) {
    if (err.status !== 404 && err.status !== 422) throw err;
  }
}

console.log(args.dryRun ? "dry-run: no mutations performed" : "reset complete");
