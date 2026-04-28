import * as core from "@actions/core";

async function run(): Promise<void> {
  const event = core.getInput("event", { required: true });
  core.info(`flywheel pr-conductor invoked with event=${event}`);
  core.setOutput("managed_branch", "false");
}

run().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  core.setFailed(message);
});
