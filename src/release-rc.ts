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
const GITHUB_PLUGIN = "@semantic-release/github";

const DEFAULT_PLUGINS: unknown[] = [
  "@semantic-release/commit-analyzer",
  "@semantic-release/release-notes-generator",
  "@semantic-release/changelog",
  // No-op when release_files is unset; replaced inline with a configured
  // [EXEC_PLUGIN, { prepareCmd }] entry when release_files declares any files.
  // Plugin position is load-bearing: prepareCmd must run before
  // @semantic-release/git commits the assets.
  EXEC_PLUGIN,
  // `message` overrides the plugin's default, which appends `[skip ci]` to the
  // chore(release) commit. We don't want that token: GitHub Actions treats
  // `[skip ci]` as a workflow-level commit-message filter, which leaves
  // required status checks in `Pending` forever on any PR whose head is the
  // release commit (e.g. promotion PRs tracking a stream's source branch).
  // Job-level `if:` in adopter quality workflows is the correct way to skip
  // work on these commits — a job-level skip reports `success` to the
  // required-checks rule. See:
  // https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks#handling-skipped-but-required-checks
  //
  // Related cutover gotcha (not addressed here): `[skip ci]` in *any*
  // bundled commit's title — e.g. legacy release commits from a pre-Flywheel
  // flow — propagates into the next promotion PR's squash-merge body under
  // GitHub's default `squash_merge_commit_message: COMMIT_MESSAGES` setting,
  // silently suppressing every workflow on the target branch. Documented in
  // docs/adopter/setup.md §0.4.
  [
    GIT_PLUGIN,
    {
      assets: ["CHANGELOG.md"],
      message: "chore(release): ${nextRelease.version}\n\n${nextRelease.notes}",
    },
  ],
  GITHUB_PLUGIN,
];

export function generateReleaseRc(
  targetStream: Stream,
  config: FlywheelConfig,
  buildNumber?: number,
  targetBranchName?: string,
): ReleaseRc {
  const tagFormat = chooseTagFormat(targetStream, config.streams);
  const releasingBranches = targetStream.branches.filter((b) => b.release !== "none");
  const branches = releasingBranches
    .map((b) => mapBranch(b, releasingBranches.length === 1))
    .filter((b): b is SemanticReleaseBranch => b !== null);
  // release_as_draft is per-branch (SPEC §spec:immutable-release-support):
  // semantic-release runs once per push on one specific branch, so the
  // .releaserc.json this generates is targeted at exactly that branch — we
  // look up release_as_draft on the named branch only and pass
  // { draftRelease: true } to @semantic-release/github for that release.
  // When targetBranchName is unspecified (e.g. existing unit-test callers
  // that pre-date this signature), no branch is opted in.
  const targetBranch = targetBranchName
    ? targetStream.branches.find((b) => b.name === targetBranchName)
    : undefined;
  const releaseAsDraft = targetBranch?.release_as_draft ?? false;
  const plugins = buildPlugins(config.release_files, buildNumber, releaseAsDraft);
  return { tagFormat, branches, plugins };
}

// True if any release_files entry references the ${build} placeholder.
// Callers use this to decide whether they need to supply a buildNumber
// (computing one is a git shell-out, so we skip it when unused).
export function usesBuildPlaceholder(releaseFiles: ReleaseFile[]): boolean {
  return releaseFiles.some((entry) =>
    "cmd" in entry
      ? entry.cmd.includes("${build}")
      : entry.replacement.includes("${build}"),
  );
}

