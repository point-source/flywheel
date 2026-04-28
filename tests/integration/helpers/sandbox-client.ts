import * as github from "@actions/github";

import { createGitHubClient, type GitHubClient } from "../../../src/github.js";

export const SANDBOX_OWNER = "flywheel-ci";
export const SANDBOX_REPO = "flywheel-sandbox";
export const SANDBOX_REPO_FULL = `${SANDBOX_OWNER}/${SANDBOX_REPO}`;
export const INTEGRATION_BASE = "integration-test-base";

export const sandboxPat: string | undefined = process.env.SANDBOX_GH_PAT;
export const hasSandboxPat = typeof sandboxPat === "string" && sandboxPat.length > 0;

let cachedGh: GitHubClient | null = null;
let cachedOctokit: ReturnType<typeof github.getOctokit> | null = null;

export function sandboxGh(): GitHubClient {
  if (!hasSandboxPat) {
    throw new Error("SANDBOX_GH_PAT is not set; integration tests should be gated on hasSandboxPat.");
  }
  if (!cachedGh) cachedGh = createGitHubClient(sandboxPat!, SANDBOX_REPO_FULL);
  return cachedGh;
}

export function sandboxOctokit(): ReturnType<typeof github.getOctokit> {
  if (!hasSandboxPat) {
    throw new Error("SANDBOX_GH_PAT is not set; integration tests should be gated on hasSandboxPat.");
  }
  if (!cachedOctokit) cachedOctokit = github.getOctokit(sandboxPat!);
  return cachedOctokit;
}
