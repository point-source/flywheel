import * as core from "@actions/core";
import * as github from "@actions/github";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { mintInstallationToken } from "./auth.js";
import { loadConfig } from "./config.js";
import { createGitHubClient, type PullRequest } from "./github.js";
import { runPrFlow } from "./pr-flow.js";
import { getUpstreamBranches, runPushFlow } from "./push-flow.js";
import { runPromotion } from "./promotion.js";
import { findMissingPermissions, formatMissingPermissionsError } from "./preflight.js";

const CONFIG_FILE = ".flywheel.yml";

async function run(): Promise<void> {
  const event = core.getInput("event", { required: true });
  const appId = core.getInput("app-id", { required: true });
  const privateKey = core.getInput("app-private-key", { required: true });

  const ctx = github.context;
  const owner = ctx.repo.owner;
  const repo = ctx.repo.repo;

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
