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
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripAnsi } from "./helpers/ansi.js";
import { writeDoctorStub } from "./helpers/doctorStub.js";

// Write a hermetic `gh` stub into <binDir>/gh that resolves $REPO and returns a
// CLEAN (greenfield) remote: no rulesets, no protection, no set variables/secrets.
// These suites run init.sh end-to-end against a real `origin` only to resolve
// $REPO, but init's pre-flight now inspects the live remote (brownfield detection,
// §spec:brownfield-detection) and credential state — so without a stub the result
// depends on the live ruleset/variable state of point-source/flywheel and on the
// caller's token scopes (e.g. its managed-branches ruleset legitimately has no App
// bypass actor, which makes the bypass detector hard-stop in CI). The stub keeps
// pre-flight clean so these tests stay focused on file emission / the exit
// contract; brownfield detection has its own hermetic suites. Mirrors how the
// doctor is already pinned via FLYWHEEL_DOCTOR_OVERRIDE.
function writeGhStub(binDir: string, repo = "point-source/flywheel"): void {
  mkdirSync(binDir, { recursive: true });
  const gh = join(binDir, "gh");
  writeFileSync(
    gh,
    `#!/usr/bin/env bash\n` +
      `if [[ "$1" == "auth" && "$2" == "status" ]]; then echo "  - Token scopes: 'repo', 'read:org'"; exit 0; fi\n` +
      `if [[ "$1" == "repo" && "$2" == "view" ]]; then echo ${JSON.stringify(repo)}; exit 0; fi\n` +
      `if [[ "$1" == "variable" || "$1" == "secret" ]]; then echo ""; exit 0; fi\n` +
      `if [[ "$1" == "api" ]]; then echo "[]"; exit 0; fi\n` +
      `echo "stub gh: unhandled: $*" >&2; exit 1\n`,
  );
  chmodSync(gh, 0o755);
}

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

        // Keep pre-flight hermetic: a gh stub resolves $REPO and reports a clean
        // remote, so brownfield detection / credential reads don't hard-stop on the
        // live state of point-source/flywheel (which would block before any file is
        // written). This suite tests file EMISSION, not pre-flight.
        const binDir = join(work, "bin");
        writeGhStub(binDir);

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
              PATH: `${binDir}:${process.env.PATH ?? ""}`,
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
    // Hermetic pre-flight: a gh stub resolves $REPO and reports a clean remote so
    // brownfield detection / credential reads don't hard-stop on the live state of
    // point-source/flywheel (it would block before the completion summary). These
    // tests exercise the exit/completion contract, not pre-flight detection.
    writeGhStub(join(work, "bin"));
    return work;
  }

  // Run init against `work`, with the doctor validation pinned to `doctorStub`
  // via the FLYWHEEL_TEST_HOOKS seam. Returns stdout AND the exit status —
  // spawnSync (unlike execFileSync) does not throw on a non-zero exit, so the
  // end-of-run exit contract (§spec:setup-exit-contract) is assertable.
  //
  // `interactive` selects which completion rendering to exercise
  // (§spec:setup-exit-contract — one summary, two audiences). spawnSync gives the
  // child no TTY, so by default INTERACTIVE=0 and init emits the MACHINE summary
  // (FLYWHEEL_SETUP_STEP / FLYWHEEL_SETUP_RESULT lines). Passing interactive:true
  // forces the human-prose path via FLYWHEEL_ASSUME_INTERACTIVE (gated on
  // FLYWHEEL_TEST_HOOKS). That hook does NOT open fd 3, so it is only safe on a
  // path that exits before any `read -u 3`; the `--preset minimal --skip-secrets
  // --skip-rulesets` scaffold run below reaches the summary without one (verified
  // not to hang), so forcing it here is safe.
  function runInit(
    work: string,
    doctorStub: string,
    opts: { interactive?: boolean; extraArgs?: string[] } = {},
  ): { stdout: string; status: number | null } {
    const r = spawnSync(
      "bash",
      [
        initSh,
        "--preset", "minimal",
        "--version", TEST_VERSION,
        "--skip-secrets",
        "--skip-rulesets",
        ...(opts.extraArgs ?? []),
      ],
      {
        cwd: work,
        stdio: "pipe",
        env: {
          ...process.env,
          PATH: `${join(work, "bin")}:${process.env.PATH ?? ""}`,
          FLYWHEEL_TEST_HOOKS: "1",
          FLYWHEEL_DOCTOR_OVERRIDE: doctorStub,
          ...(opts.interactive ? { FLYWHEEL_ASSUME_INTERACTIVE: "1" } : {}),
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
      // Human-prose rendering (§spec:setup-exit-contract — one summary, two
      // audiences): force the interactive path so the glyph/verdict prose is
      // emitted rather than the machine summary asserted by the dedicated case.
      const { stdout, status } = runInit(work, stub, { interactive: true });
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
      const { stdout, status } = runInit(work, stub, { interactive: true });
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
      const { stdout, status } = runInit(work, stub, { interactive: true });
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

  it("emits a machine-readable summary in a non-interactive run (§spec:setup-exit-contract)", () => {
    // The default spawnSync run has no TTY → INTERACTIVE=0 → init renders the
    // MACHINE summary instead of human prose. An unattended pipeline greps these
    // stable lines to tell a finished setup from a half-finished one.
    const work = makeAdopterRepo("machine-summary");
    try {
      const stub = writeDoctorStub(work, { blocks: 0, warns: 0 });
      const { stdout, status } = runInit(work, stub);
      const plain = stripAnsi(stdout);

      // The verdict trailer is greppable and, on a clean --skip-* run + green
      // doctor, reports complete with zero outstanding items.
      expect(plain).toMatch(/FLYWHEEL_SETUP_RESULT verdict=complete items=0/);

      // At least one per-step machine line is emitted, in the documented shape:
      // outcome/bucket/severity columns followed by quoted command/label.
      expect(plain).toMatch(/FLYWHEEL_SETUP_STEP /);
      expect(plain).toMatch(
        /FLYWHEEL_SETUP_STEP outcome=configured bucket= severity= command="" label="\.flywheel\.yml preset"/,
      );
      // A deferred step carries its actionable finishing command on the same
      // logical line — quoted so the embedded spaces/quotes stay parseable.
      expect(plain).toMatch(
        /FLYWHEEL_SETUP_STEP outcome=deferred bucket=config severity=warn command="gh variable set FLYWHEEL_GH_APP_ID[^\n]*" label="App credentials"/,
      );

      // §spec:setup-exit-contract: the verdict token agrees with the exit code —
      // verdict=complete ⇒ status 0. The two are derived from one incomplete_count.
      expect(status).toBe(0);

      // The interactive-only prose verdict must NOT leak into machine output.
      expect(plain).not.toContain("Flywheel setup summary for");
      expect(plain).not.toMatch(/^complete$/m);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, INIT_E2E_TIMEOUT);

  it("does NOT emit machine lines in an interactive run (prose only)", () => {
    // The companion to the machine-summary case: forcing the interactive path
    // (FLYWHEEL_ASSUME_INTERACTIVE, gated on FLYWHEEL_TEST_HOOKS) must keep the
    // FLYWHEEL_SETUP_* machine lines suppressed — they are gated on INTERACTIVE.
    const work = makeAdopterRepo("interactive-no-machine");
    try {
      const stub = writeDoctorStub(work, { blocks: 0, warns: 0 });
      const { stdout, status } = runInit(work, stub, { interactive: true });
      const plain = stripAnsi(stdout);
      expect(status).toBe(0);
      expect(plain).not.toContain("FLYWHEEL_SETUP_RESULT");
      expect(plain).not.toContain("FLYWHEEL_SETUP_STEP");
      // Prose verdict is present instead.
      expect(plain).toContain("complete");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, INIT_E2E_TIMEOUT);

  it("--strict elevates warn-severity deferrals to a non-zero exit (§spec:setup-exit-contract)", () => {
    // --skip-secrets defers App creds (config/warn) and --skip-rulesets defers
    // rulesets (instance/warn): two warn-severity outstanding items. With a green
    // doctor (blocks=0, warns=0) there is no block/failure, so incomplete_count is
    // 0 — but --strict elevates the warn_count>0 to a non-zero exit.
    const work = makeAdopterRepo("strict-warns");
    try {
      const stub = writeDoctorStub(work, { blocks: 0, warns: 0 });
      const { stdout, status } = runInit(work, stub, { extraArgs: ["--strict"] });
      const plain = stripAnsi(stdout);

      // Strict elevates the deliberate deferrals to a non-zero (status 1) exit.
      expect(status).toBe(1);

      // Strict affects the EXIT CODE only: the verdict still reads complete and
      // items stays 0 (warns never count toward incomplete_count). The additive
      // strict=/warn_items= fields expose why the exit went non-zero.
      expect(plain).toMatch(
        /FLYWHEEL_SETUP_RESULT verdict=complete items=0 strict=1 warn_items=2/,
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, INIT_E2E_TIMEOUT);

  it("the SAME run without --strict stays green (default exits 0)", () => {
    // Regression guard: the identical --skip-secrets/--skip-rulesets run + green
    // doctor must exit 0 without --strict. Deliberate deferrals keep the default
    // green; strict is strictly opt-in (SPEC.md §spec:setup-exit-contract).
    const work = makeAdopterRepo("strict-default-green");
    try {
      const stub = writeDoctorStub(work, { blocks: 0, warns: 0 });
      const { stdout, status } = runInit(work, stub);
      const plain = stripAnsi(stdout);

      expect(status).toBe(0);
      // verdict=complete with items=0, and strict=0 records the default mode.
      expect(plain).toMatch(
        /FLYWHEEL_SETUP_RESULT verdict=complete items=0 strict=0 warn_items=2/,
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, INIT_E2E_TIMEOUT);

  it("--strict folds doctor warns into the warn_count exit decision", () => {
    // A doctor stub reporting warns=2, blocks=0 contributes to warn_count (on top
    // of the two scaffold deferrals). With no blocks/failures incomplete_count is
    // 0, so without --strict this would exit 0 — but --strict elevates the warns.
    const work = makeAdopterRepo("strict-doctor-warns");
    try {
      const warnLine = "  ! [instance] ruleset is missing a required check";
      const stub = writeDoctorStub(work, {
        blocks: 0,
        warns: 2,
        findingLines: [warnLine],
      });
      const { stdout, status } = runInit(work, stub, { extraArgs: ["--strict"] });
      const plain = stripAnsi(stdout);

      // Doctor warns fold into warn_count, so --strict exits non-zero (status 1).
      expect(status).toBe(1);
      // verdict stays complete (warns/doctor-warns don't move it); warn_items
      // tallies the two scaffold deferrals plus doctor's two warns.
      expect(plain).toMatch(
        /FLYWHEEL_SETUP_RESULT verdict=complete items=0 strict=1 warn_items=4/,
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, INIT_E2E_TIMEOUT);
});
