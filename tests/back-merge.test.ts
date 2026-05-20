import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// End-to-end exercise of scripts/back-merge.sh against a real local git
// remote (`git init --bare`) and a stubbed `gh` CLI (PATH override that
// records every invocation). Three of the four production-halting back-
// merge bugs lived in this script's previous inline-YAML form with no
// pre-merge test coverage:
//
//   - #112: `git merge --no-ff` failure had no fallback; the step `exit 1`-
//     ed and the conflict surfaced on the next promotion days later.
//   - #119: `bash -c "... > \"$1\"" -- %A` driver string was eaten by the
//     outer `sh -c` git uses, so the driver never fired.
//   - #128: `'\''` apostrophe-escape was typo'd as `'\\''`, which closed
//     out of single-quoting in the middle of the printf body and exposed
//     `(#120)` to bash as a subshell open-paren — runtime syntax error
//     before any merge or fallback PR could open. `bash -n` did NOT catch
//     it (the error is inside `$(...)` command substitution).
//
// These tests cover all three failure shapes plus the happy paths.
//
// The merge-driver wiring itself (`flywheel-changelog`/`flywheel-release-
// file` + `.git/info/attributes`) lives in `tests/merge-driver.test.ts` —
// these tests register a stub driver inline so they don't depend on
// network access for `npx --yes conventional-changelog-cli@5`.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = join(repoRoot, "scripts/back-merge.sh");

