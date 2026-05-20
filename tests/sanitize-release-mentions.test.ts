import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// End-to-end exercise of scripts/sanitize-release-mentions.sh against a
// real local git repo and a stubbed `gh` CLI (PATH override that records
// every invocation and serves canned `release view` bodies). The inline
// form of this step halted the 1.1.1 release on a transient 404 race
// between semantic-release's tag push and the release-by-tag lookup —
// extracted in #130 with retry-with-backoff and these tests so the
// failure mode can't recur silently.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = join(repoRoot, "scripts/sanitize-release-mentions.sh");

interface Fixture {
  repo: string;
  ghStubBin: string;
  ghCallsLog: string;
  ghStateDir: string;
  cleanup: () => void;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** PATH-shadowing `gh` stub. Records argv to a log file (NUL-terminated
 * records, TAB-separated args within a record so newline-bearing args
 * — release body text — survive). Serves canned `release view` bodies
 * from $GH_STATE_DIR/body.txt and tracks attempt count in
 * $GH_STATE_DIR/attempts. If $GH_STATE_DIR/fail-attempts contains an
 * integer N, the first N `release view` calls exit non-zero (mimicking
 * the 404 race); subsequent calls return the body. */
function setupGhStub(): { binDir: string; callsLog: string; stateDir: string } {
  const binDir = mkdtempSync(join(tmpdir(), "flywheel-sanitize-bin-"));
  const stateDir = mkdtempSync(join(tmpdir(), "flywheel-sanitize-state-"));
  const callsLog = join(binDir, "gh-calls.log");
  const stub = `#!/usr/bin/env bash
{
  printf '%s' "$1"
  for arg in "\${@:2}"; do
    printf '\\t%s' "$arg"
  done
  printf '\\0'
} >> "${callsLog}"

state="${stateDir}"

case "$1 $2" in
  "release view")
    attempts_file="$state/attempts"
    fail_file="$state/fail-attempts"
    n=0
    if [[ -f "$attempts_file" ]]; then n="$(cat "$attempts_file")"; fi
    n=$((n + 1))
    printf '%s' "$n" > "$attempts_file"
    fail_n=0
    if [[ -f "$fail_file" ]]; then fail_n="$(cat "$fail_file")"; fi
    if (( n <= fail_n )); then
      echo "release not found (stub: failure $n/$fail_n)" >&2
      exit 1
    fi
    if [[ -f "$state/body.txt" ]]; then
      cat "$state/body.txt"
    fi
    ;;
  "release edit")
    # Capture the --notes argument to a separate file so the test can
    # assert on the exact rewritten body without parsing the TAB log.
    while [[ $# -gt 0 ]]; do
      if [[ "$1" == "--notes" ]]; then
        printf '%s' "$2" > "$state/last-edit-notes.txt"
        shift 2
      else
        shift
      fi
    done
    ;;
esac
exit 0
`;
  writeFileSync(join(binDir, "gh"), stub);
  chmodSync(join(binDir, "gh"), 0o755);
  return { binDir, callsLog, stateDir };
}

/** Real local git repo with a single commit. Optionally tags HEAD with
 * one or more tag names — `releaseTag` is the single-tag convenience
 * form; `releaseTags` is for cases where HEAD carries multiple tags
 * (e.g. the floating `v1` major sitting on top of `v1.2.3`, #174). */
function setupRepo(opts: {
  releaseTag?: string | null;
  releaseTags?: string[];
}): Fixture {
  const repo = mkdtempSync(join(tmpdir(), "flywheel-sanitize-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  git(repo, "config", "user.email", "test@test");
  git(repo, "config", "user.name", "test");
  writeFileSync(join(repo, "README.md"), "# repo\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  const tags = opts.releaseTags ?? (opts.releaseTag ? [opts.releaseTag] : []);
  for (const t of tags) git(repo, "tag", t);

  const { binDir: ghStubBin, callsLog: ghCallsLog, stateDir: ghStateDir } = setupGhStub();
  return {
    repo,
    ghStubBin,
    ghCallsLog,
    ghStateDir,
    cleanup: () => {
      rmSync(repo, { recursive: true, force: true });
      rmSync(ghStubBin, { recursive: true, force: true });
      rmSync(ghStateDir, { recursive: true, force: true });
    },
  };
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runSanitize(
  fx: Fixture,
  opts: {
    body?: string;
    failAttempts?: number;
    extraEnv?: Record<string, string>;
  } = {},
): RunResult {
  if (opts.body !== undefined) writeFileSync(join(fx.ghStateDir, "body.txt"), opts.body);
  if (opts.failAttempts !== undefined)
    writeFileSync(join(fx.ghStateDir, "fail-attempts"), String(opts.failAttempts));
  const r = spawnSync("bash", [scriptPath], {
    cwd: fx.repo,
    env: {
      ...process.env,
      PATH: `${fx.ghStubBin}:${process.env.PATH ?? ""}`,
      GITHUB_TOKEN: "stub-token",
      GITHUB_REPOSITORY: "test/test",
      GH_STATE_DIR: fx.ghStateDir,
      // Tests run with no real backoff so retry cases finish in <1s.
      SANITIZE_INITIAL_DELAY: "0",
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

function lastEditNotes(stateDir: string): string | null {
  const p = join(stateDir, "last-edit-notes.txt");
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

describe("sanitize-release-mentions.sh — integration", () => {
  it("exits 0 with notice when no tag points at HEAD", () => {
    const fx = setupRepo({ releaseTag: null });
    try {
      const r = runSanitize(fx);
      expect(r.exitCode, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/No tag at HEAD/);
      expect(ghCalls(fx.ghCallsLog)).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });

  it("skips the floating `v1` alias when both `v1` and `v1.2.3` point at HEAD (#174)", () => {
    // After release-major-tag.yml force-floats `v1` onto a stable
    // chore(release) commit, HEAD carries both tags and `git tag` sorts
    // `v1` first. The script must skip the floating alias and pick the
    // real release tag, otherwise `gh release view v1` 404s forever.
    const fx = setupRepo({ releaseTags: ["v1", "v1.2.3"] });
    try {
      const body = "Release notes with @someone in them.\n";
      const r = runSanitize(fx, { body });
      expect(r.exitCode, r.stderr).toBe(0);
      const views = ghCalls(fx.ghCallsLog).filter((l) => l.startsWith("release\tview"));
      // Every `release view` call must target the real tag, never `v1`.
      expect(views.length).toBeGreaterThan(0);
      for (const call of views) {
        expect(call).toContain("v1.2.3");
        expect(call.split("\t")).not.toContain("v1");
      }
    } finally {
      fx.cleanup();
    }
  });

  it("skips the floating `<stream>/v1` alias on a scoped-stream release", () => {
    // Scoped-stream variant of #174 — release-major-tag.sh derives
    // `stream/v1` from `stream/v1.2.3`, so the same collision happens
    // alphabetically.
    const fx = setupRepo({ releaseTags: ["stream/v1", "stream/v1.2.3"] });
    try {
      const body = "Notes\n";
      const r = runSanitize(fx, { body });
      expect(r.exitCode, r.stderr).toBe(0);
      const views = ghCalls(fx.ghCallsLog).filter((l) => l.startsWith("release\tview"));
      expect(views.length).toBeGreaterThan(0);
      for (const call of views) {
        expect(call).toContain("stream/v1.2.3");
        expect(call.split("\t")).not.toContain("stream/v1");
      }
    } finally {
      fx.cleanup();
    }
  });

  it("treats a lone floating `v1` (no `vX.Y.Z` at HEAD) as no release", () => {
    // Degenerate case — shouldn't happen in practice (release-major-tag
    // only floats when a real release tag exists) but the filter must
    // not pick `v1` as a release tag. Falls through to the no-tag path.
    const fx = setupRepo({ releaseTag: "v1" });
    try {
      const r = runSanitize(fx);
      expect(r.exitCode, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/No tag at HEAD/);
      expect(ghCalls(fx.ghCallsLog)).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });

  it("body without @-mentions: no edit call, exits 0", () => {
    const fx = setupRepo({ releaseTag: "v1.2.3" });
    try {
      const body = "## What's Changed\n\n- Plain text release notes, no mentions.\n";
      const r = runSanitize(fx, { body });
      expect(r.exitCode, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/No @-mentions to sanitize/);
      const calls = ghCalls(fx.ghCallsLog);
      expect(calls.some((l) => l.startsWith("release\tview"))).toBe(true);
      expect(calls.some((l) => l.startsWith("release\tedit"))).toBe(false);
      expect(lastEditNotes(fx.ghStateDir)).toBeNull();
    } finally {
      fx.cleanup();
    }
  });

  it("wraps @-mentions at the four documented boundaries (line-start, space, paren, bracket)", () => {
    const fx = setupRepo({ releaseTag: "v1.2.3" });
    try {
      // One @-mention at each boundary the comment block enumerates.
      const body =
        "@line-start at the very beginning.\n" +
        "Word then @after-space mid-line.\n" +
        "Wrapped (@after-paren) like a markdown link.\n" +
        "Bracket [@after-bracket] like a link's text.\n";
      const r = runSanitize(fx, { body });
      expect(r.exitCode, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/Sanitized @-mentions/);

      const sanitized = lastEditNotes(fx.ghStateDir);
      expect(sanitized).not.toBeNull();
      expect(sanitized).toContain("`@line-start`");
      expect(sanitized).toContain("`@after-space`");
      expect(sanitized).toContain("`@after-paren`");
      expect(sanitized).toContain("`@after-bracket`");
      // Bare (unwrapped) @ should not appear anywhere — every mention got coded.
      expect(sanitized).not.toMatch(/(^|[\s([])@[A-Za-z]/);
    } finally {
      fx.cleanup();
    }
  });

  it("leaves email-like `user@host` and already-coded `` `@x` `` alone", () => {
    const fx = setupRepo({ releaseTag: "v1.2.3" });
    try {
      // Mix of wrap-targets and known non-targets. The non-targets must
      // pass through unchanged; the wrap-target proves we still hit the
      // edit path so this isn't a no-op test.
      const body =
        "Contact me at user@example.com for issues.\n" +
        "The package `@scope/already-coded` is already inline-coded.\n" +
        "But @needs-wrap is not.\n";
      const r = runSanitize(fx, { body });
      expect(r.exitCode, r.stderr).toBe(0);
      const sanitized = lastEditNotes(fx.ghStateDir);
      expect(sanitized).not.toBeNull();
      // Email left alone — `user@example.com` not converted to a backticked form.
      expect(sanitized).toContain("user@example.com");
      expect(sanitized).not.toContain("user`@example.com`");
      // Already-coded mention not double-wrapped.
      expect(sanitized).toContain("`@scope/already-coded`");
      expect(sanitized).not.toContain("``@scope/already-coded``");
      // The genuine mention got wrapped.
      expect(sanitized).toContain("`@needs-wrap`");
    } finally {
      fx.cleanup();
    }
  });

  it("retries `gh release view` on transient failure (404 race) and succeeds", () => {
    const fx = setupRepo({ releaseTag: "v1.2.3" });
    try {
      // 1.1.1-shape race: the first two `release view` calls 404, then
      // the third resolves. Script should retry, not error out.
      const body = "Release notes mentioning @octocat once.\n";
      const r = runSanitize(fx, { body, failAttempts: 2 });
      expect(r.exitCode, r.stderr).toBe(0);
      // Notice for each failed attempt.
      expect(r.stdout).toMatch(/attempt 1\/5 failed/);
      expect(r.stdout).toMatch(/attempt 2\/5 failed/);
      expect(r.stdout).toMatch(/Sanitized @-mentions/);
      // Three total `release view` calls: two failed, one succeeded.
      const views = ghCalls(fx.ghCallsLog).filter((l) => l.startsWith("release\tview"));
      expect(views).toHaveLength(3);
      // And exactly one edit, with the wrapped mention.
      const edits = ghCalls(fx.ghCallsLog).filter((l) => l.startsWith("release\tedit"));
      expect(edits).toHaveLength(1);
      expect(lastEditNotes(fx.ghStateDir)).toContain("`@octocat`");
    } finally {
      fx.cleanup();
    }
  });

  it("exits non-zero when `gh release view` fails on every retry", () => {
    const fx = setupRepo({ releaseTag: "v1.2.3" });
    try {
      // Tighten attempts to 3 to keep the test fast and assert the loop
      // bound is honored.
      const r = runSanitize(fx, {
        body: "unused",
        failAttempts: 99,
        extraEnv: { SANITIZE_MAX_ATTEMPTS: "3" },
      });
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toMatch(/failed after 3 attempts/);
      const views = ghCalls(fx.ghCallsLog).filter((l) => l.startsWith("release\tview"));
      expect(views).toHaveLength(3);
      // No edit attempted on a failed view path.
      expect(ghCalls(fx.ghCallsLog).some((l) => l.startsWith("release\tedit"))).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  it("fails fast when required env vars are missing", () => {
    const fx = setupRepo({ releaseTag: "v1.2.3" });
    try {
      const r = spawnSync("bash", [scriptPath], {
        cwd: fx.repo,
        env: {
          PATH: `${fx.ghStubBin}:${process.env.PATH ?? ""}`,
          // GITHUB_TOKEN deliberately unset.
          GITHUB_REPOSITORY: "test/test",
        },
        encoding: "utf8",
      });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/GITHUB_TOKEN/);
    } finally {
      fx.cleanup();
    }
  });
});
