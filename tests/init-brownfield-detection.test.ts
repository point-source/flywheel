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

// End-to-end exercise of scripts/init.sh's READ-ONLY brownfield detectors
// (SPEC.md §spec:brownfield-detection), driven through the real pre-flight pass +
// gate (§spec:preflight-gate). Sibling workstreams add further detectors (branch
// protection, signed-commit/tag, history awareness) to THIS file — keep each
// detector's cases in its own describe block.
//
// This slice covers preflight_detect_version_tag_shape: pre-existing tags whose
// shape would mislead semantic-release's v-prefixed versioning. The detector reads
// tags via `git tag -l`, so these tests create REAL local tags in the work dir
// BEFORE invoking init, exercising the classification logic end to end.
//
// Hermetic with NO real gh/network: a PATH-shadowed `gh` stub answers `gh auth
// status`, `gh repo view`, and a default `gh api …` branch (echoing `[]`) so
// unrelated detectors stay quiet. SCAFFOLD_ARGS make init skip the credential
// prompts and apply-rulesets — leaving the gate as the first thing that can change
// observable state.

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

/** Run init.sh from a fresh git-init'd temp cwd with a PATH-shadowed `gh` stub.
 * The stub answers `gh auth status` (with classic Token scopes so the gh-capability
 * detector stays green), `gh repo view` (acme/widget), and a default `gh api …`
 * branch that echoes `[]` and exits 0 so the remote-tag cross-check and other
 * detectors stay quiet. `tags` are created as REAL git tags in the work dir BEFORE
 * invoking init, so preflight_detect_version_tag_shape actually classifies them. */
function runInit(
  opts: { args?: string[]; env?: Record<string, string>; tags?: string[] } = {},
): RunResult {
  const work = mkdtempSync(join(tmpdir(), "flywheel-brownfield-"));
  const binDir = join(work, "bin");
  mkdirSync(binDir);
  const gh = join(binDir, "gh");
  writeFileSync(
    gh,
    `#!/usr/bin/env bash\n` +
      `if [[ "$1" == "auth" && "$2" == "status" ]]; then echo "  - Token scopes: 'repo', 'read:org'"; exit 0; fi\n` +
      `if [[ "$1" == "repo" && "$2" == "view" ]]; then echo "acme/widget"; exit 0; fi\n` +
      `if [[ "$1" == "api" ]]; then echo "[]"; exit 0; fi\n` +
      `echo "stub gh: unhandled: $*" >&2; exit 1\n`,
  );
  chmodSync(gh, 0o755);
  // Pin end-of-run validation to a green doctor stub so this PRE-FLIGHT suite
  // isn't flipped non-zero by spurious doctor blocks under the exit contract
  // (§spec:setup-exit-contract).
  const doctorStub = writeDoctorStub(binDir, { blocks: 0, warns: 0 });
  execFileSync("git", ["init", "-q"], { cwd: work });
  // git tags need a commit to point at — make a hermetic empty one before tagging.
  if ((opts.tags ?? []).length > 0) {
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    };
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: work, env: gitEnv });
    for (const tag of opts.tags ?? []) {
      execFileSync("git", ["tag", tag], { cwd: work, env: gitEnv });
    }
  }
  const r = spawnSync("bash", [initSh, ...(opts.args ?? [])], {
    cwd: work,
    encoding: "utf8",
    input: "",
    timeout: 30000,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      FLYWHEEL_TEST_HOOKS: "1",
      FLYWHEEL_DOCTOR_OVERRIDE: doctorStub,
      ...(opts.env ?? {}),
    },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", work };
}

describe("init.sh — brownfield version-tag-shape detection", () => {
  it("bare-semver tag 3.4.2 ⇒ instance+block, resolvable by re-tagging with 'v'; writes nothing", () => {
    const r = runInit({ args: SCAFFOLD_ARGS, tags: ["3.4.2"] });
    try {
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).not.toBe(0);
      expect(combined).toMatch(/pre-flight (failed|halted)/i);
      expect(combined).toContain("[instance]");
      expect(combined).toContain("3.4.2");
      expect(combined).toMatch(/re-tagging with a 'v'|v.?prefix/i);
      expect(existsSync(join(r.work, ".flywheel.yml")), "expected .flywheel.yml NOT written").toBe(
        false,
      );
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("non-semver release-2024-q4 ⇒ instance+block, needs adopter baseline / not auto-resolvable", () => {
    const r = runInit({ args: SCAFFOLD_ARGS, tags: ["release-2024-q4"] });
    try {
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).not.toBe(0);
      expect(combined).toMatch(/pre-flight (failed|halted)/i);
      expect(combined).toContain("[instance]");
      expect(combined).toContain("release-2024-q4");
      expect(combined).toMatch(/baseline choice/i);
      expect(combined).toMatch(/not auto-resolvable/i);
      expect(existsSync(join(r.work, ".flywheel.yml"))).toBe(false);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("stable-v1 ⇒ instance+block (non-semver named-release path)", () => {
    const r = runInit({ args: SCAFFOLD_ARGS, tags: ["stable-v1"] });
    try {
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).not.toBe(0);
      expect(combined).toMatch(/pre-flight (failed|halted)/i);
      expect(combined).toContain("[instance]");
      expect(combined).toContain("stable-v1");
      expect(combined).toMatch(/not auto-resolvable/i);
      expect(existsSync(join(r.work, ".flywheel.yml"))).toBe(false);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("clean repo with only v1.2.3 ⇒ no block, proceeds and writes .flywheel.yml", () => {
    const r = runInit({ args: SCAFFOLD_ARGS, tags: ["v1.2.3"] });
    try {
      const out = stripAnsi(r.stdout);
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).toBe(0);
      expect(out).toContain("pre-flight: no blockers.");
      expect(combined).not.toMatch(/collide with Flywheel's v-prefixed scheme/);
      expect(existsSync(join(r.work, ".flywheel.yml"))).toBe(true);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("clean repo with an unrelated tag (nightly) ⇒ no block (false-negative bias), proceeds", () => {
    const r = runInit({ args: SCAFFOLD_ARGS, tags: ["nightly"] });
    try {
      const out = stripAnsi(r.stdout);
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).toBe(0);
      expect(out).toContain("pre-flight: no blockers.");
      expect(combined).not.toMatch(/collide with Flywheel's v-prefixed scheme/);
      expect(existsSync(join(r.work, ".flywheel.yml"))).toBe(true);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });
});
