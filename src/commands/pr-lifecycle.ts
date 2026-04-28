import * as core from '@actions/core';
import { loadConfig } from '../core/config.js';
import { parseCommitsStrict, computeBump, isAutoMergeable, type Commit } from '../core/commits.js';
import { selectTitleCommit, formatTitle } from '../core/pr-title.js';
import { renderFeatureBody, type QualityStatus } from '../core/pr-body.js';
import { isMergeQueueEnabled } from '../core/merge-queue.js';
import { enableAutoMergeOrEnqueue, type MergeStrategy } from '../core/auto-merge.js';
import { dispatchWorkflow, pollRunOnBranch } from '../core/workflow-dispatch.js';
import { mintAppToken } from '../github/app-token.js';
import { getOctokit, type Octokit } from '../github/octokit.js';

export interface PrLifecycleAuthedInputs {
  prNumber: number;
  sourceBranch: string;
  targetBranch: string;
  dryRun: boolean;
  /** Repository in `owner/name` form (from $GITHUB_REPOSITORY). */
  repo: string;
}

export interface PrLifecycleInputs extends PrLifecycleAuthedInputs {
  appId: string;
  appPrivateKey: string;
}

/**
 * Action entry point: mint an App token, then run the lifecycle. Tests use
 * `runPrLifecycleWithOctokit` directly to skip the auth bootstrap.
 */
export async function runPrLifecycle(inputs: PrLifecycleInputs): Promise<void> {
  const [owner, repo] = parseOwnerRepo(inputs.repo);
  const token = await mintAppToken({
    appId: inputs.appId,
    privateKey: inputs.appPrivateKey,
    owner,
    repo,
  });
  const octokit = getOctokit(token);
  const config = loadConfig();
  await runPrLifecycleWithOctokit(octokit, config, inputs);
}

/**
 * Run the full PR-lifecycle pipeline against a pre-built Octokit client.
 * Exposed for unit testing — tests inject a mocked Octokit.
 *
 * Sequence: parse commits → render PR title/body → dispatch + wait for
 * quality → re-render with outcome → auto-merge or post "ready for review".
 *
 * Throws if quality fails or commits are non-conventional. The
 * render-pr-body standalone command runs as an `if: always()` safety net in
 * the workflow, so even on throw the PR body reflects the final state.
 */
