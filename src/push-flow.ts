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
  | { kind: "promote-only"; stream: Stream }
  | { kind: "release"; stream: Stream; rcPath: string };

export async function runPushFlow(deps: PushFlowDeps): Promise<PushFlowOutcome> {
  const stream = findStreamForBranch(deps.config, deps.branchRef);
  if (!stream) {
    deps.log.info(
      `push: branch ${deps.branchRef} is not in any stream — release flow skipped.`,
    );
    return { kind: "unmanaged", reason: "branch-not-in-stream" };
  }

  const branch = stream.branches.find((b) => b.name === deps.branchRef)!;
  if (branch.release === "none") {
    deps.log.info(
      `push: branch ${deps.branchRef} is in stream ${stream.name} but release: none — skipping semantic-release.`,
    );
    return { kind: "promote-only", stream };
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

// Branches earlier in the stream than `branchRef`. After a release lands on
// `branchRef`, the chore(release) commit + tag must be merged back into each
// upstream so semantic-release on those branches sees the tag in its ancestry
// and the CHANGELOG stays in sync.
export function getUpstreamBranches(
  config: FlywheelConfig,
  branchRef: string,
): string[] {
  const stream = findStreamForBranch(config, branchRef);
  if (!stream) return [];
  const idx = stream.branches.findIndex((b) => b.name === branchRef);
  if (idx <= 0) return [];
  return stream.branches.slice(0, idx).map((b) => b.name);
}

async function defaultWriter(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, "utf8");
}
