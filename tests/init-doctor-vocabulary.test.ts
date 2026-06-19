import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// WS3 (#236) — ONE-VOCABULARY guard across the two surfaces that describe the
// App credential to an adopter: scripts/init.sh (setup) and scripts/doctor.sh
// (validation). §spec:setup-completion-summary folds doctor's findings into
// init's completion summary verbatim, and §spec:doctor-settings-read has doctor
// read the same credentials init provisions — so the credential's NAME, its KIND
// (variable vs secret), its LEVELS (repo/org), the finding BUCKETS, and the
// SEVERITY names must be a single shared vocabulary. Synonym drift (e.g. doctor
// calling FLYWHEEL_GH_APP_ID a "token name" while init calls it a "variable", or
// severities diverging into FAIL/WARN/NOTE) would make the merged summary read
// as two different tools. This is a SOURCE-SLICE assertion over both scripts;
// it never executes them, so it always runs.
//
// At authoring time doctor.sh ALREADY matched init.sh's vocabulary, so this is a
// pure assertion with NO source edit. If a future change diverges either side,
// this test fails and points at the drift.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const initSh = readFileSync(join(repoRoot, "scripts/init.sh"), "utf8");
const doctorSh = readFileSync(join(repoRoot, "scripts/doctor.sh"), "utf8");

describe("init.sh / doctor.sh — one vocabulary for the App credential", () => {
  it("both name FLYWHEEL_GH_APP_ID as a 'variable'", () => {
    expect(initSh).toContain("FLYWHEEL_GH_APP_ID variable");
    expect(doctorSh).toContain("FLYWHEEL_GH_APP_ID variable");
  });

  it("both name FLYWHEEL_GH_APP_PRIVATE_KEY as a 'secret'", () => {
    expect(initSh).toContain("FLYWHEEL_GH_APP_PRIVATE_KEY secret");
    expect(doctorSh).toContain("FLYWHEEL_GH_APP_PRIVATE_KEY secret");
  });

  it("neither describes the credential as a 'token name' (no synonym drift)", () => {
    expect(initSh).not.toContain("token name");
    expect(doctorSh).not.toContain("token name");
  });

  it("both express credential location with 'repo'/'org' levels", () => {
    // init renders "(repo-level)"/"(org-level)" summaries; doctor renders
    // "set (repo)"/"set (org (...))". Pin the shared repo/org level vocabulary.
    expect(initSh).toContain("repo-level");
    expect(initSh).toContain("org-level");
    expect(doctorSh).toMatch(/variable set \(\$found_var_at\)/);
    expect(doctorSh).toContain('found_var_at="repo"');
    expect(doctorSh).toContain('found_var_at="org');
    expect(doctorSh).toContain('found_secret_at="repo"');
    expect(doctorSh).toContain('found_secret_at="org');
  });

  it("both use the same finding BUCKETS: local-env / instance / config", () => {
    for (const bucket of ["local-env", "instance", "config"]) {
      expect(initSh, `init.sh must use bucket ${bucket}`).toContain(bucket);
      expect(doctorSh, `doctor.sh must use bucket ${bucket}`).toContain(bucket);
    }
    // The App credential specifically is bucketed `config` on BOTH sides.
    expect(initSh).toContain('record_outcome "App credentials" deferred config warn');
    expect(doctorSh).toMatch(/fail config "FLYWHEEL_GH_APP_ID variable missing/);
  });

  it("both use the same SEVERITY names: block / warn / info (no FAIL/WARN/NOTE drift)", () => {
    // init records severities literally as block/warn/info; doctor names them via
    // the finding() wrapper's second arg (fail→block, warn→warn, note→info).
    for (const sev of ["block", "warn", "info"]) {
      expect(initSh, `init.sh must use severity ${sev}`).toContain(sev);
      expect(doctorSh, `doctor.sh must use severity ${sev}`).toContain(sev);
    }
    // doctor's severity wrappers map to the shared names — pin the mapping so a
    // rename can't silently introduce a FAIL/WARN/NOTE severity vocabulary.
    expect(doctorSh).toMatch(/fail\(\)\s*{\s*finding "\$1" block "\$2"; }/);
    expect(doctorSh).toMatch(/warn\(\)\s*{\s*finding "\$1" warn "\$2";/);
    expect(doctorSh).toMatch(/note\(\)\s*{\s*finding "\$1" info "\$2"; }/);
  });
});
