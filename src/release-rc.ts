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
  ["@semantic-release/git", { assets: ["CHANGELOG.md"] }],
  "@semantic-release/github",
];

export function generateReleaseRc(
  targetStream: Stream,
  config: FlywheelConfig,
): ReleaseRc {
  const tagFormat = chooseTagFormat(targetStream, config.streams);
  const branches = targetStream.branches.map((b) =>
    mapBranch(b, targetStream.branches.length === 1),
  );
  const plugins = mergePlugins(config.semantic_release_plugins);
  return { tagFormat, branches, plugins };
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
  return Boolean(last) && (last!.prerelease === false || last!.prerelease === undefined);
}

function mapBranch(branch: Branch, isOnlyBranchInStream: boolean): SemanticReleaseBranch {
  const hasPrerelease =
    branch.prerelease !== undefined &&
    branch.prerelease !== false &&
    typeof branch.prerelease === "string";

  if (isOnlyBranchInStream && hasPrerelease) {
    // Single-branch stream with prerelease identifier: per spec §Single-branch streams,
    // treat as a regular release branch — the prerelease identifier is captured by the
    // scoped tagFormat, not semantic-release's prerelease flag (which would otherwise
    // throw ERELEASEBRANCHES).
    return { name: branch.name };
  }

  if (hasPrerelease) {
    const id = branch.prerelease as string;
    return { name: branch.name, prerelease: id, channel: id };
  }

  return { name: branch.name };
}

function mergePlugins(extra: unknown[] | undefined): unknown[] {
  if (!extra || extra.length === 0) return [...DEFAULT_PLUGINS];
  return [...DEFAULT_PLUGINS, ...extra];
}