function buildPlugins(
  releaseFiles: ReleaseFile[] | undefined,
  buildNumber: number | undefined,
  releaseAsDraft: boolean,
): unknown[] {
  // Apply the github draft transform first so subsequent release_files
  // transforms iterate over a single shape. `draftRelease: true` is the one
  // option flywheel passes to @semantic-release/github; the plugin
  // otherwise runs with its defaults (release notes, success comments, no
  // assets uploaded — flywheel never attaches release assets itself). The
  // `releaseAsDraft` flag is the per-branch value resolved by the caller;
  // see generateReleaseRc. SPEC §spec:immutable-release-support.
  const plugins: unknown[] = DEFAULT_PLUGINS.map((entry) =>
    entry === GITHUB_PLUGIN && releaseAsDraft
      ? [GITHUB_PLUGIN, { draftRelease: true }]
      : entry,
  );
  if (!releaseFiles || releaseFiles.length === 0) {
    return plugins;
  }
  const prepareCmd = buildPrepareCmd(releaseFiles, buildNumber);
  const extraAssets = releaseFiles.map((f) => f.path);
  return plugins.map((entry) => {
    if (entry === EXEC_PLUGIN) {
      return [EXEC_PLUGIN, { prepareCmd }];
    }
    if (Array.isArray(entry) && entry[0] === GIT_PLUGIN) {
      const config = entry[1] as { assets: string[]; message: string };
      const merged = [...config.assets];
      for (const path of extraAssets) {
        if (!merged.includes(path)) merged.push(path);
      }
      return [GIT_PLUGIN, { ...config, assets: merged }];
    }
    return entry;
  });
}

// Build a single shell command that bumps every release_files entry,
// &&-chained so any failure aborts. semantic-release's @semantic-release/exec
// templates the string with Lodash at runtime — that's what expands
// ${nextRelease.version} and ${nextRelease.channel || ''}. ${build} is
// resolved here in JS to a literal integer, not at shell runtime: Lodash's
// hardcoded ES-template pass would ReferenceError on any ${BUILD}-style
// placeholder regardless of templateSettings (see issue #95).
function buildPrepareCmd(
  releaseFiles: ReleaseFile[],
  buildNumber: number | undefined,
): string {
  return releaseFiles.map((e) => renderEntry(e, buildNumber)).join(" && ");
}

function renderEntry(entry: ReleaseFile, buildNumber: number | undefined): string {
  if ("cmd" in entry) {
    // Freeform escape hatch: run verbatim after placeholder substitution.
    // Shell safety is the adopter's responsibility for this form.
    return substitutePlaceholders(entry.cmd, buildNumber);
  }
  // Declarative form: emit a sed `s|…|…|` invocation that is shell-safe by
  // construction. The sed program is single-quoted so the shell leaves $, `,
  // \, and " in the pattern/replacement literal; the path is single-quoted so
  // spaces and metacharacters are literal. The ${nextRelease.*} Lodash tokens
  // still expand because @semantic-release/exec runs Lodash before the shell.
  const pattern = escapeForSingleQuotedShell(entry.pattern);
  // Escape sed-replacement metacharacters (\ and &) and the shell single quote
  // on the user's literal text *before* substituting placeholders: the
  // injected `${nextRelease.channel || ''}` token contains a ' that must reach
  // Lodash unescaped, so it must not pass through escapeForSingleQuotedShell.
  let replacement = escapeSedReplacement(entry.replacement);
  replacement = escapeForSingleQuotedShell(replacement);
  replacement = substitutePlaceholders(replacement, buildNumber);
  return (
    `sed -i.bak -E 's|${pattern}|${replacement}|' ${singleQuote(entry.path)}` +
    ` && rm ${singleQuote(entry.path + ".bak")}`
  );
}

// Escape a string for embedding inside a single-quoted shell context: close
// the quote, emit an escaped quote, reopen. Safe for any byte except a newline
// (rejected at config validation, since a sed `s` command must be one line).
function escapeForSingleQuotedShell(s: string): string {
  return s.replace(/'/g, "'\\''");
}

// Wrap a string as a complete single-quoted shell argument.
function singleQuote(s: string): string {
  return `'${escapeForSingleQuotedShell(s)}'`;
}

// Escape the metacharacters of a sed `s` command's replacement half so the
// text is substituted literally: `\` is the escape character and `&` expands
// to the whole match. The `|` delimiter is rejected at config validation.
function escapeSedReplacement(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/&/g, "\\&");
}

function substitutePlaceholders(
  input: string,
  buildNumber: number | undefined,
): string {
  const withVersionAndChannel = input
    .replace(/\$\{version\}/g, "${nextRelease.version}")
    .replace(/\$\{channel\}/g, "${nextRelease.channel || ''}");
  if (!withVersionAndChannel.includes("${build}")) return withVersionAndChannel;
  if (buildNumber === undefined) {
    throw new Error(
      "release_files uses ${build} placeholder but no buildNumber was provided to generateReleaseRc",
    );
  }
  return withVersionAndChannel.replace(/\$\{build\}/g, String(buildNumber));
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