export async function runPrLifecycleWithOctokit(
  octokit: Octokit,
  config: ReturnType<typeof loadConfig>,
  inputs: PrLifecycleAuthedInputs,
): Promise<void> {
  const [owner, repo] = parseOwnerRepo(inputs.repo);

  // Fetch the PR's commits via the GitHub API (avoids needing git log).
  const commits = await fetchPrCommits(octokit, owner, repo, inputs.prNumber);

  // Strict parse — the required check turns red if any commit is malformed.
  const parsed = parseCommitsStrict(commits);
  const bump = computeBump(parsed);
  const eligible = isAutoMergeable(parsed, config.pipeline.auto_merge_types);

  // Render initial title + body. Quality status is "pending" if a quality
  // workflow is configured, otherwise undefined (line is omitted).
  const titleCommit = selectTitleCommit(parsed);
  if (!titleCommit) {
    throw new Error(`PR #${inputs.prNumber} has no parsed commits`);
  }
  const title = formatTitle(titleCommit);
  const qualityConfigured = config.pipeline.workflows.quality !== '';
  const initialQuality: QualityStatus = qualityConfigured ? 'pending' : undefined;
  const initialBody = renderFeatureBody({
    commits: parsed,
    bump,
    target: inputs.targetBranch,
    quality: initialQuality,
  });
  await updatePr(octokit, owner, repo, inputs.prNumber, title, initialBody);

  // Auto-merge first, BEFORE dispatching quality. Two reasons:
  //   1. enablePullRequestAutoMerge refuses with "Pull request is in
  //      unstable status" when the PR has pending/in-progress checks. The
  //      quality dispatch and our own pr-lifecycle check would put the PR
  //      in that state, creating a chicken-and-egg deadlock.
  //   2. GitHub's auto-merge natively waits for REQUIRED checks (including
  //      quality, when configured as a required check via branch protection
  //      per docs/RULESETS.md). We don't need to gate it ourselves.
  //
  // The quality dispatch + body re-render still happens below for adopter
  // visibility (learning #5). If quality fails, we throw at the end so the
  // run surfaces the failure; auto-merge stays enabled and waits for the
  // required check, but never fires until quality is green on a future push.
  if (eligible) {
    const useQueue = await isMergeQueueEnabled({
      octokit,
      owner,
      repo,
      branch: inputs.targetBranch,
      override: config.pipeline.merge_queue,
    });

    const prNodeId = await fetchPrNodeId(octokit, owner, repo, inputs.prNumber);
    const result = await enableAutoMergeOrEnqueue({
      octokit,
      owner,
      repo,
      prNumber: inputs.prNumber,
      prNodeId,
      useQueue,
      mergeStrategy: config.pipeline.merge_strategy as MergeStrategy,
      dryRun: inputs.dryRun,
    });
    core.info(`auto-merge result: ${result}`);

    if (result === 'not_allowed') {
      core.warning(
        'Auto-merge is disabled in this repository\'s settings. ' +
          'Enable "Allow auto-merge" under Settings → General (see docs/RULESETS.md §128). ' +
          'Falling back to a human-review comment.',
      );
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: inputs.prNumber,
        body:
          ':eyes: Ready for human review — auto-merge is disabled in repo settings. ' +
          'Enable "Allow auto-merge" under Settings → General to let the bot merge eligible PRs.',
      });
    }
  } else {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: inputs.prNumber,
      body: ':eyes: Ready for human review — change type requires approval before merge.',
    });
  }

  // Quality workflow: dispatch and wait, then re-render body with outcome.
  // This is purely for PR-body visibility — auto-merge is already set up
  // above and gated naturally by required-check rulesets.
  let finalQuality: QualityStatus = initialQuality;
  if (qualityConfigured) {
    finalQuality = await runQualityWorkflow({
      octokit,
      owner,
      repo,
      qualityWorkflow: config.pipeline.workflows.quality,
      sourceBranch: inputs.sourceBranch,
      prNumber: inputs.prNumber,
    });
    // Re-render body with the actual quality outcome (learning #5).
    const finalBody = renderFeatureBody({
      commits: parsed,
      bump,
      target: inputs.targetBranch,
      quality: finalQuality,
    });
    await updatePr(octokit, owner, repo, inputs.prNumber, title, finalBody);

    if (finalQuality === 'failed') {
      throw new Error('quality workflow failed; merge gated');
    }
  }
}

interface QualityWorkflowParams {
  octokit: Octokit;
  owner: string;
  repo: string;
  qualityWorkflow: string;
  sourceBranch: string;
  prNumber: number;
}

async function runQualityWorkflow(params: QualityWorkflowParams): Promise<QualityStatus> {
  // Resolve sourceBranch to a SHA for the quality workflow's `sha` input.
  // The branch tip is what we want — quality validates THIS PR's HEAD.
  const { data: branchData } = await params.octokit.rest.repos.getBranch({
    owner: params.owner,
    repo: params.repo,
    branch: params.sourceBranch,
  });
  const sha = branchData.commit.sha;

  await dispatchWorkflow({
    octokit: params.octokit,
    owner: params.owner,
    repo: params.repo,
    workflow: params.qualityWorkflow,
    ref: params.sourceBranch,
    inputs: {
      pr_number: String(params.prNumber),
      sha,
    },
  });

  const { conclusion } = await pollRunOnBranch({
    octokit: params.octokit,
    owner: params.owner,
    repo: params.repo,
    workflow: params.qualityWorkflow,
    branch: params.sourceBranch,
    appearTimeoutSeconds: 60,
  });

  return conclusion === 'success' ? 'passed' : 'failed';
}

async function fetchPrCommits(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<Commit[]> {
  const { data } = await octokit.rest.pulls.listCommits({
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });
  return data.map((c) => ({
    sha: c.sha,
    message: c.commit.message,
  }));
}

async function fetchPrNodeId(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<string> {
  const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  return data.node_id;
}

async function updatePr(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  title: string,
  body: string,
): Promise<void> {
  await octokit.rest.pulls.update({
    owner,
    repo,
    pull_number: prNumber,
    title,
    body,
  });
}

function parseOwnerRepo(repo: string): [string, string] {
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error(`invalid GITHUB_REPOSITORY: ${repo}`);
  return [owner, name];
}
