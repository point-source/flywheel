import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripAnsi } from "./helpers/ansi.js";

// scripts/init.sh's deterministic file-emission slice: given a preset and
// --version, it should write the matching template to the adopter repo
// with __FLYWHEEL_VERSION__ substituted. The non-deterministic bits
// (gh secret prompts, ruleset application, GitHub App creation) are
// gated behind --skip-secrets / --skip-rulesets and are out of scope here.
//
// This test guards against a class of regression where a refactor to
// init.sh's template-fetch path silently changes what gets written. The
// emitted workflows must invoke `point-source/flywheel@<ref>` directly
// — the single version surface §spec:action-version-lockstep delivers
// to adopters. tests/action-shape.test.ts pins the template *content*;
// this file pins init.sh's substitution behavior.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const initSh = join(repoRoot, "scripts/init.sh");
const TEST_VERSION = "v9.99.0-init-test";

function ghAuthenticated(): boolean {
  const r = spawnSync("gh", ["auth", "status"], { stdio: "ignore" });
  return r.status === 0;
}

// Write an executable doctor stub into `dir` that ignores its args, prints the
// given finding lines, and ends with the `DOCTOR_RESULT blocks=N warns=M`
// trailer init.sh's run_setup_validation parses. It exits 1 iff blocks>0,
// mirroring real doctor.sh's block-severity exit code. Driving validation
// through this stub (FLYWHEEL_TEST_HOOKS=1 + FLYWHEEL_DOCTOR_OVERRIDE) keeps the
// completion-summary tests hermetic — no live `gh` calls from doctor, no verdict
// that depends on the parent repo's real state (§req:sandbox-ci-budget).
function writeDoctorStub(
  dir: string,
  opts: { blocks: number; warns: number; findingLines?: string[] },
): string {
  const path = join(dir, "doctor-stub.sh");
  const findings = (opts.findingLines ?? [])
    .map((l) => `printf '%s\\n' ${JSON.stringify(l)}`)
    .join("\n");
  const body = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "# Args (repo, --skip-credentials, --summary) are intentionally ignored.",
    findings,
    `printf 'DOCTOR_RESULT blocks=%s warns=%s\\n' ${opts.blocks} ${opts.warns}`,
    `exit ${opts.blocks > 0 ? 1 : 0}`,
    "",
  ].join("\n");
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
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
        // with --skip-rulesets and --skip-secrets, init.sh has no remote
        // side effects (delete_branch_on_merge moved to apply-rulesets.sh).
        execFileSync("git", ["init", "-q"], { cwd: work });
        execFileSync(
          "git",
          ["remote", "add", "origin", "git@github.com:point-source/flywheel.git"],
          { cwd: work },
        );

        // Pin end-of-run validation to a green doctor stub via the
        // FLYWHEEL_TEST_HOOKS seam. Without it the real doctor inspects the
        // live remote and reports genuine block-severity findings for preset
        // branches that don't exist there (e.g. `staging`), which — under the
        // end-of-run exit contract (§spec:setup-exit-contract) — makes init
        // exit non-zero and execFileSync throw before any file assertion runs.
        // This suite tests file EMISSION, not validation, so the green stub
        // keeps it hermetic and focused.
        const doctorStub = writeDoctorStub(work, { blocks: 0, warns: 0 });
        execFileSync(
          "bash",
          [
            initSh,
            "--preset", c.preset,
            "--version", TEST_VERSION,
            "--skip-secrets",
            "--skip-rulesets",
          ],
          {
            cwd: work,
            stdio: "pipe",
            env: {
              ...process.env,
              FLYWHEEL_TEST_HOOKS: "1",
              FLYWHEEL_DOCTOR_OVERRIDE: doctorStub,
            },
          },
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
          // The substituted line is the single version surface — the
          // composite action ref the adopter pins. See SPEC
          // §spec:action-version-lockstep.
          expect(written, `${wf} pins the composite at --version`).toContain(
            `uses: point-source/flywheel@${TEST_VERSION}`,
          );
        }

        // .gitattributes block is what makes back-merges conflict-free
        // (see issue #112) — guard against the block silently dropping out
        // of init.sh. We assert the marker comments + the CHANGELOG.md
        // mapping; release_files paths are adopter-specific.
        expect(existsSync(join(work, ".gitattributes")), ".gitattributes written").toBe(true);
        const attrs = readFileSync(join(work, ".gitattributes"), "utf8");
        expect(attrs).toContain("# >>> flywheel: managed merge-driver attributes");
        expect(attrs).toContain("CHANGELOG.md merge=flywheel-changelog");
        expect(attrs).toContain("# <<< flywheel: managed merge-driver attributes");

        // Local driver registration via `git config` — required because
        // .gitattributes alone doesn't make custom merge drivers run
        // (clones don't inherit merge.<name>.driver entries).
        const cfg = execFileSync("git", ["config", "--get", "merge.flywheel-changelog.driver"], {
          cwd: work,
          encoding: "utf8",
        }).trim();
        expect(cfg).toContain("conventional-changelog-cli");
        const ours = execFileSync(
          "git",
          ["config", "--get", "merge.flywheel-release-file.driver"],
          { cwd: work, encoding: "utf8" },
        ).trim();
        expect(ours).toBe("true");
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    });
  }
});

