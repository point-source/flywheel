import * as core from '@actions/core';
import { type Config } from '../core/config.js';
import { parseCommits, computeBump, type Commit } from '../core/commits.js';
import { computeVersion, type GitProvider } from '../core/version.js';
import { renderChangelogFragment, prependFragment } from '../core/changelog.js';
import { dispatchWorkflow } from '../core/workflow-dispatch.js';
import { mintAppToken } from '../github/app-token.js';
import { getOctokit, type Octokit } from '../github/octokit.js';
import { createCliGitProvider } from '../github/git.js';

export interface ReleaseAuthedInputs {
  /** Always 'main' for release. Threaded through for symmetry with promote. */
  branch: 'main';
  dryRun: boolean;
  /** `owner/name`, from $GITHUB_REPOSITORY. */
  repo: string;
}

export interface ReleaseInputs extends ReleaseAuthedInputs {
  appId: string;
  appPrivateKey: string;
}

/**
 * Action entry point: mint an App token, then run the release pipeline.
 * Tests use `runReleaseWithOctokit` to skip the auth bootstrap.
 */
export async function runRelease(inputs: ReleaseInputs): Promise<void> {
  const [owner, repo] = parseOwnerRepo(inputs.repo);
  const token = await mintAppToken({
    appId: inputs.appId,
    privateKey: inputs.appPrivateKey,
    owner,
    repo,
  });
  const octokit = getOctokit(token);
  const { loadConfig } = await import('../core/config.js');
  const config = loadConfig();
  const git = createCliGitProvider();
  await runReleaseWithOctokit(octokit, config, git, inputs);
}

/**
 * Run the release pipeline against a pre-built Octokit client.
 *
 * Sequence (learning #11 ordering matters): list commits since last release
 * tag → compute bump and version → if hasChanges: render changelog →
 * **tag branch tip → create GitHub Release → commit CHANGELOG.md** →
 * dispatch build with environment=production. The CHANGELOG.md commit
 * comes LAST so a crash mid-flow leaves a tag + release as the recovery
 * point (re-running sees the tag and short-circuits). If the order were
 * reversed, a crash after the file commit but before tagging would put
 * the repo in a confusing half-released state.
 *
 * Chore-only push: `bump=none` → `hasChanges=false` → log + return. No
 * tag, no release, no build. Per spec §440.
 */
export async function runReleaseWithOctokit(
  octokit: Octokit,
  config: Config,
  git: GitProvider,
  inputs: ReleaseAuthedInputs,
): Promise<void> {
  const [owner, repo] = parseOwnerRepo(inputs.repo);

  const baseTag = await git.describeReachableReleaseTag();
  const rawCommits = await listCommitsSince(octokit, owner, repo, baseTag, inputs.branch);
  const commits = parseCommits(rawCommits);
  const bump = computeBump(commits);

  const computed = await computeVersion({
    branch: inputs.branch,
    bump,
    initialVersion: config.initial_version,
    git,
  });

  if (!computed.hasChanges) {
    core.info(`chore-only push to main — no release cut`);
    return;
  }

  const previousVersion = baseTag ? baseTag.replace(/^v/, '') : undefined;
  const fragment = renderChangelogFragment({
    commits,
    version: computed.version,
    previousVersion,
    owner,
    repository: repo,
  });

  if (inputs.dryRun) {
    core.info(`[dry-run] would release v${computed.version}`);
    core.info(`[dry-run] changelog fragment:\n${fragment}`);
    return;
  }

  // 1. Tag the branch tip.
  const branchSha = await tagBranchTip(octokit, owner, repo, inputs.branch, computed.version);
  core.info(`tagged main as v${computed.version} @ ${branchSha}`);

  // 2. Create GitHub Release. This is the public publication point — once
  //    this exists, the version is "out". Subsequent steps are recoverable.
  await octokit.rest.repos.createRelease({
    owner,
    repo,
    tag_name: `v${computed.version}`,
    name: `v${computed.version}`,
    body: fragment,
    target_commitish: branchSha,
  });
  core.info(`created GitHub Release v${computed.version}`);

  // 3. Commit CHANGELOG.md update. Must come AFTER tag+release per learning
  //    #11 — recovery semantics depend on the tag being authoritative.
  await commitChangelogUpdate(octokit, owner, repo, inputs.branch, fragment, computed.version);
  core.info(`committed CHANGELOG.md update for v${computed.version}`);

  // 4. Dispatch the production build. The build workflow is responsible
  //    for triggering publish on completion (per spec §283).
  await dispatchWorkflow({
    octokit,
    owner,
    repo,
    workflow: config.pipeline.workflows.build,
    ref: inputs.branch,
    inputs: {
      version: computed.version,
      environment: 'production',
      changelog: fragment,
      artifact_path: 'dist/',
    },
  });
  core.info(`build dispatched for production @ v${computed.version}`);
}

async function listCommitsSince(
  octokit: Octokit,
  owner: string,
  repo: string,
  baseTag: string | null,
  branch: string,
): Promise<Commit[]> {
  if (baseTag) {
    const { data } = await octokit.rest.repos.compareCommits({
      owner,
      repo,
      base: baseTag,
      head: branch,
    });
    return data.commits.map((c) => ({ sha: c.sha, message: c.commit.message }));
  }
  const { data } = await octokit.rest.repos.listCommits({
    owner,
    repo,
    sha: branch,
    per_page: 100,
  });
  return data.map((c) => ({ sha: c.sha, message: c.commit.message }));
}

async function tagBranchTip(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  version: string,
): Promise<string> {
  const { data: branchData } = await octokit.rest.repos.getBranch({ owner, repo, branch });
  const sha = branchData.commit.sha;
  await octokit.rest.git.createRef({
    owner,
    repo,
    ref: `refs/tags/v${version}`,
    sha,
  });
  return sha;
}

async function commitChangelogUpdate(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  fragment: string,
  version: string,
): Promise<void> {
  let existingContent = '';
  let existingSha: string | undefined;
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: 'CHANGELOG.md',
      ref: branch,
    });
    if (Array.isArray(data) || data.type !== 'file') {
      throw new Error('CHANGELOG.md is unexpectedly a directory');
    }
    existingContent = Buffer.from(data.content, 'base64').toString('utf8');
    existingSha = data.sha;
  } catch (err) {
    // 404 = file doesn't exist yet; that's expected on first release.
    if ((err as { status?: number }).status !== 404) throw err;
  }

  const newContent = prependFragment(existingContent, fragment);
  await octokit.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: 'CHANGELOG.md',
    message: `chore(release): v${version}\n\n[skip ci]`,
    content: Buffer.from(newContent, 'utf8').toString('base64'),
    sha: existingSha,
    branch,
  });
}

function parseOwnerRepo(repo: string): [string, string] {
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error(`invalid GITHUB_REPOSITORY: ${repo}`);
  return [owner, name];
}
