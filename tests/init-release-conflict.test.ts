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

// End-to-end exercise of scripts/init.sh's READ-ONLY release-conflict detector
// (SPEC.md §spec:preflight-release-conflict), driven through the real pre-flight
// pass + gate (§spec:preflight-gate). Unlike tests/init-preflight.test.ts — which
// uses the FLYWHEEL_PREFLIGHT_INJECT seam to feed synthetic findings — these tests
// write REAL workflow files into the work dir BEFORE invoking init, so
// preflight_detect_release_conflict() actually scans them. That exercises the
// detector's grep logic, its push/workflow_dispatch trigger gating, and its
// flywheel-*/point-source/flywheel self-exclusion end to end.
//
// The detector emits via preflight_block, which (per token) renders an `[instance]`
// bucketed block finding — or, when --override-release-conflict is passed, demotes
// it to an advisory warn carrying "overridden via --override-release-conflict".
//
// Hermetic with NO real gh/network: a PATH-shadowed `gh` stub answers the single
// `gh repo view` call, and SCAFFOLD_ARGS make init skip the releases/latest lookup,
// the credential prompts, and apply-rulesets — leaving the gate as the first thing
// that can change observable state. FLYWHEEL_ASSUME_INTERACTIVE forces the
// interactive branch without a real TTY.

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
 * that answers only `gh repo view`. Unlike the preflight helper, this one writes
 * any `files` (path → contents) into the work dir BEFORE invoking init, creating
 * parent dirs — so the on-disk workflow fixtures are present for the detector to
 * scan. Returns raw streams + the work dir so callers can assert on which scaffold
 * files were (not) written. */
