import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { FlywheelConfig, Stream } from "./types.js";
import { generateReleaseRc } from "./release-rc.js";

export interface PushFlowDeps {
  branchRef: string;
  config: FlywheelConfig;
  workspace: string;
  log: PushLogger;
  writer?: (path: string, contents: string) => Promise<void>;
}

export interface PushLogger {
  info(msg: string): void;
}

export type PushFlowOutcome =
  | { kind: "unmanaged"; reason: string }
  | { kind: "release"; stream: Stream; rcPath: string };

export async function runPushFlow(deps: PushFlowDeps): Promise<PushFlowOutcome> {
  const stream = findStreamForBranch(deps.config, deps.branchRef);
  if (!stream) {
    deps.log.info(
      `push: branch ${deps.branchRef} is not in any stream — release flow skipped.`,
    );
    return { kind: "unmanaged", reason: "branch-not-in-stream" };
  }

  const rc = generateReleaseRc(stream, deps.config);
  const rcPath = join(deps.workspace, ".releaserc.json");
  const writer = deps.writer ?? defaultWriter;
  await writer(rcPath, JSON.stringify(rc, null, 2));

  deps.log.info(
    `push: branch ${deps.branchRef} is in stream ${stream.name}; wrote ${rcPath}.`,
  );
  return { kind: "release", stream, rcPath };
}

export function findStreamForBranch(
  config: FlywheelConfig,
  branchRef: string,
): Stream | null {
  for (const stream of config.streams) {
    for (const branch of stream.branches) {
      if (branch.name === branchRef) return stream;
    }
  }
  return null;
}

async function defaultWriter(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, "utf8");
}
