import * as core from '@actions/core';
import { type Config, nextBranchInChain } from '../core/config.js';
import { parseCommits, computeBump, type Commit } from '../core/commits.js';
import { computeVersion, type GitProvider } from '../core/version.js';
import { renderPromotionBody } from '../core/pr-body.js';
import { upsertPullRequest } from '../core/upsert-pr.js';
import { dispatchWorkflow } from '../core/workflow-dispatch.js';
import { mintAppToken } from '../github/app-token.js';
import { getOctokit, type Octokit } from '../github/octokit.js';
import { createCliGitProvider } from '../github/git.js';

export interface PromoteAuthedInputs {
  /** Branch we just pushed to. Only `develop`/`staging` invoke promote;
   * `main` triggers release.ts. */
  branch: 'develop' | 'staging';
  dryRun: boolean;
  /** `owner/name`, from $GITHUB_REPOSITORY. */
  repo: string;
}

export interface PromoteInputs extends PromoteAuthedInputs {
  appId: string;
  appPrivateKey: string;
}

/**
 * Action entry point: mint an App token, then run the promote pipeline.
 * Tests use `runPromoteWithOctokit` to skip the auth bootstrap.
 */
export async function runPromote(inputs: PromoteInputs): Promise<void> {
  const [owner, repo] = parseOwnerRepo(inputs.repo);
  const token = await mintAppToken({
    appId: inputs.appId,
    privateKey: inputs.appPrivateKey,
    owner,
    repo,
  });
  const octokit = getOctokit(token);
  // Local imports to keep top-level free of fs side-effects in tests.
  const { loadConfig } = await import('../core/config.js');
  const config = loadConfig();
  const git = createCliGitProvider();
  await runPromoteWithOctokit(octokit, config, git, inputs);
}

/**
 * Run the promote pipeline against a pre-built Octokit client.
 * Exposed for unit testing.
 *
 * Sequence: list commits since last release tag → compute bump and version →
 * tag the branch tip if hasChanges → dispatch build if `publish_on_<branch>`
 * → upsert promotion PR to next branch in chain.
 *
 * Learning #3 (chore-only push): if commits since the last tag are all
 * chore/style/test/refactor, `bump` is `none` and `hasChanges=false`. We
 * SKIP tag creation but STILL dispatch the build (when publish_on_*=true)
 * and STILL upsert the promotion PR. Build artifacts can be published
 * even when no version tag is cut (spec §440).
 */
export async function runPromoteWithOctokit(
  octokit: Octokit,
  config: Config,
  git: GitProvider,
  inputs: PromoteAuthedInputs,
): Promise<void> {
  const [owner, repo] = parseOwnerRepo(inputs.repo);
  const { branch } = inputs;

  const baseTag = await git.describeReachableReleaseTag();
  const rawCommits = await listCommitsSince(octokit, owner, repo, baseTag, branch);
  const commits = parseCommits(rawCommits);
  const bump = computeBump(commits);

  const computed = await computeVersion({
    branch,
    bump,
    initialVersion: config.initial_version,
    git,
  });

  if (computed.hasChanges) {
    if (!inputs.dryRun) {
      await tagBranchTip(octokit, owner, repo, branch, computed.version);
    }
    core.info(`tagged ${branch} as v${computed.version}`);
  } else {
    core.info(`chore-only push to ${branch} — no tag created (learning #3)`);
  }

  const shouldPublish =
    branch === 'develop' ? config.pipeline.publish_on_develop : config.pipeline.publish_on_staging;
  if (shouldPublish && !inputs.dryRun) {
    await dispatchWorkflow({
      octokit,
      owner,
      repo,
      workflow: config.pipeline.workflows.build,
      ref: branch,
      inputs: {
        version: computed.version,
        environment: branch,
        changelog: renderChangelogFragment(commits, computed.version),
        artifact_path: 'dist/',
      },
    });
    core.info(`build dispatched for ${branch} @ ${computed.version}`);
  }

  const nextBranch = nextBranchInChain(branch, config.pipeline.branches);
  if (nextBranch) {
    if (!inputs.dryRun) {
      const title = `chore(release): promote ${branch} → ${nextBranch} (v${computed.version})`;
      const body = renderPromotionBody({
        commits,
        bump,
        source: branch,
        target: nextBranch,
        version: computed.version,
      });
      const result = await upsertPullRequest({
        octokit,
        owner,
        repo,
        head: branch,
        base: nextBranch,
        title,
        body,
      });
      core.info(`promotion PR ${result.created ? 'created' : 'updated'}: #${result.number}`);
    }
  } else {
    core.info(`no downstream branch enabled — nothing to promote ${branch} into`);
  }
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
  // No release tag yet — list commits on the branch (capped at 100). For
  // greenfield repos this is fine; once a v* tag exists, compareCommits
  // takes over and the cap stops mattering.
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
): Promise<void> {
  const { data: branchData } = await octokit.rest.repos.getBranch({ owner, repo, branch });
  const sha = branchData.commit.sha;
  // Lightweight tag: just a ref pointing at the SHA. Annotated tags require
  // a separate `git.createTag` step; lightweight is sufficient for pre-release
  // build identifiers.
  await octokit.rest.git.createRef({
    owner,
    repo,
    ref: `refs/tags/v${version}`,
    sha,
  });
}

function renderChangelogFragment(
  commits: ReturnType<typeof parseCommits>,
  version: string,
): string {
  if (commits.length === 0) return `## v${version}\n\n_No changes._\n`;
  const lines = [`## v${version}`, ''];
  for (const c of commits) {
    if (!c.type) continue;
    const scope = c.scope ? `**${c.scope}:** ` : '';
    const breaking = c.breaking ? ' [⚠ BREAKING]' : '';
    lines.push(`- ${c.type}: ${scope}${c.bareMessage} (${c.sha.slice(0, 7)})${breaking}`);
  }
  return lines.join('\n') + '\n';
}

function parseOwnerRepo(repo: string): [string, string] {
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error(`invalid GITHUB_REPOSITORY: ${repo}`);
  return [owner, name];
}
