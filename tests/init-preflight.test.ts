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
import { writeDoctorStub } from "./helpers/doctorStub.js";

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
// NOTE: the old --override-release-conflict flag and its `preflight_block` /
// PREFLIGHT_OVERRIDE_<token> "blind proceed" demotion were removed in batch
// #233-2. A block can no longer be silenced: the release-conflict block now
// hard-stops via brownfield_resolve to the manual brownfield guide
// (§spec:brownfield-resolution). This file drives the gate directly via the
// FLYWHEEL_PREFLIGHT_INJECT seam, which emits raw `finding` lines.

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
  // Pin end-of-run validation to a green doctor stub so this PRE-FLIGHT suite
  // isn't flipped non-zero by spurious doctor blocks under the exit contract
  // (§spec:setup-exit-contract); see writeDoctorStub for the full rationale.
  const doctorStub = writeDoctorStub(binDir, { blocks: 0, warns: 0 });
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
      FLYWHEEL_DOCTOR_OVERRIDE: doctorStub,
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

// ---------------------------------------------------------------------------
// Greenfield parity for the FULL brownfield detector set
// (SPEC.md §spec:brownfield-detection, criterion "greenfield parity": on a
// clean/greenfield repository the pass reports NO brownfield findings and setup
// proceeds exactly as before). This is the batch's headline acceptance check:
// with all four brownfield detectors (version-tag shape, branch-protection
// bypass, signed-commit requirement, history/open-PRs) wired at the seam, a repo
// that is "populated but clean" — and a truly empty greenfield repo — must
// behave EXACTLY like the clean pre-flight pass above: exit 0, print
// "pre-flight: no blockers.", write .flywheel.yml, and surface NONE of the
// brownfield advisory/block strings.
//
// The default runInit gh stub only answers `gh auth status` + `gh repo view`, so
// a `gh api …` call (the remote-tag/ruleset/PR probes) would hit its unhandled
// branch. This helper layers a `gh api … ⇒ []` answer over that stub and seeds
// the work-dir git repo with REAL conventional commits + a v-prefixed tag, so
// every detector actually runs against clean inputs rather than being skipped.
const GIT_IDENT = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

/** A gh stub that answers auth/repo-view AND every `gh api …` call with `[]`
 * (exit 0) — so the remote-tag cross-check, ruleset list, and open-PR scan all
 * observe a clean remote and stay quiet. */
const CLEAN_API_GH_STUB =
  `#!/usr/bin/env bash\n` +
  `if [[ "$1" == "auth" && "$2" == "status" ]]; then echo "  - Token scopes: 'repo', 'read:org'"; exit 0; fi\n` +
  `if [[ "$1" == "repo" && "$2" == "view" ]]; then echo "acme/widget"; exit 0; fi\n` +
  `if [[ "$1" == "variable" || "$1" == "secret" ]]; then echo ""; exit 0; fi\n` +
  `if [[ "$1" == "api" ]]; then echo "[]"; exit 0; fi\n` +
  `echo "stub gh: unhandled: $*" >&2; exit 1\n`;

/** Build a work dir, seed REAL git commits + tags, and run init with the clean
 * `gh api ⇒ []` stub. Used to prove greenfield parity across all four brownfield
 * detectors (they must observe clean inputs and stay silent). */
function rerunSeeded(opts: { commits?: string[]; tags?: string[] }): RunResult {
  const work = mkdtempSync(join(tmpdir(), "flywheel-greenfield-"));
  const binDir = join(work, "bin");
  mkdirSync(binDir);
  const gh = join(binDir, "gh");
  writeFileSync(gh, CLEAN_API_GH_STUB);
  chmodSync(gh, 0o755);
  const doctorStub = writeDoctorStub(binDir, { blocks: 0, warns: 0 });
  execFileSync("git", ["init", "-q"], { cwd: work });
  const gitEnv = { ...process.env, ...GIT_IDENT };
  for (const subject of opts.commits ?? []) {
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", subject], { cwd: work, env: gitEnv });
  }
  for (const tag of opts.tags ?? []) {
    execFileSync("git", ["tag", tag], { cwd: work, env: gitEnv });
  }
  const r = spawnSync("bash", [initSh, ...SCAFFOLD_ARGS], {
    cwd: work,
    encoding: "utf8",
    input: "",
    timeout: 30000,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      FLYWHEEL_TEST_HOOKS: "1",
      FLYWHEEL_DOCTOR_OVERRIDE: doctorStub,
    },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", work };
}

// Brownfield advisory/block strings that MUST NOT appear on a clean repo. Each
// is a fragment uniquely emitted by one of the four detectors (see
// tests/init-brownfield-detection.test.ts for their positive cases).
const BROWNFIELD_FINDING_FRAGMENTS = [
  /collide with Flywheel's v-prefixed scheme/i, // version-tag shape
  /not auto-resolvable/i, // version-tag (non-semver) + signed-commit
  /omits the Flywheel App as a bypass actor/i, // branch-protection bypass
  /signed commits\/tags/i, // signed-commit requirement
  /skip ci/i, // history awareness
  /not Conventional Commits/i, // history awareness
  /open PR\(s\)/i, // open-PR awareness
];

describe("init.sh — brownfield greenfield parity (§spec:brownfield-detection)", () => {
  it("populated-but-clean repo (conventional commits + v-prefixed tag, empty remote) ⇒ no brownfield findings; proceeds exactly as before", () => {
    const r = rerunSeeded({
      commits: ["feat: alpha", "fix: beta"],
      tags: ["v1.2.3"],
    });
    try {
      const out = stripAnsi(r.stdout);
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).toBe(0);
      // Identical observable contract to the clean pre-flight pass above.
      expect(out).toContain("Pre-flight checks:");
      expect(out).toContain("pre-flight: no blockers.");
      const summaryAt = out.indexOf("Pre-flight checks:");
      const writeAt = out.indexOf("wrote .flywheel.yml");
      expect(summaryAt).toBeGreaterThanOrEqual(0);
      expect(writeAt).toBeGreaterThanOrEqual(0);
      expect(summaryAt).toBeLessThan(writeAt);
      expect(existsSync(join(r.work, ".flywheel.yml"))).toBe(true);
      // No brownfield finding (block OR advisory) appears anywhere. We match on
      // each detector's UNIQUE message fragment rather than the shared
      // `[instance]` bucket tag — the credentials-app detector legitimately
      // emits an `[instance]` advisory ("no App ID configured yet") on every
      // clean run, so bucket-tag presence is not evidence of a brownfield find.
      for (const re of BROWNFIELD_FINDING_FRAGMENTS) {
        expect(combined, `unexpected brownfield finding ${re}`).not.toMatch(re);
      }
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("truly greenfield repo (fresh git init, no tags, only an initial commit, empty remote) ⇒ no blockers; proceeds", () => {
    const r = rerunSeeded({ commits: ["chore: initial"], tags: [] });
    try {
      const out = stripAnsi(r.stdout);
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).toBe(0);
      expect(out).toContain("pre-flight: no blockers.");
      expect(existsSync(join(r.work, ".flywheel.yml"))).toBe(true);
      for (const re of BROWNFIELD_FINDING_FRAGMENTS) {
        expect(combined, `unexpected brownfield finding ${re}`).not.toMatch(re);
      }
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });
});
