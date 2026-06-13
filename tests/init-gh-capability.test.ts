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

import { stripAnsi } from "./helpers/ansi.js";

// End-to-end exercise of scripts/init.sh's gh-capability pre-flight detector
// (preflight_detect_gh_capability, SPEC.md §spec:preflight-gh-capability). The
// detector runs at the seam inside preflight_run — BEFORE any prompt, REPO
// resolution, or file write — and is gated by preflight_gate. It probes gh's
// install + auth state (read-only) and, when a classic `Token scopes:` line is
// present, blocks the run if the CHOSEN path lacks a required scope:
//
//   - gh not installed                  → local-env block (gh install)
//   - `gh auth status` non-zero         → local-env block (gh authentication)
//   - authenticated                     → local-env info "gh installed and authenticated"
//   - token lacks `repo` on a non-skip  → local-env block (repo / repo-admin + step)
//   - token lacks admin:org on org path → local-env block (admin:org + org write)
//   - no `Token scopes:` line at all     → scope blocks SKIPPED (no false positive)
//
// Hermetic with NO real gh/network: a PATH-shadowed `gh` stub answers
// `gh auth status` (with a chosen Token scopes line) and `gh repo view`; the cwd
// is a fresh git-init'd temp dir; init is invoked by its real repo path so
// SCRIPT_DIR resolves to <repoRoot>/scripts (findings.sh + local presets on
// disk, no curl); FLYWHEEL_ASSUME_INTERACTIVE forces the interactive gate branch
// without a TTY. Block tests halt at the gate before REPO resolution; we still
// answer `gh repo view` in the stub for safety.
//
// A fine-grained PAT / App token reports no classic `Token scopes:` line; the
// detector skips the scope blocks in that case (no false positive) and the run
// passes cleanly. The `grep … || true` guard in init.sh makes that skip safe
// under `set -euo pipefail`; the case below pins that behavior.
//
// The gh-not-installed branch is covered behaviorally only: shadowing `gh` to
// "not found" via PATH would also starve every other gh call init makes, so
// reproducing it cleanly here would require contorting the harness. The branch
// is exercised in scripts/init.sh by the same `command -v gh` guard that the
// other paths share; we deliberately skip an end-to-end case for it per the
// workstream brief rather than fake it.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const initSh = join(repoRoot, "scripts/init.sh");

// Default skip-secrets/skip-rulesets path: no scope required, so an authenticated
// token with any (or no) scopes passes the gate cleanly.
const SCAFFOLD_ARGS = [
  "--preset",
  "minimal",
  "--version",
  "v0-gh-capability-test",
  "--skip-secrets",
  "--skip-rulesets",
];

// Path that DOES exercise a required scope: no skip flags, so the credential
// write + ruleset apply steps are in play and a missing `repo` scope blocks.
const CRED_PATH_ARGS = ["--preset", "minimal", "--version", "v0-gh-capability-test"];

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  work: string;
}

/** Run init.sh from a fresh git-init'd temp cwd with a PATH-shadowed `gh` stub.
 * Returns raw streams + the work dir so callers can assert on which scaffold
 * files were (not) written. `ghStub` overrides the default authenticated stub;
 * `ghLog`, when set, names a file the caller can read after the run (the stub
 * appends every invocation's args to it). */
