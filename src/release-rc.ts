import type { Branch, FlywheelConfig, Stream } from "./types.js";

export interface SemanticReleaseBranch {
  name: string;
  prerelease?: string;
  channel?: string;
}

export interface ReleaseRc {
  tagFormat: string;
  branches: SemanticReleaseBranch[];
  plugins: unknown[];
}

const DEFAULT_PLUGINS: unknown[] = [
  "@semantic-release/commit-analyzer",
  "@semantic-release/release-notes-generator",
  "@semantic-release/changelog",
  // Loaded but no-op when adopters don't reference it. Available so a
  // committed .releaserc.json (see push-flow's leave-alone-if-committed
  // path) can use @semantic-release/exec for prepareCmd-style version-file
  // updates without forking flywheel-push.yml.
  "@semantic-release/exec",
  ["@semantic-release/git", { assets: ["CHANGELOG.md"] }],
  "@semantic-release/github",
];

export function generateReleaseRc(
  targetStream: Stream,
  config: FlywheelConfig,
): ReleaseRc {
  const tagFormat = chooseTagFormat(targetStream, config.streams);
  const releasingBranches = targetStream.branches.filter((b) => b.release !== "none");
  const branches = releasingBranches
    .map((b) => mapBranch(b, releasingBranches.length === 1))
    .filter((b): b is SemanticReleaseBranch => b !== null);
  return { tagFormat, branches, plugins: [...DEFAULT_PLUGINS] };
}

export function chooseTagFormat(target: Stream, allStreams: Stream[]): string {
  const primary = pickPrimaryStream(allStreams);
  return target.name === primary.name ? "v${version}" : `${target.name}/v\${version}`;
}

function pickPrimaryStream(allStreams: Stream[]): Stream {
  const withProductionTerminal = allStreams.filter(isProductionTerminal);
  if (withProductionTerminal.length === 1) return withProductionTerminal[0]!;
  // Zero such streams (validation already errors on >1): fall back to first declared.
  return allStreams[0]!;
}

function isProductionTerminal(stream: Stream): boolean {
  const last = stream.branches[stream.branches.length - 1];
  return Boolean(last) && last!.release === "production";
}

function mapBranch(branch: Branch, isOnlyBranchInStream: boolean): SemanticReleaseBranch | null {
  if (branch.release === "none") return null;

  if (isOnlyBranchInStream && branch.release === "prerelease") {
    // Single-branch stream with prerelease identifier: per spec §Single-branch streams,
    // treat as a regular release branch — the suffix is captured by the scoped
    // tagFormat, not semantic-release's prerelease flag (which would otherwise
    // throw ERELEASEBRANCHES).
    return { name: branch.name };
  }

  if (branch.release === "prerelease") {
    const id = branch.suffix!;
    return { name: branch.name, prerelease: id, channel: id };
  }

  return { name: branch.name };
}
