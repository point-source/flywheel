import * as github from "@actions/github";

import { createGitHubClient, type GitHubClient } from "../../../src/github.js";

export const SANDBOX_OWNER = "point-source";
export const SANDBOX_REPO = "flywheel-sandbox";
export const SANDBOX_REPO_FULL = `${SANDBOX_OWNER}/${SANDBOX_REPO}`;
export const INTEGRATION_BASE = "integration-test-base";

/**
 * Auth model: in CI, the integration workflow mints a short-lived
 * installation token from the `flywheel-build-e2e` GitHub App via
 * actions/create-github-app-token and exports it as SANDBOX_GH_TOKEN.
 * Locally, set SANDBOX_GH_TOKEN to any token (PAT or App installation
 * token) with PR/contents/issues read+write on point-source/flywheel-sandbox.
 */
export const sandboxToken: string | undefined = process.env.SANDBOX_GH_TOKEN;
export const hasSandboxToken = typeof sandboxToken === "string" && sandboxToken.length > 0;

let cachedGh: GitHubClient | null = null;
let cachedOctokit: ReturnType<typeof github.getOctokit> | null = null;

export function sandboxGh(): GitHubClient {
  if (!hasSandboxToken) {
    throw new Error("SANDBOX_GH_TOKEN is not set; integration tests should be gated on hasSandboxToken.");
  }
  if (!cachedGh) cachedGh = createGitHubClient(sandboxToken!, SANDBOX_REPO_FULL);
  return cachedGh;
}

export function sandboxOctokit(): ReturnType<typeof github.getOctokit> {
  if (!hasSandboxToken) {
    throw new Error("SANDBOX_GH_TOKEN is not set; integration tests should be gated on hasSandboxToken.");
  }
  if (!cachedOctokit) cachedOctokit = github.getOctokit(sandboxToken!);
  return cachedOctokit;
}
