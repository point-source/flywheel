import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// scripts/init.sh's deterministic file-emission slice: given a preset and
// --version, it should write the matching template to the adopter repo
// with __FLYWHEEL_VERSION__ substituted. The non-deterministic bits
// (gh secret prompts, ruleset application, GitHub App creation) are
// gated behind --skip-secrets / --skip-rulesets and are out of scope here.
//
// This test guards against a class of regression where a refactor to
// init.sh's template-fetch path silently changes what gets written —
// pairs with tests/workflow-template-parity.test.ts, which guards the
// adopter template ↔ dogfood workflow drift.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const initSh = join(repoRoot, "scripts/init.sh");
const TEST_VERSION = "v9.99.0-init-test";

function ghAuthenticated(): boolean {
  const r = spawnSync("gh", ["auth", "status"], { stdio: "ignore" });
  return r.status === 0;
}

interface Case {
  preset: "minimal" | "three-stage" | "multi-stream";
  flywheelTemplate: string;
}

const CASES: Case[] = [
  { preset: "minimal", flywheelTemplate: "scripts/templates/flywheel.minimal.yml" },
  { preset: "three-stage", flywheelTemplate: "scripts/templates/flywheel.three-stage.yml" },
  { preset: "multi-stream", flywheelTemplate: "scripts/templates/flywheel.multi-stream.yml" },
];

describe.skipIf(!ghAuthenticated())("init.sh deterministic file emission", () => {
  for (const c of CASES) {
    it(`--preset ${c.preset} writes preset + workflow templates with version substituted`, () => {
      const work = mkdtempSync(join(tmpdir(), `flywheel-init-${c.preset}-`));
      try {
        // gh repo view (which init.sh calls to resolve $REPO) needs a real
        // remote it can query. Pointing at the parent repo itself is safe:
        // the only side-effect call (`gh api PATCH delete_branch_on_merge=true`)
        // is idempotent against a setting that's already enabled here.
        execFileSync("git", ["init", "-q"], { cwd: work });
        execFileSync(
          "git",
          ["remote", "add", "origin", "git@github.com:point-source/flywheel.git"],
          { cwd: work },
        );

        execFileSync(
          "bash",
          [
            initSh,
            "--preset", c.preset,
            "--version", TEST_VERSION,
            "--skip-secrets",
            "--skip-rulesets",
          ],
          { cwd: work, stdio: "pipe" },
        );

        const writtenFw = readFileSync(join(work, ".flywheel.yml"), "utf8");
        const expectedFw = readFileSync(join(repoRoot, c.flywheelTemplate), "utf8");
        expect(writtenFw).toBe(expectedFw);

        for (const wf of ["flywheel-pr.yml", "flywheel-push.yml"]) {
          const written = readFileSync(join(work, ".github/workflows", wf), "utf8");
          const template = readFileSync(join(repoRoot, "scripts/templates", wf), "utf8");
          const expected = template.replaceAll("__FLYWHEEL_VERSION__", TEST_VERSION);
          expect(written, `${wf} contents`).toBe(expected);
          expect(
            written.includes("__FLYWHEEL_VERSION__"),
            `${wf} should have no placeholder remaining`,
          ).toBe(false);
        }
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    });
  }
});
