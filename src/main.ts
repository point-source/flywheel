import * as core from "@actions/core";
import * as github from "@actions/github";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { mintInstallationToken } from "./auth.js";
import { loadConfig } from "./config.js";
import {
  createGitHubClient,
  postDegradedTitleCheck,
  FLYWHEEL_TITLE_CHECK,
  type PullRequest,
} from "./github.js";
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
  const githubToken = core.getInput("github-token");

  const ctx = github.context;
  const owner = ctx.repo.owner;
  const repo = ctx.repo.repo;

  // Empty-key (degraded) path. GitHub sources secrets from the Dependabot
  // store on a Dependabot-triggered run (and withholds them on fork PRs), so
  // app-private-key arrives empty and no App installation token can be minted.
  // The old behaviour ("skip entirely") permanently deadlocked Dependabot PRs:
  // apply-rulesets.sh makes flywheel/conventional-commit a REQUIRED check, so a
  // PR whose check is never posted sits at `Expected` forever and can never
  // merge (#243). Instead, on a pull_request run we post that check from the
  // workflow's BUILT-IN GITHUB_TOKEN — never an App token — reflecting the
  // title verdict, and run no App-only action (no rewrite, no labels, no native
  // auto-merge, no promotion-PR upsert). The PR is made mergeable, not merged.
  // Fork PRs share this seam but are out of scope (#162): their built-in token
  // is read-only, so the post degrades gracefully to a logged warning. See SPEC
  // §spec:dependabot-degraded-check.
  if (!privateKey || privateKey.trim() === "") {
    if (event === "pull_request") {
      const pr = readPullRequestFromContext();
      if (pr) {
        if (!githubToken || githubToken.trim() === "") {
          core.notice(
            "Flywheel: app-private-key is empty and no built-in GITHUB_TOKEN " +
              "is available, so the flywheel/conventional-commit check could not " +
              "be posted. Skipping the conductor — no App-only action runs without " +
              "the key.",
          );
        } else {
          const gh = createGitHubClient(githubToken);
          const result = await postDegradedTitleCheck(
            gh,
            { title: pr.title, headSha: pr.headSha },
            { info: (m) => core.info(m), warning: (m) => core.warning(m) },
          );
          if (result.posted) {
            core.notice(
              `Flywheel: app-private-key is empty — this is expected for a ` +
                `Dependabot PR (GitHub sources secrets from the Dependabot store, ` +
                `not the Actions store). Posted the required ${FLYWHEEL_TITLE_CHECK} ` +
                `check with conclusion "${result.conclusion}" using the built-in ` +
                `token, so the PR is no longer deadlocked. App-only actions ` +
                `(title rewrite, auto-merge/needs-review labels, native auto-merge, ` +
                `promotion-PR upserts) were skipped. Register ` +
                `FLYWHEEL_GH_APP_PRIVATE_KEY in the Dependabot secret store to ` +
                `enable the full Flywheel flow for Dependabot PRs.`,
            );
          } else {
            core.notice(
              `Flywheel: app-private-key is empty and the built-in token is ` +
                `read-only, so the ${FLYWHEEL_TITLE_CHECK} check could not be posted ` +
                `(expected for fork PRs — see #162). App-only actions were skipped.`,
            );
          }
        }
        core.setOutput("managed_branch", "false");
        return;
      }
    }
    core.notice(
      "Flywheel: app-private-key is empty and no pull_request payload is " +
        "available, so there is no required check to post. Skipping the " +
        "conductor — no App-only action runs without the key.",
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