interface Fixture {
  remote: string;
  clone: string;
  ghStubBin: string;
  ghCallsLog: string;
  cleanup: () => void;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** PATH-shadowing `gh` stub. Records argv to a log file; returns canned
 * responses for the two commands back-merge.sh calls.
 *
 * Each invocation is recorded as one record terminated by NUL (\0) so
 * args containing newlines (the heredoc'd PR body) don't split across
 * "lines". Within a record, args are TAB-separated. The test reads the
 * full file and splits on NUL. */
function setupGhStub(): { binDir: string; callsLog: string } {
  const binDir = mkdtempSync(join(tmpdir(), "flywheel-bm-bin-"));
  const callsLog = join(binDir, "gh-calls.log");
  const stub = `#!/usr/bin/env bash
{
  printf '%s' "$1"
  for arg in "\${@:2}"; do
    printf '\\t%s' "$arg"
  done
  printf '\\0'
} >> "${callsLog}"

case "$1 $2" in
  "pr list")
    if [[ -n "\${EXISTING_PR_NUMBER:-}" ]]; then
      printf '%s\\n' "\${EXISTING_PR_NUMBER}"
    fi
    ;;
  "pr create")
    printf 'https://github.com/test/test/pull/999\\n'
    ;;
esac
exit 0
`;
  writeFileSync(join(binDir, "gh"), stub);
  chmodSync(join(binDir, "gh"), 0o755);
  return { binDir, callsLog };
}

/** Bare local "remote" + a working clone with `main` and `develop`
 * branches at the requested CHANGELOG state. Optionally tags main's HEAD. */
function setupRepo(opts: {
  developChangelog: string;
  mainChangelog: string;
  /** If non-null, tag main's HEAD with this name. */
  releaseTag?: string | null;
  /** If set, tag main's HEAD with each of these names — used to exercise
   * the "floating major + real release tag at the same commit" case
   * (#174). Takes precedence over `releaseTag` when both are present. */
  releaseTags?: string[];
  /** If true, develop is set to a strict ancestor of main (ff-only succeeds). */
  developIsAncestor?: boolean;
  /** Extra file changes on develop only (creates non-CHANGELOG divergence). */
  developExtraFile?: { path: string; content: string };
  /** Extra file changes on main only (with the above, this creates a
   * non-CHANGELOG conflict that the merge driver doesn't cover). */
  mainExtraFile?: { path: string; content: string };
}): Fixture {
  const tagsToApply =
    opts.releaseTags ?? (opts.releaseTag ? [opts.releaseTag] : []);
  const remote = mkdtempSync(join(tmpdir(), "flywheel-bm-remote-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main"], { cwd: remote });

  const clone = mkdtempSync(join(tmpdir(), "flywheel-bm-clone-"));
  git(clone, "clone", "-q", remote, ".");
  git(clone, "config", "user.email", "test@test");
  git(clone, "config", "user.name", "test");

  // Initial commit on main with a baseline CHANGELOG/README.
  writeFileSync(join(clone, "README.md"), "# repo\n");
  writeFileSync(join(clone, "CHANGELOG.md"), "## [1.0.0]\n\nInitial.\n");
  git(clone, "add", ".");
  git(clone, "commit", "-q", "-m", "init");
  git(clone, "branch", "develop");

  if (opts.developIsAncestor) {
    // Move main forward; develop stays at the initial commit so ff-only
    // from develop merges main cleanly.
    writeFileSync(join(clone, "CHANGELOG.md"), opts.mainChangelog);
    git(clone, "commit", "-q", "-am", "main release");
    if (opts.mainExtraFile) {
      mkdirSync(dirname(join(clone, opts.mainExtraFile.path)), { recursive: true });
      writeFileSync(join(clone, opts.mainExtraFile.path), opts.mainExtraFile.content);
      git(clone, "add", opts.mainExtraFile.path);
      git(clone, "commit", "-q", "-m", `main: ${opts.mainExtraFile.path}`);
    }
    for (const t of tagsToApply) git(clone, "tag", t);
  } else {
    // Diverge: develop and main both edit CHANGELOG (and optional extras).
    git(clone, "checkout", "-q", "develop");
    writeFileSync(join(clone, "CHANGELOG.md"), opts.developChangelog);
    git(clone, "commit", "-q", "-am", "develop changes");
    if (opts.developExtraFile) {
      mkdirSync(dirname(join(clone, opts.developExtraFile.path)), { recursive: true });
      writeFileSync(join(clone, opts.developExtraFile.path), opts.developExtraFile.content);
      git(clone, "add", opts.developExtraFile.path);
      git(clone, "commit", "-q", "-m", `develop: ${opts.developExtraFile.path}`);
    }
    git(clone, "checkout", "-q", "main");
    writeFileSync(join(clone, "CHANGELOG.md"), opts.mainChangelog);
    git(clone, "commit", "-q", "-am", "main release");
    if (opts.mainExtraFile) {
      mkdirSync(dirname(join(clone, opts.mainExtraFile.path)), { recursive: true });
      writeFileSync(join(clone, opts.mainExtraFile.path), opts.mainExtraFile.content);
      git(clone, "add", opts.mainExtraFile.path);
      git(clone, "commit", "-q", "-m", `main: ${opts.mainExtraFile.path}`);
    }
    for (const t of tagsToApply) git(clone, "tag", t);
  }

  git(clone, "push", "-q", "origin", "main", "develop");
  for (const t of tagsToApply) git(clone, "push", "-q", "origin", t);

  const { binDir: ghStubBin, callsLog: ghCallsLog } = setupGhStub();
  return {
    remote,
    clone,
    ghStubBin,
    ghCallsLog,
    cleanup: () => {
      rmSync(remote, { recursive: true, force: true });
      rmSync(clone, { recursive: true, force: true });
      rmSync(ghStubBin, { recursive: true, force: true });
    },
  };
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runBackMerge(
  fx: Fixture,
  opts: {
    releasedBranch?: string;
    targets?: string;
    extraEnv?: Record<string, string>;
  } = {},
): RunResult {
  const r = spawnSync("bash", [scriptPath], {
    cwd: fx.clone,
    env: {
      ...process.env,
      PATH: `${fx.ghStubBin}:${process.env.PATH ?? ""}`,
      GITHUB_TOKEN: "stub-token",
      GITHUB_REPOSITORY: "test/test",
      RELEASED_BRANCH: opts.releasedBranch ?? "main",
      BACK_MERGE_TARGETS: opts.targets ?? "develop",
      ...(opts.extraEnv ?? {}),
    },
    encoding: "utf8",
  });
  return { exitCode: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function ghCalls(log: string): string[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").split("\0").filter(Boolean);
}

function remoteHead(remote: string, branch: string): string {
  return execFileSync("git", ["--git-dir", remote, "rev-parse", branch], {
    encoding: "utf8",
  }).trim();
}

function remoteHasMainAsAncestor(remote: string, branch: string): boolean {
  const r = spawnSync(
    "git",
    ["--git-dir", remote, "merge-base", "--is-ancestor", "main", branch],
    { encoding: "utf8" },
  );
  return r.status === 0;
}

describe("back-merge.sh — integration", () => {
  it("exits 0 with notice when no tag points at HEAD", () => {
    const fx = setupRepo({
      developChangelog: "## [1.0.1-dev.1]\nDev.\n",
      mainChangelog: "## [1.0.0]\nInitial.\n",
      releaseTag: null,
    });
    try {
      const r = runBackMerge(fx);
      expect(r.exitCode, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/No tag at HEAD/);
      expect(ghCalls(fx.ghCallsLog)).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });

  it("ff-only path: pushes upstream cleanly when develop is an ancestor of main", () => {
    const fx = setupRepo({
      developChangelog: "",
      mainChangelog: "## [1.1.0]\nRelease.\n## [1.0.0]\nInitial.\n",
      releaseTag: "v1.1.0",
      developIsAncestor: true,
    });
    try {
      const r = runBackMerge(fx);
      expect(r.exitCode, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/Fast-forwarded develop/);
      expect(remoteHead(fx.remote, "develop")).toBe(remoteHead(fx.remote, "main"));
      // No fallback PR.
      expect(ghCalls(fx.ghCallsLog).filter((l) => l.startsWith("pr\tcreate"))).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });

  it("skips the floating `v1` alias when both `v1` and `v1.1.0` point at HEAD (#174)", () => {
    // release-major-tag.yml force-floats `v1` onto every stable release
    // commit, so on a back-merge run after a release-major-tag pass,
    // HEAD carries both `v1` and the real release tag. Picking `v1`
    // would slug into branch names and commit messages as the wrong
    // tag. In the unexpected-conflict path that's what surfaces.
    const fx = setupRepo({
      developChangelog: "## [1.0.0]\nInitial.\n",
      mainChangelog: "## [1.0.0]\nInitial.\n",
      releaseTags: ["v1", "v1.1.0"],
      developExtraFile: { path: "src/foo.ts", content: "1" },
      mainExtraFile: { path: "src/foo.ts", content: "2" },
    });
    try {
      const r = runBackMerge(fx);
      expect(r.exitCode, r.stderr).toBe(0);
      // Group label and fallback PR head both encode new_tag — both must
      // pick v1.1.0, not the floating v1 alias.
      expect(r.stdout).toMatch(/Back-merge main \(v1\.1\.0\) → develop/);
      const create = ghCalls(fx.ghCallsLog).find((l) => l.startsWith("pr\tcreate"));
      expect(create, "fallback PR should be created").toBeDefined();
      expect(create).toMatch(/--head\tchore\/back-merge-v1\.1\.0-into-develop/);
      // Defensive: make sure the slug never collapses to the floating major.
      expect(create).not.toMatch(/--head\tchore\/back-merge-v1-into-develop/);
    } finally {
      fx.cleanup();
    }
  });

  it("no-ff path with merge driver: driver auto-resolves CHANGELOG, pushes cleanly", () => {
    const fx = setupRepo({
      developChangelog: "## [1.0.1-dev.1]\nDev.\n## [1.0.0]\nInitial.\n",
      mainChangelog: "## [1.1.0]\nRelease.\n## [1.0.0]\nInitial.\n",
      releaseTag: "v1.1.0",
    });
    try {
      // Register the driver wired the way push.yml's "Register Flywheel
      // merge drivers" step does — same single-layer `> "%A"` redirect,
      // stub command instead of `npx`.
      git(fx.clone, "config", "merge.flywheel-changelog.driver", 'echo MERGED-VIA-DRIVER > "%A"');
      mkdirSync(join(fx.clone, ".git/info"), { recursive: true });
      writeFileSync(
        join(fx.clone, ".git/info/attributes"),
        "CHANGELOG.md merge=flywheel-changelog\n",
      );

      const r = runBackMerge(fx);
      expect(r.exitCode, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/Auto-merged main into develop/);
      expect(remoteHasMainAsAncestor(fx.remote, "develop")).toBe(true);
      expect(ghCalls(fx.ghCallsLog).filter((l) => l.startsWith("pr\tcreate"))).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });

  it("fallback path: unexpected non-CHANGELOG conflict opens a review PR with `flywheel:needs-review`", () => {
    // The merge drivers cover CHANGELOG and release_files. A genuine
    // source-file divergence (e.g. both branches edit src/foo.ts) is what
    // the fallback PR exists to surface.
    const fx = setupRepo({
      developChangelog: "## [1.0.0]\nInitial.\n",
      mainChangelog: "## [1.0.0]\nInitial.\n",
      releaseTag: "v1.1.0",
      developExtraFile: { path: "src/foo.ts", content: "export const x = 1;\n" },
      mainExtraFile: { path: "src/foo.ts", content: "export const x = 2;\n" },
    });
    try {
      const r = runBackMerge(fx);
      // Script exits 0 — fallback PR is the recovery path, not an error.
      expect(r.exitCode, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/opening review PR/);

      const calls = ghCalls(fx.ghCallsLog);
      const create = calls.find((l) => l.startsWith("pr\tcreate"));
      expect(create, "fallback PR should be created").toBeDefined();
      // Verify the create call has the deterministic head-ref pr-flow's
      // isBackMergePR detection relies on (#120).
      expect(create).toMatch(/--head\tchore\/back-merge-v1\.1\.0-into-develop/);
      expect(create).toMatch(/--label\tflywheel:needs-review/);
      expect(create).toMatch(/--base\tdevelop/);

      // Body is rendered (no bash error truncating it). Check load-bearing
      // phrases survive — `Flywheel's` (apostrophe), `(#120)` (parens),
      // `"Create a merge commit"` (smart quotes from the original prose).
      expect(create).toMatch(/Flywheel's pr-flow/);
      expect(create).toMatch(/\(#120\)/);
      expect(create).toMatch(/Create a merge commit/);

      // Develop must NOT have advanced — fallback PR must be merged by a
      // human. Remote develop's tip is unchanged.
      const developHead = remoteHead(fx.remote, "develop");
      const mainHead = remoteHead(fx.remote, "main");
      expect(developHead).not.toBe(mainHead);
      expect(remoteHasMainAsAncestor(fx.remote, "develop")).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  it("idempotency: existing fallback PR for the same head/base is skipped, no duplicate create", () => {
    const fx = setupRepo({
      developChangelog: "## [1.0.0]\nInitial.\n",
      mainChangelog: "## [1.0.0]\nInitial.\n",
      releaseTag: "v1.1.0",
      developExtraFile: { path: "src/foo.ts", content: "1" },
      mainExtraFile: { path: "src/foo.ts", content: "2" },
    });
    try {
      const r = runBackMerge(fx, { extraEnv: { EXISTING_PR_NUMBER: "777" } });
      expect(r.exitCode, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/already open/);

      const calls = ghCalls(fx.ghCallsLog);
      // pr list happens (to check), pr create does NOT.
      expect(calls.some((l) => l.startsWith("pr\tlist"))).toBe(true);
      expect(calls.some((l) => l.startsWith("pr\tcreate"))).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  it("fails fast when required env vars are missing", () => {
    const fx = setupRepo({
      developChangelog: "",
      mainChangelog: "",
      releaseTag: "v1.1.0",
      developIsAncestor: true,
    });
    try {
      // Don't pass BACK_MERGE_TARGETS via extraEnv — but we have to undo
      // the default in runBackMerge. Easier path: hit the script directly.
      const r = spawnSync("bash", [scriptPath], {
        cwd: fx.clone,
        env: {
          PATH: `${fx.ghStubBin}:${process.env.PATH ?? ""}`,
          GITHUB_TOKEN: "stub",
          GITHUB_REPOSITORY: "test/test",
          RELEASED_BRANCH: "main",
          // BACK_MERGE_TARGETS deliberately unset.
        },
        encoding: "utf8",
      });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/BACK_MERGE_TARGETS/);
    } finally {
      fx.cleanup();
    }
  });

  it("regression #128: fallback PR body renders without bash errors (no `'\\''` typo)", () => {
    // The previous inline form had `'\\''` where `'\''` was needed. With
    // `'\\''` bash closed single-quoting in the middle of the printf
    // body, escaped a backslash, and re-opened — leaving `(#120)` exposed
    // as an unquoted subshell open-paren and erroring at runtime BEFORE
    // any merge or fallback PR could open. `bash -n` did not detect it
    // (error was inside `$(...)`). Guard the regression at the source
    // level: the script should not contain the broken pattern.
    const script = readFileSync(scriptPath, "utf8");
    // Specifically the broken `'\\''` form — the working `'\''` form has
    // 4 chars (close, escape `'`, reopen) and the broken form has 5.
    // We use heredoc for the body now, so neither pattern should appear
    // for the PR body. Fail loudly if the broken form ever returns.
    expect(script, "back-merge.sh must not regress to the broken `'\\\\''` escape form").not.toMatch(
      /'\\\\''/,
    );
  });
});