function runInit(
  opts: {
    args?: string[];
    env?: Record<string, string>;
    ghStub?: string;
  } = {},
): RunResult {
  const work = mkdtempSync(join(tmpdir(), "flywheel-gh-capability-"));
  const binDir = join(work, "bin");
  mkdirSync(binDir);
  const gh = join(binDir, "gh");
  // Default stub: authenticated (`gh auth status` exits 0 with a classic Token
  // scopes line including 'repo') and answers `gh repo view`. Callers override
  // via `ghStub` to vary auth state and scopes.
  writeFileSync(gh, opts.ghStub ?? ghStubWithScopes("'repo', 'read:org'"));
  chmodSync(gh, 0o755);
  execFileSync("git", ["init", "-q"], { cwd: work });
  const r = spawnSync("bash", [initSh, ...(opts.args ?? [])], {
    cwd: work,
    encoding: "utf8",
    input: "",
    timeout: 30000,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      ...(opts.env ?? {}),
    },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", work };
}

/** A gh stub that answers `auth status` with the given Token scopes line (or, if
 * `scopesLine` is null, omits the line entirely to simulate a fine-grained/App
 * token) and answers `repo view`. */
function ghStubWithScopes(scopesLine: string | null): string {
  const emit = scopesLine === null ? "" : `echo "  - Token scopes: ${scopesLine}";`;
  return (
    `#!/usr/bin/env bash\n` +
    `if [[ "$1" == "auth" && "$2" == "status" ]]; then ${emit} exit 0; fi\n` +
    `if [[ "$1" == "repo" && "$2" == "view" ]]; then echo "acme/widget"; exit 0; fi\n` +
    `echo "stub gh: unhandled: $*" >&2; exit 1\n`
  );
}

/** Scaffold files the pre-flight gate must NOT write when it halts. */
const SCAFFOLD_FILES = [
  ".flywheel.yml",
  ".github/workflows/flywheel-pr.yml",
  ".gitattributes",
];

// All runs force the interactive gate branch (without a TTY) so a block halts
// at the gate before any prompt/REPO resolution, exercising the "halted"
// wording. The clean-pass tests still complete because no block is emitted.
const INTERACTIVE = { FLYWHEEL_ASSUME_INTERACTIVE: "1" };

describe("init.sh — gh-capability pre-flight detection (§spec:preflight-gh-capability)", () => {
  it("installed + authenticated surfaces as a passing local-env finding", () => {
    // gh auth status exits 0 with a classic `repo` scope; clean pass proceeds to
    // scaffold writes.
    const r = runInit({
      args: SCAFFOLD_ARGS,
      ghStub: ghStubWithScopes("'repo'"),
      env: { ...INTERACTIVE },
    });
    try {
      const out = stripAnsi(r.stdout);
      expect(r.status, `stderr:\n${r.stderr}\nstdout:\n${out}`).toBe(0);
      expect(out).toContain("[local-env]");
      expect(out).toContain("gh installed and authenticated");
      expect(out).toContain("pre-flight: no blockers.");
      expect(existsSync(join(r.work, ".flywheel.yml"))).toBe(true);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("unauthenticated gh blocks (local-env), halts, and writes nothing", () => {
    // `gh auth status` exits non-zero — the auth half of the detector blocks
    // before any write.
    const r = runInit({
      args: SCAFFOLD_ARGS,
      ghStub: `#!/usr/bin/env bash\nif [[ "$1" == "auth" && "$2" == "status" ]]; then echo "not logged in" >&2; exit 1; fi\necho "stub gh: unhandled: $*" >&2; exit 1\n`,
      env: { ...INTERACTIVE },
    });
    try {
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).not.toBe(0);
      expect(combined).toContain("[local-env]");
      expect(combined).toMatch(/gh is not authenticated/i);
      expect(combined).toMatch(/pre-flight (failed|halted)/i);
      for (const f of SCAFFOLD_FILES) {
        expect(existsSync(join(r.work, f)), `expected ${f} NOT to be written`).toBe(false);
      }
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("missing 'repo' scope on a credential/ruleset path blocks naming the scope AND the step", () => {
    // No --skip-* flags, so the FLYWHEEL_GH_APP credential write + ruleset apply
    // are in play; a token lacking `repo` must block, naming both the scope and
    // the step it gates. This is the headline criterion.
    const r = runInit({
      args: CRED_PATH_ARGS,
      ghStub: ghStubWithScopes("'read:org'"),
      env: { ...INTERACTIVE },
    });
    try {
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).not.toBe(0);
      expect(combined).toContain("[local-env]");
      // Names the scope (and the repo-admin path it belongs to).
      expect(combined).toMatch(/'repo' scope/);
      expect(combined).toMatch(/repo-admin/);
      // Names the blocked step: writing the App credentials and applying rulesets.
      expect(combined).toMatch(/FLYWHEEL_GH_APP_ID/);
      expect(combined).toMatch(/FLYWHEEL_GH_APP_PRIVATE_KEY/);
      expect(combined).toMatch(/ruleset/i);
      expect(combined).toMatch(/pre-flight (failed|halted)/i);
      for (const f of SCAFFOLD_FILES) {
        expect(existsSync(join(r.work, f)), `expected ${f} NOT to be written`).toBe(false);
      }
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("missing 'admin:org' on the --scope org path blocks naming admin:org AND the org write", () => {
    // Token HAS repo (so the repo-admin check passes) but lacks admin:org; with
    // --scope org the org-level credential write requires it, so the run blocks.
    const r = runInit({
      args: [...CRED_PATH_ARGS, "--scope", "org"],
      ghStub: ghStubWithScopes("'repo', 'read:org'"),
      env: { ...INTERACTIVE },
    });
    try {
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).not.toBe(0);
      expect(combined).toContain("[local-env]");
      expect(combined).toMatch(/admin:org/);
      // Names the org-level credential write it blocks.
      expect(combined).toMatch(/org-wide|org level|org-level/i);
      expect(combined).toMatch(/FLYWHEEL_GH_APP_ID/);
      expect(combined).toMatch(/pre-flight (failed|halted)/i);
      for (const f of SCAFFOLD_FILES) {
        expect(existsSync(join(r.work, f)), `expected ${f} NOT to be written`).toBe(false);
      }
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  // False-positive avoidance: a fine-grained PAT / App token reports no classic
  // `Token scopes:` line, so the detector cannot determine classic scopes and must
  // SKIP the scope blocks rather than block a token that may well be sufficient.
  // The `grep … || true` guard in init.sh makes that skip safe under
  // `set -euo pipefail` (a no-match grep would otherwise abort the whole run).
  it("fine-grained token (no 'Token scopes:' line) does NOT produce a scope block", () => {
    const r = runInit({
      args: SCAFFOLD_ARGS,
      ghStub: ghStubWithScopes(null),
      env: { ...INTERACTIVE },
    });
    try {
      const out = stripAnsi(r.stdout);
      const combined = stripAnsi(r.stdout + r.stderr);
      // Skipping the scope checks is a clean pass.
      expect(r.status, `combined:\n${combined}`).toBe(0);
      expect(out).toContain("gh installed and authenticated");
      expect(out).toContain("pre-flight: no blockers.");
      expect(combined).not.toMatch(/'repo' scope/);
      expect(combined).not.toMatch(/admin:org/);
      expect(existsSync(join(r.work, ".flywheel.yml"))).toBe(true);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("detection reads gh auth state only — no write subcommands during pre-flight", () => {
    // A logging stub records every gh invocation. On the skip-secrets/skip-rulesets
    // path the detector must only read (`auth status`, later `repo view`) — never
    // `variable set` / `secret set`.
    const work = mkdtempSync(join(tmpdir(), "flywheel-gh-capability-log-"));
    const binDir = join(work, "bin");
    mkdirSync(binDir);
    const ghLog = join(work, "gh-invocations.log");
    const gh = join(binDir, "gh");
    const loggingStub =
      `#!/usr/bin/env bash\n` +
      `printf '%s\\n' "$*" >> ${JSON.stringify(ghLog)}\n` +
      `if [[ "$1" == "auth" && "$2" == "status" ]]; then echo "  - Token scopes: 'repo', 'read:org'"; exit 0; fi\n` +
      `if [[ "$1" == "repo" && "$2" == "view" ]]; then echo "acme/widget"; exit 0; fi\n` +
      `echo "stub gh: unhandled: $*" >&2; exit 1\n`;
    writeFileSync(gh, loggingStub);
    chmodSync(gh, 0o755);
    execFileSync("git", ["init", "-q"], { cwd: work });
    const r = spawnSync("bash", [initSh, ...SCAFFOLD_ARGS], {
      cwd: work,
      encoding: "utf8",
      input: "",
      timeout: 30000,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        ...INTERACTIVE,
      },
    });
    try {
      const out = stripAnsi(r.stdout ?? "");
      expect(r.status, `stderr:\n${r.stderr}\nstdout:\n${out}`).toBe(0);
      const log = existsSync(ghLog) ? readFileSync(ghLog, "utf8") : "";
      // The detector read auth state...
      expect(log).toMatch(/auth status/);
      // ...and never wrote credentials anywhere in the run.
      expect(log).not.toMatch(/variable set/);
      expect(log).not.toMatch(/secret set/);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