// scripts/init.sh's end-of-run outcome summary (SPEC.md
// §spec:setup-completion-summary). A clean greenfield run that defers App
// credentials and rulesets via --skip-* must end with a per-step summary —
// every scaffold step named with its real outcome — and a "complete" verdict,
// because deliberate skips are deferred, not failed. The old static
// "Next steps:" block must be gone.
describe.skipIf(!ghAuthenticated())("init.sh completion summary", () => {
  // Stand up the temp adopter repo the existing test uses: a git repo whose
  // origin points at the parent repo so init's `gh repo view` can resolve $REPO,
  // with --skip-rulesets/--skip-secrets keeping the run free of remote side
  // effects. Returns the temp dir; callers clean it up with rmSync.
  function makeAdopterRepo(slug: string): string {
    const work = mkdtempSync(join(tmpdir(), `flywheel-init-${slug}-`));
    execFileSync("git", ["init", "-q"], { cwd: work });
    execFileSync(
      "git",
      ["remote", "add", "origin", "git@github.com:point-source/flywheel.git"],
      { cwd: work },
    );
    return work;
  }

  // Run init non-interactively (spawnSync gives it no TTY, mirroring how the
  // other suites drive it) against `work`, with the doctor validation pinned to
  // `doctorStub` via the FLYWHEEL_TEST_HOOKS seam. Returns stdout AND the exit
  // status — spawnSync (unlike execFileSync) does not throw on a non-zero exit,
  // so the end-of-run exit contract (§spec:setup-exit-contract) is assertable.
  function runInit(work: string, doctorStub: string): { stdout: string; status: number | null } {
    const r = spawnSync(
      "bash",
      [
        initSh,
        "--preset", "minimal",
        "--version", TEST_VERSION,
        "--skip-secrets",
        "--skip-rulesets",
      ],
      {
        cwd: work,
        stdio: "pipe",
        env: {
          ...process.env,
          FLYWHEEL_TEST_HOOKS: "1",
          FLYWHEEL_DOCTOR_OVERRIDE: doctorStub,
        },
      },
    );
    return { stdout: (r.stdout ?? "").toString(), status: r.status };
  }

  // These cases shell out to a live `gh repo view` to resolve $REPO (init still
  // needs real auth here), which can run tens of seconds in a constrained CI
  // sandbox — hence the generous per-test timeout. The doctor validation itself
  // is hermetic (stubbed via FLYWHEEL_DOCTOR_OVERRIDE), so it adds no network.
  const INIT_E2E_TIMEOUT = 60_000;

  it("renders every step's outcome and a complete verdict on a clean --skip-* run", () => {
    const work = makeAdopterRepo("summary");
    try {
      // Green doctor stub: validation passes, so the verdict is driven purely by
      // the scaffold steps' (deferred) outcomes — hermetic, no live gh calls.
      const stub = writeDoctorStub(work, { blocks: 0, warns: 0 });
      const { stdout, status } = runInit(work, stub);
      const plain = stripAnsi(stdout);

      // §spec:setup-exit-contract: a clean run that deferred steps by choice
      // (--skip-* → deferred/warn) plus a green doctor exits 0 — deliberate
      // deferrals are complete, not failures.
      expect(status).toBe(0);

      // Every configured scaffold step is named and shown as configured.
      expect(plain).toContain(".flywheel.yml preset — configured");
      expect(plain).toContain("PR + push workflow files — configured");
      expect(plain).toContain(".gitattributes + merge drivers — configured");

      // App credentials: deferred, [config] bucket, with its finishing command.
      expect(plain).toContain("App credentials — deferred");
      expect(plain).toContain("[config]");
      expect(plain).toContain("gh variable set FLYWHEEL_GH_APP_ID");

      // Rulesets: deferred, [instance] bucket, with its finishing command.
      expect(plain).toContain("Branch + tag protection rulesets — deferred");
      expect(plain).toContain("[instance]");
      expect(plain).toContain("scripts/apply-rulesets.sh");

      // §spec:setup-auto-validation: the green doctor result is folded into the
      // summary as the canonical all-clear line — init and doctor speak as one.
      expect(plain).toContain("Setup validation: all checks pass");

      // Deliberate --skip-* deferrals + a clean validation keep verdict "complete".
      expect(plain).toContain("complete");
      expect(plain).not.toContain("incomplete");

      // The old static checklist is gone.
      expect(plain).not.toContain("Next steps:");

      // The all-green summary must not tell the adopter to run doctor by hand —
      // validation already ran. (Scoped to this green run so a legitimate
      // "finish with: scripts/doctor.sh" deferred line in other scenarios is not
      // matched.) The closing guidance is commit/push/smoke-PR only.
      expect(plain).not.toMatch(/run .*doctor\.sh/i);
      expect(plain).toMatch(/commit \+ push/i);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, INIT_E2E_TIMEOUT);

  it("validation runs non-interactively (no TTY) and folds in the green headline", () => {
    // execFileSync gives init no controlling TTY, so this asserts validation is
    // not gated on interactivity — §spec:setup-auto-validation runs it identically
    // in both modes.
    const work = makeAdopterRepo("validate-noninteractive");
    try {
      const stub = writeDoctorStub(work, { blocks: 0, warns: 0 });
      const { stdout, status } = runInit(work, stub);
      const plain = stripAnsi(stdout);
      expect(status).toBe(0);
      expect(plain).toContain("Setup validation:");
      expect(plain).toContain("Setup validation: all checks pass");
      expect(plain).toContain("complete");
      expect(plain).not.toContain("incomplete");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, INIT_E2E_TIMEOUT);

  it("a doctor block flips an otherwise-clean run to incomplete", () => {
    const work = makeAdopterRepo("validate-block");
    try {
      // Doctor reports one blocking finding even though every scaffold step was a
      // clean deferral. The block must be counted into N and flip the verdict.
      const blockLine = "  ✗ [instance] no ruleset covers branch 'main'";
      const stub = writeDoctorStub(work, {
        blocks: 1,
        warns: 0,
        findingLines: [blockLine],
      });
      const { stdout, status } = runInit(work, stub);
      const plain = stripAnsi(stdout);

      // §spec:setup-exit-contract: an unresolved block-severity finding (here a
      // doctor block) makes the run exit non-zero — concretely status 1.
      expect(status).toBe(1);

      // Doctor's finding line is rendered verbatim in the summary.
      expect(plain).toContain("[instance] no ruleset covers branch 'main'");
      // Even with clean scaffold deferrals, the doctor block forces incomplete.
      expect(plain).toContain("incomplete");
      // The green all-clear headline must NOT appear.
      expect(plain).not.toContain("Setup validation: all checks pass");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, INIT_E2E_TIMEOUT);
});
