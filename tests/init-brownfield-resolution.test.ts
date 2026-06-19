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

// End-to-end exercise of scripts/init.sh's brownfield RESOLUTION phase
// (SPEC.md §spec:brownfield-resolution): the seam that runs AFTER the read-only
// detection pass and BEFORE the gate / any scaffold write. This batch is the
// FRAMEWORK only — no concrete resolvers exist (#233-3 adds them) — so every
// confirmed brownfield block hard-stops to the manual §0 guide and the
// resolution phase mutates NOTHING in either interactive or non-interactive
// mode. A greenfield repo (empty BROWNFIELD_CONDITIONS) makes the phase a strict
// no-op.
//
// The harness mirrors tests/init-brownfield-detection.test.ts exactly: a fresh
// git-init'd temp cwd, a PATH-shadowed `gh` stub answering auth/repo-view + a
// default `gh api` → `[]`, SCAFFOLD_ARGS that skip credential prompts and
// apply-rulesets, real local git tags created BEFORE invoking init, and a GREEN
// writeDoctorStub so runs that reach completion aren't flipped non-zero by a
// spurious doctor block under the exit contract (§spec:setup-exit-contract).

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
  const work = mkdtempSync(join(tmpdir(), "flywheel-brownfield-resolve-"));
  const binDir = join(work, "bin");
  mkdirSync(binDir);
  const gh = join(binDir, "gh");
  writeFileSync(
    gh,
    `#!/usr/bin/env bash\n` +
      `if [[ "$1" == "auth" && "$2" == "status" ]]; then echo "  - Token scopes: 'repo', 'read:org'"; exit 0; fi\n` +
      `if [[ "$1" == "repo" && "$2" == "view" ]]; then echo "acme/widget"; exit 0; fi\n` +
      `if [[ "$1" == "variable" || "$1" == "secret" ]]; then echo ""; exit 0; fi\n` +
      `if [[ "$1" == "api" ]]; then echo "[]"; exit 0; fi\n` +
      `echo "stub gh: unhandled: $*" >&2; exit 1\n`,
  );
  chmodSync(gh, 0o755);
  // Pin end-of-run validation to a green doctor stub so runs that reach the
  // completion summary aren't flipped non-zero by spurious doctor blocks under
  // the exit contract (§spec:setup-exit-contract).
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

/** Local git tags present in the work dir after a run (mutation-free assertion). */
function localTags(work: string): string[] {
  const out = execFileSync("git", ["tag", "-l"], { cwd: work, encoding: "utf8" });
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

describe("brownfield resolution phase", () => {
  it("greenfield: clean repo ⇒ no resolution output, reaches completion, exits 0", () => {
    const r = runInit({ args: SCAFFOLD_ARGS, tags: ["v1.2.3"] });
    try {
      const out = stripAnsi(r.stdout);
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).toBe(0);
      expect(combined).not.toContain("Brownfield conditions need your hand");
      expect(out).toContain("pre-flight: no blockers.");
      expect(existsSync(join(r.work, ".flywheel.yml"))).toBe(true);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("brownfield block hard-stops to §0 (interactive) ⇒ exit != 0, routed to manual guide, writes nothing", () => {
    const r = runInit({
      args: SCAFFOLD_ARGS,
      tags: ["3.4.2"],
      env: { FLYWHEEL_ASSUME_INTERACTIVE: "1" },
    });
    try {
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).not.toBe(0);
      expect(combined).toContain("Brownfield conditions need your hand before adoption:");
      expect(combined).toContain("docs/adopter/setup.md §0");
      expect(existsSync(join(r.work, ".flywheel.yml")), "expected .flywheel.yml NOT written").toBe(
        false,
      );
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("non-interactive degrades to detect-and-report ⇒ exit != 0, reported, ZERO mutation", () => {
    const r = runInit({ args: SCAFFOLD_ARGS, tags: ["3.4.2"] });
    try {
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).not.toBe(0);
      // The brownfield condition is reported (block named in the shared vocab).
      expect(combined).toContain("3.4.2");
      expect(combined).toMatch(/collide with Flywheel's v-prefixed scheme/);
      // Nothing mutated: no scaffold, original tag intact, no v-prefixed retag.
      expect(existsSync(join(r.work, ".flywheel.yml")), "expected .flywheel.yml NOT written").toBe(
        false,
      );
      const tags = localTags(r.work);
      expect(tags).toContain("3.4.2");
      expect(tags).not.toContain("v3.4.2");
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });
});
