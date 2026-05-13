import * as core from "@actions/core";
import * as github from "@actions/github";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { mintInstallationToken } from "./auth.js";
import { loadConfig } from "./config.js";
import { createGitHubClient, type PullRequest } from "./github.js";
import { runPrFlow } from "./pr-flow.js";
import { getUpstreamBranches, runPushFlow, findStreamForBranch } from "./push-flow.js";
import { runPromotion } from "./promotion.js";
import { syncRulesets } from "./rulesets.js";
import { findMissingPermissions, formatMissingPermissionsError } from "./preflight.js";

const CONFIG_FILE = ".flywheel.yml";

async function run(): Promise<void> {
  const event = core.getInput("event", { required: true });
  const appId = core.getInput("app-id", { required: true });
  const privateKey = core.getInput("app-private-key");

  const ctx = github.context;
  const owner = ctx.repo.owner;
  const repo = ctx.repo.repo;

  // Fork-PR shortcut: GitHub doesn't pass repo secrets to PR workflows from
  // forks, so app-private-key arrives empty. Without a key we can't mint an
  // installation token, and the workflow's default GITHUB_TOKEN is read-only
  // on fork PRs anyway — there's nothing useful for the conductor to do.
  // Exit cleanly with a notice so the workflow ends green. See roadmap.md.
  if (!privateKey || privateKey.trim() === "") {
    core.notice(
      "Flywheel: app-private-key is empty. This is expected for fork PRs " +
        "(GitHub does not pass secrets to fork PR workflows). Skipping the " +
        "conductor — title rewrite, auto-merge labels, and promotion PR upserts " +
        "will not run on this PR. The PR can still be merged manually.",
    );
    core.setOutput("managed_branch", "false");
    return;
  }

  let auth;
  try {
    auth = await mintInstallationToken(appId, privateKey, owner, repo);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    core.setFailed(`Could not mint installation token for ${owner}/${repo}: ${msg}`);
    return;
  }
  core.setSecret(auth.token);
  core.setOutput("token", auth.token);

  const missing = findMissingPermissions(auth.permissions);
  if (missing.length > 0) {
    core.setFailed(formatMissingPermissionsError(missing, auth.appSlug, `${owner}/${repo}`));
    return;
  }
  core.info(
    `Pre-flight: App permissions verified (${Object.keys(auth.permissions).length} granted, ` +
      `installation ${auth.installationId}).`,
  );
  const token = auth.token;

  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const configPath = join(workspace, CONFIG_FILE);

  if (!existsSync(configPath)) {
    core.warning(
      `${CONFIG_FILE} not found at repository root — pr-conductor exits cleanly without doing anything.`,
    );
    core.setOutput("managed_branch", "false");
    return;
  }

  const yamlText = await readFile(configPath, "utf8");
  const result = loadConfig(yamlText);

  for (const notice of result.notices) core.notice(notice);
  for (const warning of result.warnings) core.warning(warning);

  if (result.config === null) {
    for (const error of result.errors) core.error(error);
    core.setFailed(
      `${CONFIG_FILE} is invalid (${result.errors.length} error${result.errors.length === 1 ? "" : "s"}).`,
    );
    core.setOutput("managed_branch", "false");
    return;
  }

  const config = result.config;
  const gh = createGitHubClient(token);
  const log = {
    info: (msg: string) => core.info(msg),
    warning: (msg: string) => core.warning(msg),
  };

  if (event === "pull_request") {
    const pr = readPullRequestFromContext();
    if (!pr) {
      core.warning("pull_request event invoked but no pull_request payload found — skipping.");
      core.setOutput("managed_branch", "false");
      return;
    }
    await runPrFlow({ pr, config, gh, log });
    core.setOutput("managed_branch", "false");
    return;
  }

  if (event === "push") {
    const branchRef = github.context.ref.replace(/^refs\/heads\//, "");

    // Reusable workflow push.yml invokes scripts/sanitize-release-mentions.sh
    // and scripts/back-merge.sh after this step. Adopters call that workflow
    // from a thin caller, so `actions/checkout` populates the working
    // directory with the *adopter's* repo — not flywheel's — and a bare
    // `bash scripts/<name>.sh` exits 127. Export an absolute path back to
    // the action's own scripts/ directory so the workflow can call them
    // without relying on the caller's checkout. See #134.
    //
    // `process.argv[1]` is the absolute path the runner invoked the bundle
    // with (`/home/runner/work/_actions/.../dist/index.cjs` on hosted
    // runners). We can't use `import.meta.url` here because esbuild bundles
    // to CJS and leaves `import.meta` empty in that format; `__dirname`
    // would work in the CJS bundle but isn't available in the TS source
    // (NodeNext + `type: module`). `argv[1]` sidesteps both constraints.
    const bundlePath = process.argv[1];
    if (bundlePath) {
      core.setOutput("scripts_dir", resolve(dirname(bundlePath), "..", "scripts"));
    }

    // Sync rulesets when .flywheel.yml changed on a stream branch — keeps
    // the managed-branches ruleset's include array aligned with the config
    // as adopters add/remove streams or branches. Long-lived stream branches
    // depend on the ruleset's {type: deletion} rule to survive merges that
    // target them; without sync, new branches added to .flywheel.yml are
    // unprotected. See #60.
    if (
      findStreamForBranch(config, branchRef) &&
      pushTouchedConfig(github.context.payload, CONFIG_FILE)
    ) {
      try {
        await syncRulesets({ api: gh.rulesets, config, log });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        core.warning(`ruleset sync failed (continuing): ${msg}`);
      }
    }

    const outcome = await runPushFlow({
      branchRef,
      config,
      workspace,
      log: { info: (msg) => core.info(msg) },
    });
    core.setOutput("managed_branch", outcome.kind === "release" ? "true" : "false");
    core.setOutput("back_merge_targets", getUpstreamBranches(config, branchRef).join(","));

    // Promotion PR upsert is independent of the release flow per spec §Event chain.
    await runPromotion({
      branchRef,
      config,
      gh,
      log,
    });
    return;
  }

  core.setFailed(`Unknown event input: ${event}. Expected 'pull_request' or 'push'.`);
}

function pushTouchedConfig(payload: unknown, configFile: string): boolean {
  const commits = (payload as { commits?: Array<{ added?: string[]; modified?: string[]; removed?: string[] }> } | null)?.commits;
  if (!commits || commits.length === 0) return false;
  for (const c of commits) {
    if (c.added?.includes(configFile)) return true;
    if (c.modified?.includes(configFile)) return true;
    if (c.removed?.includes(configFile)) return true;
  }
  return false;
}

function readPullRequestFromContext(): PullRequest | null {
  const payload = github.context.payload;
  const pr = payload.pull_request as
    | {
        number: number;
        title: string;
        body: string | null;
        base: { ref: string };
        head: { ref: string; sha: string };
        node_id: string;
        labels: Array<{ name: string }>;
        draft: boolean;
      }
    | undefined;
  if (!pr) return null;
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body,
    baseRef: pr.base.ref,
    headRef: pr.head.ref,
    headSha: pr.head.sha,
    nodeId: pr.node_id,
    labels: (pr.labels ?? []).map((l) => l.name),
    draft: Boolean(pr.draft),
  };
}

run().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  if (stack) core.error(stack);
  core.setFailed(message);
});
