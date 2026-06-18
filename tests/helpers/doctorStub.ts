import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Write an executable doctor stub into `dir` that ignores its args, prints the
// given finding lines, and ends with the `DOCTOR_RESULT blocks=N warns=M`
// trailer init.sh's run_setup_validation parses. It exits 1 iff blocks>0,
// mirroring real doctor.sh's block-severity exit code. Returns the stub path.
//
// Driving validation through this stub (FLYWHEEL_TEST_HOOKS=1 +
// FLYWHEEL_DOCTOR_OVERRIDE) keeps init's completion-summary tests hermetic — no
// live `gh` calls from doctor, no verdict that depends on the parent repo's real
// state (§req:sandbox-ci-budget). The pre-flight suites pin a green
// `{ blocks: 0, warns: 0 }` stub because they exercise the PRE-FLIGHT gate, not
// end-of-run validation: without it the real doctor.sh runs against their
// PATH-shadowed gh (which only answers `gh repo view`), reports spurious
// block-severity findings, and — under the end-of-run exit contract
// (§spec:setup-exit-contract) — would flip a clean/warn-only run's exit non-zero.
export function writeDoctorStub(
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
