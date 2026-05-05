import * as github from "@actions/github";

export interface PullRequest {
  number: number;
  title: string;
  body: string | null;
  baseRef: string;
  headRef: string;
  headSha: string;
  nodeId: string;
  labels: string[];
  draft: boolean;
}

export interface Commit {
  sha: string;
  message: string;
  title: string;
  body: string;
  /** ISO 8601 commit date as reported by GitHub (committer.date). */
  committerDate: string;
}

export interface PRSummary {
  number: number;
  nodeId: string;
  title: string;
  body: string | null;
}

export type EnableAutoMergeResult =
  | { ok: true }
  | { ok: false; reason: string };

export type MergeResult =
  | { ok: true; sha: string }
  | { ok: false; reason: string; status?: number };

export type MergeMethod = "SQUASH" | "REBASE" | "MERGE";

export interface CreateCheckOptions {
  name: string;
  conclusion: "success" | "failure" | "neutral";
  summary: string;
  details?: string;
  headSha: string;
}

export interface GitHubClient {
  readonly owner: string;
  readonly repo: string;

  updatePR(number: number, fields: { title?: string; body?: string }): Promise<void>;
  addLabels(number: number, labels: string[]): Promise<void>;
  removeLabel(number: number, label: string): Promise<void>;

  enableAutoMerge(
    prNodeId: string,
    method: MergeMethod,
  ): Promise<EnableAutoMergeResult>;
  disableAutoMerge(prNodeId: string): Promise<void>;
  mergePR(prNumber: number, method: MergeMethod): Promise<MergeResult>;

  listPullCommits(prNumber: number): Promise<Commit[]>;
  listBranchCommits(branch: string, perPage?: number): Promise<Commit[]>;

  listOpenPRs(opts: { head: string; base: string }): Promise<PRSummary[]>;
  createPR(opts: { title: string; body: string; head: string; base: string }): Promise<PRSummary>;

  createCheck(opts: CreateCheckOptions): Promise<void>;
}

export function createGitHubClient(token: string, repoFullName?: string): GitHubClient {
  const octokit = github.getOctokit(token);
  const ctx = github.context;
  const [owner, repo] = (repoFullName ?? `${ctx.repo.owner}/${ctx.repo.repo}`).split("/");
  if (!owner || !repo) {
    throw new Error(`Could not determine repo owner/name (got ${repoFullName ?? "context"}).`);
  }

  const splitMessage = (message: string) => {
    const idx = message.indexOf("\n");
    if (idx === -1) return { title: message, body: "" };
    return { title: message.slice(0, idx), body: message.slice(idx + 1).replace(/^\n+/, "") };
  };

  return {
    owner,
    repo,

    async updatePR(pull_number, fields) {
      await octokit.rest.pulls.update({
        owner,
        repo,
        pull_number,
        ...(fields.title !== undefined ? { title: fields.title } : {}),
        ...(fields.body !== undefined ? { body: fields.body } : {}),
      });
    },

    async addLabels(issue_number, labels) {
      if (labels.length === 0) return;
      await octokit.rest.issues.addLabels({ owner, repo, issue_number, labels });
    },

    async removeLabel(issue_number, name) {
      try {
        await octokit.rest.issues.removeLabel({ owner, repo, issue_number, name });
      } catch (err: unknown) {
        // Treat 404 (label not present) as success.
        const status = (err as { status?: number } | undefined)?.status;
        if (status !== 404) throw err;
      }
    },

    async enableAutoMerge(pullRequestId, mergeMethod) {
      try {
        // The variable is named `mergeMethod` (not `method`) because
        // @octokit/graphql reserves `method`, `url`, `headers`,
        // `mediaType`, and `request` for the underlying HTTP request
        // config. Passing one of those as a GraphQL variable throws
        // `"<name>" cannot be used as variable name`.
        await octokit.graphql(
          `mutation Enable($id: ID!, $mergeMethod: PullRequestMergeMethod!) {
            enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $mergeMethod }) {
              pullRequest { id }
            }
          }`,
          { id: pullRequestId, mergeMethod },
        );
        return { ok: true };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, reason: message };
      }
    },

    async disableAutoMerge(pullRequestId) {
      try {
        await octokit.graphql(
          `mutation Disable($id: ID!) {
            disablePullRequestAutoMerge(input: { pullRequestId: $id }) {
              pullRequest { id }
            }
          }`,
          { id: pullRequestId },
        );
      } catch {
        // Idempotent: ignore "not enabled" errors.
      }
    },

    async mergePR(pull_number, method) {
      try {
        const res = await octokit.rest.pulls.merge({
          owner,
          repo,
          pull_number,
          merge_method: method.toLowerCase() as "squash" | "rebase" | "merge",
        });
        return { ok: true, sha: res.data.sha };
      } catch (err: unknown) {
        const status = (err as { status?: number } | undefined)?.status;
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, reason: message, ...(status !== undefined ? { status } : {}) };
      }
    },

    async listPullCommits(pull_number) {
      const all = await octokit.paginate(octokit.rest.pulls.listCommits, {
        owner,
        repo,
        pull_number,
        per_page: 100,
      });
      return all.map((c) => {
        const message = c.commit.message;
        const { title, body } = splitMessage(message);
        return {
          sha: c.sha,
          message,
          title,
          body,
          committerDate: c.commit.committer?.date ?? c.commit.author?.date ?? new Date(0).toISOString(),
        };
      });
    },

    async listBranchCommits(branch, perPage = 100) {
      const all = await octokit.rest.repos.listCommits({
        owner,
        repo,
        sha: branch,
        per_page: perPage,
      });
      return all.data.map((c) => {
        const message = c.commit.message;
        const { title, body } = splitMessage(message);
        return {
          sha: c.sha,
          message,
          title,
          body,
          committerDate: c.commit.committer?.date ?? c.commit.author?.date ?? new Date(0).toISOString(),
        };
      });
    },

    async listOpenPRs({ head, base }) {
      const fullHead = head.includes(":") ? head : `${owner}:${head}`;
      const data = await octokit.paginate(octokit.rest.pulls.list, {
        owner,
        repo,
        state: "open",
        head: fullHead,
        base,
        per_page: 100,
      });
      return data.map((p) => ({
        number: p.number,
        nodeId: p.node_id,
        title: p.title,
        body: p.body ?? null,
      }));
    },

    async createPR({ title, body, head, base }) {
      const res = await octokit.rest.pulls.create({ owner, repo, title, body, head, base });
      return {
        number: res.data.number,
        nodeId: res.data.node_id,
        title: res.data.title,
        body: res.data.body ?? null,
      };
    },

    async createCheck({ name, conclusion, summary, details, headSha }) {
      await octokit.rest.checks.create({
        owner,
        repo,
        name,
        head_sha: headSha,
        status: "completed",
        conclusion,
        output: {
          title: name,
          summary,
          ...(details ? { text: details } : {}),
        },
      });
    },
  };
}

export const FLYWHEEL_AUTO_MERGE_LABEL = "flywheel:auto-merge";
export const FLYWHEEL_NEEDS_REVIEW_LABEL = "flywheel:needs-review";
