import type {
  Branch,
  FlywheelConfig,
  ReleaseFile,
  Stream,
} from "./types.js";

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

const EXEC_PLUGIN = "@semantic-release/exec";
const GIT_PLUGIN = "@semantic-release/git";

const DEFAULT_PLUGINS: unknown[] = [
  "@semantic-release/commit-analyzer",
  "@semantic-release/release-notes-generator",
  "@semantic-release/changelog",
  // No-op when release_files is unset; replaced inline with a configured
  // [EXEC_PLUGIN, { prepareCmd }] entry when release_files declares any files.
  // Plugin position is load-bearing: prepareCmd must run before
  // @semantic-release/git commits the assets.
  EXEC_PLUGIN,
  [GIT_PLUGIN, { assets: ["CHANGELOG.md"] }],
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
  const plugins = buildPlugins(config.release_files);
  return { tagFormat, branches, plugins };
}

function buildPlugins(releaseFiles: ReleaseFile[] | undefined): unknown[] {
  if (!releaseFiles || releaseFiles.length === 0) {
    return [...DEFAULT_PLUGINS];
  }
  const prepareCmd = buildPrepareCmd(releaseFiles);
  const extraAssets = releaseFiles.map((f) => f.path);
  return DEFAULT_PLUGINS.map((entry) => {
    if (entry === EXEC_PLUGIN) {
      return [EXEC_PLUGIN, { prepareCmd }];
    }
    if (Array.isArray(entry) && entry[0] === GIT_PLUGIN) {
      const config = entry[1] as { assets: string[] };
      const merged = [...config.assets];
      for (const path of extraAssets) {
        if (!merged.includes(path)) merged.push(path);
      }
      return [GIT_PLUGIN, { assets: merged }];
    }
    return entry;
  });
}

// Build a single shell command that bumps every release_files entry.
// Single BUILD= prefix shared across entries; && chains so any failure aborts.
// semantic-release's @semantic-release/exec templates the string with Lodash
// at runtime — that's what expands ${nextRelease.version} and ${nextRelease.channel || ''}.
// $BUILD is a bash variable assigned inline; semantic-release passes it through
// untouched because it doesn't match Lodash's interpolate syntax.
function buildPrepareCmd(releaseFiles: ReleaseFile[]): string {
  const buildPrefix = "BUILD=$(( $(git tag --list 'v*' | wc -l) + 1 ))";
  const parts = releaseFiles.map(renderEntry);
  return [buildPrefix, ...parts].join(" && ");
}

function renderEntry(entry: ReleaseFile): string {
  if ("cmd" in entry) {
    return substitutePlaceholders(entry.cmd);
  }
  const replacement = substitutePlaceholders(entry.replacement);
  return (
    `sed -i.bak -E "s|${entry.pattern}|${replacement}|" ${entry.path}` +
    ` && rm ${entry.path}.bak`
  );
}

function substitutePlaceholders(input: string): string {
  return input
    .replace(/\$\{version\}/g, "${nextRelease.version}")
    .replace(/\$\{channel\}/g, "${nextRelease.channel || ''}")
    .replace(/\$\{build\}/g, "${BUILD}");
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
