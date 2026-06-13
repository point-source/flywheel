import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { stripAnsi } from "./helpers/ansi.js";

// End-to-end exercise of scripts/init.sh's READ-ONLY pre-flight pass + gate
// (SPEC.md §spec:preflight-gate). The pass runs as the first substantive thing
// init does — before version resolution, the first prompt, and the first file
// write. These tests pin the gate's observable contract:
//
//   - a clean pass prints the summary, then proceeds to scaffold writes
//     (summary index < write index — i.e. pre-flight is genuinely first),
//   - any `block` finding halts the run non-zero BEFORE any file is written,
//     with mode-appropriate wording (interactive "halted" / non-int "failed"),
//   - `warn`/`info` findings never halt, in either TTY mode.
//
// Hermetic with NO real gh/network: FLYWHEEL_PREFLIGHT_INJECT stubs findings
// (so we don't depend on Batches 3–5's detectors), FLYWHEEL_ASSUME_INTERACTIVE
// forces the interactive branch without a TTY, and the SCAFFOLD_ARGS below make
// init skip the releases/latest lookup, the credential prompts, and
// apply-rulesets — leaving a single `gh repo view` call we answer with a
// PATH-shadowed stub that echoes acme/widget. Because init.sh is invoked by its
// real repo path, SCRIPT_DIR resolves to <repoRoot>/scripts, so findings.sh and
// the local presets are found on disk (no curl).
//
// NOTE on the override hook: scripts/init.sh ships `preflight_block` +
// PREFLIGHT_OVERRIDE_<token> in this batch, which demotes a block to an advisory
// warn when the override is active. There is, by design, no caller yet — its
// only caller (the --override-release-conflict flag) arrives in Batch 4
// (§spec:preflight-release-conflict). The FLYWHEEL_PREFLIGHT_INJECT seam emits
// raw `finding` lines, not `preflight_block`, so there is no non-brittle
// end-to-end path to drive the override from here without duplicating the
// function body. The override's end-to-end test therefore lands in Batch 4
// alongside its caller; findings.sh's vocabulary (which preflight_block builds
// on) is unit-covered in tests/findings.test.ts.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const initSh = join(repoRoot, "scripts/init.sh");

const SCAFFOLD_ARGS = [
  "--preset",
  "minimal",
  "--version",
  "v0-preflight-test",
  "--skip-secrets",
  "--skip-rulesets",
];

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  work: string;
}

/** Run init.sh from a fresh git-init'd temp cwd with a PATH-shadowed `gh` stub
 * that answers only `gh repo view` (the sole gh call left in the
 * skip-secrets/skip-rulesets path before the gate). Returns raw streams + the
 * work dir so callers can assert on which scaffold files were (not) written. */
function runInit(
  opts: { args?: string[]; env?: Record<string, string>; ghStub?: string } = {},
): RunResult {
  const work = mkdtempSync(join(tmpdir(), "flywheel-preflight-"));
  const binDir = join(work, "bin");
  mkdirSync(binDir);
  const gh = join(binDir, "gh");
  // Default stub: authenticated (`gh auth status` exits 0 with a realistic
  // Token scopes line including 'repo') and answers `gh repo view`. Callers
  // override via `ghStub` to exercise the unauthenticated/uninstalled paths.
  const defaultGhStub = `#!/usr/bin/env bash\nif [[ "$1" == "auth" && "$2" == "status" ]]; then echo "  - Token scopes: 'repo', 'read:org'"; exit 0; fi\nif [[ "$1" == "repo" && "$2" == "view" ]]; then echo "acme/widget"; exit 0; fi\necho "stub gh: unhandled: $*" >&2; exit 1\n`;
  writeFileSync(gh, opts.ghStub ?? defaultGhStub);
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
      // Opt into the test-only pre-flight hooks (FLYWHEEL_ASSUME_INTERACTIVE /
      // FLYWHEEL_PREFLIGHT_INJECT), which init.sh ignores unless this is set.
      FLYWHEEL_TEST_HOOKS: "1",
      ...(opts.env ?? {}),
    },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", work };
}