function runInit(
  opts: { args?: string[]; env?: Record<string, string>; files?: Record<string, string> } = {},
): RunResult {
  const work = mkdtempSync(join(tmpdir(), "flywheel-relconflict-"));
  const binDir = join(work, "bin");
  mkdirSync(binDir);
  const gh = join(binDir, "gh");
  writeFileSync(
    gh,
    `#!/usr/bin/env bash\nif [[ "$1" == "repo" && "$2" == "view" ]]; then echo "acme/widget"; exit 0; fi\necho "stub gh: unhandled: $*" >&2; exit 1\n`,
  );
  chmodSync(gh, 0o755);
  execFileSync("git", ["init", "-q"], { cwd: work });
  for (const [rel, contents] of Object.entries(opts.files ?? {})) {
    const dest = join(work, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, contents);
  }
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

/** Scaffold files the pre-flight gate must NOT write when it halts. */
const SCAFFOLD_FILES = [
  ".flywheel.yml",
  ".github/workflows/flywheel-pr.yml",
  ".gitattributes",
];

// --- Workflow fixtures (real files the detector scans) ---------------------

const RELEASE_PLEASE_WF = `name: release
on:
  push:
    branches: [main]
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: googleapis/release-please-action@v4
`;

const SEMANTIC_RELEASE_WF = `name: release
on:
  push:
    branches: [main]
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: cycjimmy/semantic-release-action@v4
`;

const GH_RELEASE_CREATE_WF = `name: release
on:
  push:
    branches: [main]
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - run: gh release create v1.0.0 --generate-notes
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
`;

const GIT_TAG_NPM_VERSION_WF = `name: release
on:
  workflow_dispatch:
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - run: |
          npm version patch
          git tag "v$(node -p "require('./package.json').version")"
          git push --follow-tags
`;

const CLEAN_CI_WF = `name: ci
on:
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
`;

// flywheel's own scaffold: references point-source/flywheel and even mentions
// semantic-release in a comment — must NOT be flagged (self-exclusion).
const FLYWHEEL_PUSH_WF = `name: flywheel-push
# This workflow runs flywheel's bot-managed semantic-release internally.
on:
  push:
    branches: [develop]
jobs:
  push:
    runs-on: ubuntu-latest
    steps:
      - uses: point-source/flywheel@v1
`;

const RELEASE_CONFLICT_BLOCK = /release[- ]conflict|release-please|semantic-release|gh release create|git tag|npm version/i;

describe("init.sh — existing release-system detection (end-to-end)", () => {
  it("release-please ⇒ instance+block; non-interactive exits non-zero and writes nothing", () => {
    const r = runInit({
      args: SCAFFOLD_ARGS,
      files: { ".github/workflows/release.yml": RELEASE_PLEASE_WF },
    });
    try {
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).not.toBe(0);
      expect(combined).toMatch(/pre-flight (failed|halted)/i);
      expect(combined).toContain("release-please");
      expect(combined).toContain("[instance]");
      for (const f of SCAFFOLD_FILES) {
        expect(existsSync(join(r.work, f)), `expected ${f} NOT to be written`).toBe(false);
      }
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("separate semantic-release ⇒ block (non-interactive, writes nothing)", () => {
    const r = runInit({
      args: SCAFFOLD_ARGS,
      files: { ".github/workflows/release.yml": SEMANTIC_RELEASE_WF },
    });
    try {
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).not.toBe(0);
      expect(combined).toMatch(/pre-flight (failed|halted)/i);
      expect(combined).toContain("semantic-release");
      expect(combined).toContain("[instance]");
      expect(existsSync(join(r.work, ".flywheel.yml"))).toBe(false);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("hand-rolled `gh release create` in a push workflow ⇒ block", () => {
    const r = runInit({
      args: SCAFFOLD_ARGS,
      files: { ".github/workflows/release.yml": GH_RELEASE_CREATE_WF },
    });
    try {
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).not.toBe(0);
      expect(combined).toMatch(/pre-flight (failed|halted)/i);
      expect(combined).toContain("gh release create");
      expect(combined).toContain("[instance]");
      expect(existsSync(join(r.work, ".flywheel.yml"))).toBe(false);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("hand-rolled `git tag` / `npm version` in a workflow_dispatch workflow ⇒ block", () => {
    const r = runInit({
      args: SCAFFOLD_ARGS,
      files: { ".github/workflows/release.yml": GIT_TAG_NPM_VERSION_WF },
    });
    try {
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).not.toBe(0);
      expect(combined).toMatch(/pre-flight (failed|halted)/i);
      // Either of the hand-rolled producers is enough to block.
      expect(combined).toMatch(/git tag|npm version/);
      expect(combined).toContain("[instance]");
      expect(existsSync(join(r.work, ".flywheel.yml"))).toBe(false);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("CLEAN repo (ordinary ci.yml on pull_request) ⇒ no block, proceeds and writes .flywheel.yml", () => {
    const r = runInit({
      args: SCAFFOLD_ARGS,
      files: { ".github/workflows/ci.yml": CLEAN_CI_WF },
    });
    try {
      const out = stripAnsi(r.stdout);
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).toBe(0);
      expect(out).toContain("pre-flight: no blockers.");
      expect(combined).not.toMatch(RELEASE_CONFLICT_BLOCK);
      expect(existsSync(join(r.work, ".flywheel.yml"))).toBe(true);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("CLEAN repo with NO workflows at all ⇒ no block, proceeds", () => {
    const r = runInit({ args: SCAFFOLD_ARGS });
    try {
      const out = stripAnsi(r.stdout);
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).toBe(0);
      expect(out).toContain("pre-flight: no blockers.");
      expect(combined).not.toMatch(RELEASE_CONFLICT_BLOCK);
      expect(existsSync(join(r.work, ".flywheel.yml"))).toBe(true);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("self-exclusion ⇒ flywheel's own scaffold (point-source/flywheel + semantic-release comment) is NOT flagged", () => {
    const r = runInit({
      args: SCAFFOLD_ARGS,
      files: { ".github/workflows/flywheel-push.yml": FLYWHEEL_PUSH_WF },
    });
    try {
      const out = stripAnsi(r.stdout);
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).toBe(0);
      expect(out).toContain("pre-flight: no blockers.");
      expect(existsSync(join(r.work, ".flywheel.yml"))).toBe(true);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("without --override-release-conflict, release-please blocks in BOTH TTY modes", () => {
    // Non-interactive.
    const nonInt = runInit({
      args: SCAFFOLD_ARGS,
      files: { ".github/workflows/release.yml": RELEASE_PLEASE_WF },
    });
    try {
      const combined = stripAnsi(nonInt.stdout + nonInt.stderr);
      expect(nonInt.status, `combined:\n${combined}`).not.toBe(0);
      expect(combined).toMatch(/pre-flight failed/i);
      expect(combined).not.toContain("overridden via --override-release-conflict");
      expect(existsSync(join(nonInt.work, ".flywheel.yml"))).toBe(false);
    } finally {
      rmSync(nonInt.work, { recursive: true, force: true });
    }

    // Interactive.
    const inter = runInit({
      args: SCAFFOLD_ARGS,
      env: { FLYWHEEL_ASSUME_INTERACTIVE: "1" },
      files: { ".github/workflows/release.yml": RELEASE_PLEASE_WF },
    });
    try {
      const combined = stripAnsi(inter.stdout + inter.stderr);
      expect(inter.status, `combined:\n${combined}`).not.toBe(0);
      expect(combined).toContain("Pre-flight halted");
      expect(combined).not.toContain("overridden via --override-release-conflict");
      expect(existsSync(join(inter.work, ".flywheel.yml"))).toBe(false);
    } finally {
      rmSync(inter.work, { recursive: true, force: true });
    }
  });

  it("--override-release-conflict demotes the block to a warn and proceeds (interactive)", () => {
    const r = runInit({
      args: [...SCAFFOLD_ARGS, "--override-release-conflict"],
      env: { FLYWHEEL_ASSUME_INTERACTIVE: "1" },
      files: { ".github/workflows/release.yml": RELEASE_PLEASE_WF },
    });
    try {
      const out = stripAnsi(r.stdout);
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).toBe(0);
      expect(combined).toContain("overridden via --override-release-conflict");
      expect(combined).not.toContain("Pre-flight halted");
      expect(out).toContain("pre-flight: no blockers.");
      expect(existsSync(join(r.work, ".flywheel.yml"))).toBe(true);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });
});
