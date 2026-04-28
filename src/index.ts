import * as core from '@actions/core';
import { runPrLifecycle } from './commands/pr-lifecycle.js';
import { runPromote } from './commands/promote.js';

type Command = 'pr-lifecycle' | 'promote' | 'release' | 'render-pr-body' | 'hello-world';

const COMMANDS: readonly Command[] = [
  'pr-lifecycle',
  'promote',
  'release',
  'render-pr-body',
  'hello-world',
] as const;

function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

async function run(): Promise<void> {
  const command = core.getInput('command', { required: true });
  if (!isCommand(command)) {
    core.setFailed(
      `Unknown command: "${command}". Expected one of: ${COMMANDS.join(', ')}`,
    );
    return;
  }

  switch (command) {
    case 'hello-world':
      await helloWorld();
      return;
    case 'pr-lifecycle':
      await runPrLifecycle({
        appId: core.getInput('app_id', { required: true }),
        appPrivateKey: core.getInput('app_private_key', { required: true }),
        prNumber: parseInt(core.getInput('pr_number', { required: true }), 10),
        sourceBranch: core.getInput('source_branch', { required: true }),
        targetBranch: core.getInput('target_branch', { required: true }),
        dryRun: core.getBooleanInput('dry_run'),
        repo: requireRepo(),
      });
      return;
    case 'promote':
      await runPromote({
        appId: core.getInput('app_id', { required: true }),
        appPrivateKey: core.getInput('app_private_key', { required: true }),
        branch: requirePromoteBranch(core.getInput('branch', { required: true })),
        dryRun: core.getBooleanInput('dry_run'),
        repo: requireRepo(),
      });
      return;
    case 'release':
    case 'render-pr-body':
      core.setFailed(`Command "${command}" is not yet implemented`);
      return;
  }
}

function requireRepo(): string {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('GITHUB_REPOSITORY env var is required');
  return repo;
}

function requirePromoteBranch(value: string): 'develop' | 'staging' {
  if (value === 'develop' || value === 'staging') return value;
  throw new Error(`promote: 'branch' must be 'develop' or 'staging', got '${value}'`);
}

async function helloWorld(): Promise<void> {
  const repo = process.env.GITHUB_REPOSITORY ?? '<unknown>';
  const sha = process.env.GITHUB_SHA ?? '<unknown>';
  const actionRef = process.env.GITHUB_ACTION_REF ?? '<local>';
  const actionRepo = process.env.GITHUB_ACTION_REPOSITORY ?? '<local>';
  core.info(`hello from swarmflow`);
  core.info(`  caller repo: ${repo}@${sha}`);
  core.info(`  action source: ${actionRepo}@${actionRef}`);
  core.setOutput('greeting', `hello from ${actionRepo || 'local'}@${actionRef || 'local'}`);
}

export { isCommand, run, COMMANDS };
export type { Command };
