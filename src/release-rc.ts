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
const RELEASE_NOTES_PLUGIN = "@semantic-release/release-notes-generator";

// Filename flywheel writes the generated semantic-release config to. It is a
// CommonJS module (`.cjs`), not `.releaserc.json`, because the release-notes
// generator needs a `writerOpts.finalizeContext` *function* to scope and
// de-duplicate the `closes` list (§spec:release-notes-dedup) — and a function
// cannot survive JSON serialization. cosmiconfig discovers `.releaserc.cjs`;
// push-flow removes any higher-precedence `.releaserc.{json,yaml,yml,js}` in the
// workspace so a committed copy can never shadow the generated one.
export const RELEASE_CONFIG_FILENAME = ".releaserc.cjs";

// Sentinel placeholder for the finalizeContext function inside the generated
// plugin options. generateReleaseRc emits a JSON-shaped object (so the rest of
// the config stays plain data and stays unit-testable); serializeReleaseRc then
// swaps this quoted string for the bare `finalizeContext` identifier defined at
// the top of the emitted module. It must be a value no real config would carry.
const FINALIZE_CONTEXT_SENTINEL = "__FLYWHEEL_FINALIZE_CONTEXT__";

// Source of the finalizeContext hook, emitted verbatim into the generated
// `.releaserc.cjs`. conventional-changelog's stock behavior renders every
// `#`-token a commit mentions after `closes` — bare `(#N)` PR suffixes, prose
// `#tokens`, and repeats — because its parser tags non-closing references with
// `action: null` and the writer renders them all (§spec:release-notes-dedup).
// This post-processes the grouped writer context to keep only references a
// closing keyword introduced (`action` set) and to collapse duplicates by full
// issue identity (owner, repository, number), so the rendered `closes` list
// carries each closed issue at most once and no non-issue links. It is
// self-contained (no imports) so it serializes to a standalone module. The PR's
// own number still renders inline on its commit line — this only prunes the
// `closes` list, losing no navigability.
const FINALIZE_CONTEXT_SOURCE = `const finalizeContext = (context) => {
  const seen = new Set();
  for (const group of context.commitGroups || []) {
    for (const commit of group.commits || []) {
      if (!Array.isArray(commit.references)) continue;
      commit.references = commit.references.filter((ref) => {
        if (!ref.action) return false;
        const key = JSON.stringify([ref.owner || "", ref.repository || "", ref.issue]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
  }
  return context;
};`;

const DEFAULT_PLUGINS: unknown[] = [
  "@semantic-release/commit-analyzer",
  // Configured, not bare: the writerOpts.finalizeContext hook (serialized from
  // FINALIZE_CONTEXT_SOURCE) scopes the `closes` list to genuine closing
  // references and de-duplicates by issue identity. §spec:release-notes-dedup.
  [RELEASE_NOTES_PLUGIN, { writerOpts: { finalizeContext: FINALIZE_CONTEXT_SENTINEL } }],
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
  // .releaserc.cjs this generates is targeted at exactly that branch — we
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

// Serialize a ReleaseRc to the text of the generated `.releaserc.cjs` module.
// The config is JSON-shaped except for the finalizeContext sentinel, so we
// JSON-stringify it and then splice in the real function: the module defines
// `finalizeContext` up top (from FINALIZE_CONTEXT_SOURCE) and the sentinel's
// quoted string is replaced by that bare identifier. semantic-release loads the
// result via cosmiconfig exactly as it would a `.releaserc.json`.
export function serializeReleaseRc(rc: ReleaseRc): string {
  const json = JSON.stringify(rc, null, 2);
  const target = JSON.stringify(FINALIZE_CONTEXT_SENTINEL);
  // The sentinel is always present (plugins carry it) and must be unique: a
  // blind first-occurrence replace would corrupt an adopter field that happened
  // to equal the reserved token and silently drop the dedup hook. Exactly one
  // occurrence guarantees we replace the real sentinel; anything else is a bug
  // or a config collision, so fail loudly rather than emit a broken config.
  const occurrences = json.split(target).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `release config serialization expected exactly one finalizeContext sentinel but found ${occurrences} — ` +
        `a .flywheel.yml value collides with the reserved token ${FINALIZE_CONTEXT_SENTINEL}`,
    );
  }
  const body = json.replace(target, "finalizeContext");
  return (
    `// Generated by flywheel from .flywheel.yml — do not edit.\n` +
    `// Regenerated on every push; a committed copy is overwritten.\n` +
    `${FINALIZE_CONTEXT_SOURCE}\n\n` +
    `module.exports = ${body};\n`
  );
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
