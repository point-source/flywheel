import { SANDBOX_OWNER, SANDBOX_REPO, sandboxOctokit } from "../../integration/helpers/sandbox-client.js";

export interface PushFile {
  path: string;
  content: string;
}

export interface PRMergeState {
  state: "open" | "closed";
  merged: boolean;
  mergedAt: string | null;
  mergeableState: string | null;
}

export interface CheckRunSummary {
  name: string;
  conclusion: string | null;
  status: string;
  detailsUrl: string | null;
}

export async function getRefSha(branch: string): Promise<string> {
  const octokit = sandboxOctokit();
  const res = await octokit.rest.git.getRef({
    owner: SANDBOX_OWNER,
    repo: SANDBOX_REPO,
    ref: `heads/${branch}`,
  });
  return res.data.object.sha;
}

export async function pushCommit(
  branch: string,
  opts: { message: string; files: PushFile[] },
): Promise<string> {
  const octokit = sandboxOctokit();

  const refRes = await octokit.rest.git.getRef({
    owner: SANDBOX_OWNER,
    repo: SANDBOX_REPO,
    ref: `heads/${branch}`,
  });
  const parentSha = refRes.data.object.sha;

  const parentCommit = await octokit.rest.git.getCommit({
    owner: SANDBOX_OWNER,
    repo: SANDBOX_REPO,
    commit_sha: parentSha,
  });

  const tree = await octokit.rest.git.createTree({
    owner: SANDBOX_OWNER,
    repo: SANDBOX_REPO,
    base_tree: parentCommit.data.tree.sha,
    tree: opts.files.map((f) => ({
      path: f.path,
      mode: "100644",
      type: "blob",
      content: f.content,
    })),
  });

  const commit = await octokit.rest.git.createCommit({
    owner: SANDBOX_OWNER,
    repo: SANDBOX_REPO,
    message: opts.message,
    tree: tree.data.sha,
    parents: [parentSha],
  });

  await octokit.rest.git.updateRef({
    owner: SANDBOX_OWNER,
    repo: SANDBOX_REPO,
    ref: `heads/${branch}`,
    sha: commit.data.sha,
  });

  return commit.data.sha;
}

export async function mergePR(
  prNumber: number,
  method: "squash" | "merge" | "rebase" = "squash",
): Promise<string> {
  const octokit = sandboxOctokit();
  const res = await octokit.rest.pulls.merge({
    owner: SANDBOX_OWNER,
    repo: SANDBOX_REPO,
    pull_number: prNumber,
    merge_method: method,
  });
  return res.data.sha;
}

export async function getPRMergeState(prNumber: number): Promise<PRMergeState> {
  const octokit = sandboxOctokit();
  const res = await octokit.rest.pulls.get({
    owner: SANDBOX_OWNER,
    repo: SANDBOX_REPO,
    pull_number: prNumber,
  });
  return {
    state: res.data.state as "open" | "closed",
    merged: res.data.merged === true,
    mergedAt: res.data.merged_at ?? null,
    mergeableState: res.data.mergeable_state ?? null,
  };
}

export async function getCheckRuns(headSha: string, name: string): Promise<CheckRunSummary[]> {
  const octokit = sandboxOctokit();
  const res = await octokit.rest.checks.listForRef({
    owner: SANDBOX_OWNER,
    repo: SANDBOX_REPO,
    ref: headSha,
    check_name: name,
    per_page: 100,
  });
  return res.data.check_runs.map((c) => ({
    name: c.name,
    conclusion: c.conclusion ?? null,
    status: c.status,
    detailsUrl: c.details_url ?? null,
  }));
}

export interface TagSummary {
  name: string;
  sha: string;
}

export async function listTagsMatching(prefix: string): Promise<TagSummary[]> {
  const octokit = sandboxOctokit();
  // listMatchingRefs takes the partial ref ("tags/<prefix>") and returns refs that start with it.
  const refs = await octokit.paginate(octokit.rest.git.listMatchingRefs, {
    owner: SANDBOX_OWNER,
    repo: SANDBOX_REPO,
    ref: `tags/${prefix}`,
    per_page: 100,
  });
  return refs.map((r) => ({
    name: r.ref.replace(/^refs\/tags\//, ""),
    sha: r.object.sha,
  }));
}

export async function deleteTag(name: string): Promise<void> {
  const octokit = sandboxOctokit();
  try {
    await octokit.rest.git.deleteRef({
      owner: SANDBOX_OWNER,
      repo: SANDBOX_REPO,
      ref: `tags/${name}`,
    });
  } catch (err) {
    const status = (err as { status?: number } | undefined)?.status;
    if (status !== 404 && status !== 422) throw err;
  }
}

export async function getRepoFile(branch: string, path: string): Promise<string> {
  const octokit = sandboxOctokit();
  const res = await octokit.rest.repos.getContent({
    owner: SANDBOX_OWNER,
    repo: SANDBOX_REPO,
    path,
    ref: branch,
  });
  if (Array.isArray(res.data) || res.data.type !== "file") {
    throw new Error(`getRepoFile: ${path}@${branch} is not a file`);
  }
  if (typeof res.data.content !== "string") {
    throw new Error(`getRepoFile: ${path}@${branch} returned no content`);
  }
  return Buffer.from(res.data.content, res.data.encoding as BufferEncoding).toString("utf8");
}