/** Scaffold files the pre-flight gate must NOT write when it halts. */
const SCAFFOLD_FILES = [
  ".flywheel.yml",
  ".github/workflows/flywheel-pr.yml",
  ".gitattributes",
];

describe("init.sh — pre-flight gate (end-to-end)", () => {
  it("clean pass proceeds, prints the summary, and does so BEFORE any write", () => {
    const r = runInit({ args: SCAFFOLD_ARGS });
    try {
      const out = stripAnsi(r.stdout);
      expect(r.status, `stderr:\n${r.stderr}\nstdout:\n${out}`).toBe(0);
      expect(out).toContain("Pre-flight checks:");
      expect(out).toContain("pre-flight: no blockers.");
      // The pre-flight summary is the first thing printed — its index must
      // precede the .flywheel.yml write, proving the pass runs before writes.
      const summaryAt = out.indexOf("Pre-flight checks:");
      const writeAt = out.indexOf("wrote .flywheel.yml");
      expect(summaryAt).toBeGreaterThanOrEqual(0);
      expect(writeAt).toBeGreaterThanOrEqual(0);
      expect(summaryAt).toBeLessThan(writeAt);
      expect(existsSync(join(r.work, ".flywheel.yml"))).toBe(true);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("non-interactive block exits non-zero with a reason and writes nothing", () => {
    const r = runInit({
      args: SCAFFOLD_ARGS,
      env: { FLYWHEEL_PREFLIGHT_INJECT: "local-env:block:gh not authenticated (test)" },
    });
    try {
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).not.toBe(0);
      expect(combined).toContain("gh not authenticated (test)");
      expect(combined).toMatch(/pre-flight (failed|halted)/i);
      for (const f of SCAFFOLD_FILES) {
        expect(existsSync(join(r.work, f)), `expected ${f} NOT to be written`).toBe(false);
      }
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("interactive block halts (interactive wording) and writes nothing", () => {
    const r = runInit({
      args: SCAFFOLD_ARGS,
      env: {
        FLYWHEEL_PREFLIGHT_INJECT: "local-env:block:gh not authenticated (test)",
        FLYWHEEL_ASSUME_INTERACTIVE: "1",
      },
    });
    try {
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).not.toBe(0);
      expect(combined).toContain("gh not authenticated (test)");
      expect(combined).toContain("Pre-flight halted");
      for (const f of SCAFFOLD_FILES) {
        expect(existsSync(join(r.work, f)), `expected ${f} NOT to be written`).toBe(false);
      }
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("unauthenticated gh blocks (local-env), halts non-zero, and writes nothing", () => {
    // gh is installed but `gh auth status` exits non-zero — the install/auth
    // half of §spec:preflight-gh-capability must surface this as a local-env
    // block before any write, halting the run.
    const r = runInit({
      args: SCAFFOLD_ARGS,
      ghStub: `#!/usr/bin/env bash\nif [[ "$1" == "auth" && "$2" == "status" ]]; then echo "not logged in" >&2; exit 1; fi\necho "stub gh: unhandled: $*" >&2; exit 1\n`,
    });
    try {
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).not.toBe(0);
      expect(combined).toMatch(/gh is not authenticated/i);
      expect(combined).toMatch(/pre-flight (failed|halted)/i);
      for (const f of SCAFFOLD_FILES) {
        expect(existsSync(join(r.work, f)), `expected ${f} NOT to be written`).toBe(false);
      }
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it.each([
    ["non-interactive", {}],
    ["interactive", { FLYWHEEL_ASSUME_INTERACTIVE: "1" }],
  ])("warn/info never halt (%s)", (_label, extraEnv) => {
    const r = runInit({
      args: SCAFFOLD_ARGS,
      env: {
        FLYWHEEL_PREFLIGHT_INJECT: [
          "config:warn:allow_auto_merge disabled (test)",
          "local-env:info:gh up to date (test)",
        ].join("\n"),
        ...extraEnv,
      },
    });
    try {
      const out = stripAnsi(r.stdout);
      expect(r.status, r.stderr).toBe(0);
      expect(out).toContain("allow_auto_merge disabled (test)");
      expect(out).toContain("gh up to date (test)");
      expect(existsSync(join(r.work, ".flywheel.yml"))).toBe(true);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });
});
