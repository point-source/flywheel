import * as core from "@actions/core";
import * as github from "@actions/github";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { mintInstallationToken } from "./auth.js";
import { loadConfig } from "./config.js";
import { createGitHubClient, type GitHubClient, type PullRequest } from "./github.js";
import { runPrFlow, runPrChecksOnly } from "./pr-flow.js";
import { getUpstreamBranches, runPushFlow, findStreamForBranch } from "./push-flow.js";
import { runPromotion } from "./promotion.js";
import { syncRulesets } from "./rulesets.js";
import { findMissingPermissions, formatMissingPermissionsError } from "./preflight.js";

const CONFIG_FILE = ".flywheel.yml";

async function run(): Promise<void> {
  const event = core.getInput("event", { required: true });
  const appId = core.getInput("app-id", { required: true });
  const privateKey = core.getInput("app-private-key");
  const githubToken = core.getInput("github-token");

  const ctx = github.context;
  const owner = ctx.repo.owner;
  const repo = ctx.repo.repo;

  // No-App-token path: app-private-key arrives empty. This happens for fork
  // PRs (GitHub doesn't pass repo secrets to fork PR workflows) and for
  // Dependabot-triggered runs (GitHub serves those the *Dependabot* secret
  // store, not the Actions store, so the Actions-registered App key is
  // invisible). Without a key we can't mint an installation token, so the
  // App-only conductor steps — title rewrite, auto-merge labels, promotion
  // PR upserts — can't run.
  //
  // But the `flywheel/conventional-commit` check is title/skip-ci validation
  // that needs no App privileges, and apply-rulesets.sh requires it by
  // default. Skipping it outright leaves the PR deadlocked at "Expected —
  // Waiting for status" (#243, #162). So on PR events we post that check
  // best-effort with the workflow's own GITHUB_TOKEN (needs `checks: write`,
  // which the flywheel-pr.yml template grants). For Dependabot the
  // permissions key elevates the token, so this succeeds; for genuine fork
  // PRs the token is read-only and the post 403s — runDegradedPrCheck
  // swallows that, and such PRs still need a manual bypass.
  if (!privateKey || privateKey.trim() === "") {
    core.notice(
      "Flywheel: app-private-key is empty. This is expected for fork PRs and " +
        "for Dependabot PRs (GitHub serves Dependabot runs the Dependabot secret " +
        "store, not the Actions store). Skipping the App-only steps — title " +
        "rewrite, auto-merge labels, and promotion PR upserts will not run on " +
        "this PR. The flywheel/conventional-commit check, which apply-rulesets.sh " +
        "requires by default, is posted with the workflow GITHUB_TOKEN where it " +
        "has checks:write (e.g. Dependabot PRs) so a required check does not " +
        "deadlock the PR. To restore the full conductor on Dependabot PRs, also " +
        "register FLYWHEEL_GH_APP_PRIVATE_KEY as a Dependabot secret. Fork PRs get " +
        "a read-only token and may still need a manual merge.",
    );
    core.setOutput("managed_branch", "false");
    if (event === "pull_request") {
      await runDegradedPrCheck(githubToken, owner, repo);
    }
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

/**
 * Degraded PR handling when no App installation token is available (empty
 * app-private-key). Posts only the `flywheel/conventional-commit` check using
 * the workflow's own GITHUB_TOKEN so a required check doesn't deadlock fork /
 * Dependabot PRs. App-only steps stay skipped — see the empty-key branch in
 * run(). Strictly best-effort: never setFailed (a failed job is itself a
 * required-check block), and a read-only fork-PR token that 403s on the
 * check post is logged, not fatal.
 */
async function runDegradedPrCheck(githubToken: string, owner: string, repo: string): Promise<void> {
  if (!githubToken || githubToken.trim() === "") {
    core.notice(
      "Flywheel: no GITHUB_TOKEN available to post the conventional-commit check — skipping. " +
        "Grant the workflow `permissions: checks: write` so it can post on fork/Dependabot PRs.",
    );
    return;
  }

  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const configPath = join(workspace, CONFIG_FILE);
  if (!existsSync(configPath)) {
    core.warning(`${CONFIG_FILE} not found at repository root — nothing to validate.`);
    return;
  }

  const result = loadConfig(await readFile(configPath, "utf8"));
  if (result.config === null) {
    // Don't setFailed here: in degraded mode a failing job would itself block
    // the PR, which is the deadlock we're trying to avoid. A separate
    // App-token run surfaces config errors loudly.
    core.warning(`${CONFIG_FILE} is invalid — skipping the degraded conventional-commit check.`);
    return;
  }

  const pr = readPullRequestFromContext();
  if (!pr) {
    core.warning("pull_request event invoked but no pull_request payload found — skipping.");
    return;
  }

  const gh: GitHubClient = createGitHubClient(githubToken, `${owner}/${repo}`);
  const log = {
    info: (msg: string) => core.info(msg),
    warning: (msg: string) => core.warning(msg),
  };

  try {
    await runPrChecksOnly({ pr, config: result.config, gh, log });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    core.notice(
      `Flywheel: could not post the conventional-commit check with GITHUB_TOKEN (${msg}). ` +
        "This is expected on fork PRs, whose token is read-only and cannot be granted checks:write. " +
        "The PR may need a manual merge or a re-trigger by a human actor.",
    );
  }
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
