import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Property, in one sentence: piped with no checkout, apply-rulesets.sh still
// finds its four ruleset templates.
//
// An adopter applies Flywheel's protection without cloning by piping the
// script straight from raw.githubusercontent.com:
//
//   curl -fsSL …/apply-rulesets.sh | bash -s -- <owner/repo> …
//
// Run that way the script has no file on disk, so `BASH_SOURCE[0]` is unset
// and the old `SCRIPT_DIR/rulesets/<name>.json` self-location degraded to the
// caller's CWD and died with exit 2 / "Could not open file" before the first
// GitHub API call (§req:apply-rulesets-stdin). Every-PR suites never caught it
// because they always invoked the script FROM a checkout, where SCRIPT_DIR
// resolves; only the adopter path exercises the stdin self-location. This guard
// reproduces that adopter path in the cheap unit suite and asserts the
// resolution OUTCOME — the script gets PAST template resolution rather than
// aborting — so the bug class is caught on every PR, not only at the e2e gate
// or by an adopter.
//
// It is the §spec:apply-rulesets-stdin-test mirror of the cheap
// `tests/adopter-resolution.test.ts` guard added for the composite-action-path
// defect (§spec:adopter-resolution-test, §spec:composite-self-reference).
//
// Hermetic and zero-GitHub-load (§req:sandbox-ci-budget): `gh` is PATH-shadowed
// by a recording stub so no live call is ever made, and the templates resolve
// from this repo's own `scripts/rulesets/` over `file://` via the documented
// `FLYWHEEL_RULESETS_BASE` override — no network. The assertions model the
// outcome ("reached the API layer ⇒ templates resolved first"), not a literal
// code shape, so they stay valid if the resolution mechanism later changes.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const scriptSrc = readFileSync(join(repoRoot, "scripts/apply-rulesets.sh"), "utf8");
const rulesetsDir = join(repoRoot, "scripts/rulesets");

// A minimal adopter `.flywheel.yml` — adopter config, NOT a Flywheel checkout
// (it carries none of `scripts/rulesets/`). A `release: production` branch is
// present so `--release-required-checks` exercises the fourth (release-gate)
// template too: all four templates must resolve for the run to complete.
const MINIMAL_CONFIG = `flywheel:
  streams:
    - name: main-line
      branches:
        - { name: develop, release: prerelease }
        - { name: main, release: production }
`;

function have(cmd: string, args: string[]): boolean {
  return spawnSync(cmd, args, { stdio: "ignore" }).status === 0;
}

// The real tools the script needs to *reach* template resolution and run to
// completion. `gh` is supplied by the stub, so it is not required here. CI
// (ubuntu) has all three, so the guard runs on every PR; a dev box missing one
// skips rather than fails — matching tests/shellcheck.test.ts and init.test.ts.
function toolsAvailable(): boolean {
  return (
    have("jq", ["--version"]) &&
    have("curl", ["--version"]) &&
    have("python3", ["-c", "import yaml"])
  );
}

interface Fixture {
  cwd: string;
  binDir: string;
  ghLog: string;
  cleanup: () => void;
}

/** Empty working dir (no Flywheel source) holding only an adopter
 * `.flywheel.yml`, plus a PATH-shadowing `gh` stub that records every
 * invocation and makes no real call. */
function setup(): Fixture {
  const cwd = mkdtempSync(join(tmpdir(), "flywheel-applyrs-cwd-"));
  writeFileSync(join(cwd, ".flywheel.yml"), MINIMAL_CONFIG);

  const binDir = mkdtempSync(join(tmpdir(), "flywheel-applyrs-bin-"));
  const ghLog = join(binDir, "gh-calls.log");
  // Record argv (one line per call), print nothing (so `existing_id` is empty →
  // the create path), and exit 0. No network, no real GitHub call.
  //
  // The stub must NOT read stdin: when the script is piped to `bash -s`, the
  // GitHub-read calls (`gh api … --jq … | head`) inherit bash's stdin — the
  // pipe still carrying the rest of the script. A `cat`/drain here would eat
  // it and bash would exit early after the first ruleset. The `… --input -`
  // create calls feed gh a small JSON payload (well under the pipe buffer),
  // so leaving it unread never blocks the producer.
  const stub = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${ghLog}"
exit 0
`;
  writeFileSync(join(binDir, "gh"), stub);
  chmodSync(join(binDir, "gh"), 0o755);

  return {
    cwd,
    binDir,
    ghLog,
    cleanup: () => {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    },
  };
}

function runPiped(fx: Fixture, rulesetsBase: string) {
  return spawnSync(
    "bash",
    // Exactly the documented adopter form: script on stdin, args after `--`.
    ["-s", "--", "owner/repo", "--app-id", "12345", "--release-required-checks", "e2e"],
    {
      cwd: fx.cwd,
      input: scriptSrc,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fx.binDir}:${process.env.PATH ?? ""}`,
        FLYWHEEL_RULESETS_BASE: rulesetsBase,
      },
    },
  );
}

describe.skipIf(!toolsAvailable())(
  "apply-rulesets.sh piped from stdin with no checkout (§spec:apply-rulesets-stdin-test)",
  () => {
    it("resolves its four ruleset templates and gets past resolution to the GitHub API layer", () => {
      const fx = setup();
      try {
        const r = runPiped(fx, `file://${rulesetsDir}`);
        const out = `${r.stdout}${r.stderr}`;

        // The headline outcome: the piped run completes — it did not die at
        // template resolution.
        expect(r.status, `expected exit 0, got ${r.status}\n--- output ---\n${out}`).toBe(0);

        // None of the template-resolution failure signatures appear.
        expect(out).not.toMatch(/Could not open file/);
        expect(out).not.toMatch(/No such file or directory/);
        expect(out).not.toMatch(/could not fetch ruleset template/);

        // It ran end to end, applying every ruleset including the release gate
        // — proof all four templates resolved.
        expect(out).toMatch(/Done\. Verify with/);

        // It reached the GitHub API layer: the `gh` stub was invoked, and the
        // first call is a rulesets API call. Template resolution necessarily
        // happened BEFORE this first `gh` call, so reaching it at all proves
        // the templates were obtained without a checkout on disk.
        expect(existsSync(fx.ghLog), "gh stub was never invoked").toBe(true);
        const calls = readFileSync(fx.ghLog, "utf8").trim().split("\n").filter(Boolean);
        expect(calls.length).toBeGreaterThan(0);
        expect(calls[0]).toContain("api");
        expect(calls[0]).toContain("rulesets");
      } finally {
        fx.cleanup();
      }
    });

    // Negative control: proves the guard discriminates. When the templates are
    // genuinely unobtainable (no checkout AND an unreachable fetch source), the
    // script must fail BEFORE any `gh` call — fail-clean, never half-protected
    // (§req:apply-rulesets-stdin-constraints). If resolution silently "worked"
    // here, the positive test's "reached gh ⇒ resolved" claim would be vacuous.
    it("fails before any GitHub API call when templates cannot be resolved", () => {
      const fx = setup();
      try {
        const r = runPiped(fx, `file://${join(tmpdir(), "flywheel-no-such-rulesets-base")}`);

        expect(r.status, "expected a non-zero exit when templates are unobtainable").not.toBe(0);
        // No ruleset was applied: the `gh` stub was never reached.
        const reached = existsSync(fx.ghLog) && readFileSync(fx.ghLog, "utf8").trim().length > 0;
        expect(reached, "gh must not be called when template resolution fails").toBe(false);
      } finally {
        fx.cleanup();
      }
    });
  },
);
