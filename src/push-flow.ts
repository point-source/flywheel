import { execFile } from "node:child_process";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { FlywheelConfig, Stream } from "./types.js";
import {
  generateReleaseRc,
  serializeReleaseRc,
  usesBuildPlaceholder,
  RELEASE_CONFIG_FILENAME,
} from "./release-rc.js";

const execFileAsync = promisify(execFile);

// semantic-release (cosmiconfig) discovers these config filenames *before*
// RELEASE_CONFIG_FILENAME (`.releaserc.cjs`), so a committed copy of any of them
// would shadow the config flywheel generates. Flywheel owns the release config
// (adopters never configure semantic-release directly — §spec:release-notes-dedup),
// so we remove any of them from the workspace before writing the generated one.
// `.releaserc` (extensionless) and package.json also precede `.releaserc.cjs`,
// but they preceded the previous `.releaserc.json` too, so leaving them matches
// the prior authority contract rather than expanding it.
const SHADOWING_CONFIG_FILES = [
  ".releaserc.json",
  ".releaserc.yaml",
  ".releaserc.yml",
  ".releaserc.js",
];

export interface PushFlowDeps {
  branchRef: string;
  config: FlywheelConfig;
  workspace: string;
  log: PushLogger;
  writer?: (path: string, contents: string) => Promise<void>;
  remover?: (path: string) => Promise<void>;
  buildNumberProvider?: (workspace: string) => Promise<number>;
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

  const buildNumber = await maybeComputeBuildNumber(deps);
  const rc = generateReleaseRc(stream, deps.config, buildNumber, branch.name);
  const rcPath = join(deps.workspace, RELEASE_CONFIG_FILENAME);
  const writer = deps.writer ?? defaultWriter;
  const remover = deps.remover ?? defaultRemover;
  for (const name of SHADOWING_CONFIG_FILES) {
    await remover(join(deps.workspace, name));
  }
  await writer(rcPath, serializeReleaseRc(rc));

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

// Best-effort removal of a shadowing config file: a missing file is the common
// case (adopters rarely commit one) and is not an error.
async function defaultRemover(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

async function maybeComputeBuildNumber(deps: PushFlowDeps): Promise<number | undefined> {
  if (!deps.config.release_files || !usesBuildPlaceholder(deps.config.release_files)) {
    return undefined;
  }
  const provider = deps.buildNumberProvider ?? defaultBuildNumberProvider;
  return provider(deps.workspace);
}

// Counts both unscoped (`v*`) and stream-scoped (`<stream>/v*`) tags so
// multi-stream repos produce a monotonic build number across all streams.
// The 'v*' glob alone misses customer-acme/v1.2.3 and similar.
async function defaultBuildNumberProvider(workspace: string): Promise<number> {
  const { stdout } = await execFileAsync("git", ["tag", "--list", "v*", "*/v*"], {
    cwd: workspace,
  });
  const count = stdout.split("\n").filter((line) => line.length > 0).length;
  return count + 1;
}
