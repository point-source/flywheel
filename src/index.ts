import * as core from '@actions/core';

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
    case 'promote':
    case 'release':
    case 'render-pr-body':
      core.setFailed(`Command "${command}" is not yet implemented`);
      return;
  }
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
