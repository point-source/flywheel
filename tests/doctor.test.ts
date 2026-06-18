import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { stripAnsi } from "./helpers/ansi.js";

// End-to-end exercise of scripts/doctor.sh with a PATH-shadowed `gh` stub
// (the back-merge.test.ts pattern) and the real git/jq/python3+PyYAML on
// PATH. doctor sources scripts/lib/findings.sh and emits every check through
// the shared `finding` vocabulary; these tests pin SPEC.md
// §spec:preflight-classification's observable contract:
//
//   - every finding line carries a literal `[<bucket>]` label,
//   - allow_auto_merge:false is reclassified to config + warn (not a block),
//   - exit code is 1 iff at least one block-severity finding fired, else 0.
//
// We always pass an explicit `owner/repo` arg and `--skip-credentials` so the
// stub stays small: doctor takes its remote path (remote_only=1, because the
// stubbed `gh repo view` returns nothing) and skips the variable/secret
// listing checks. The remote path also skips the local-only .gitattributes
// and merge_group scans, so the stub only needs to answer a handful of
// `gh api` calls.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = join(repoRoot, "scripts/doctor.sh");

function toolAvailable(cmd: string, ...args: string[]): boolean {
  return spawnSync(cmd, args, { stdio: "ignore" }).status === 0;
}

const pyyamlAvailable =
  toolAvailable("python3", "--version") &&
  spawnSync("python3", ["-c", "import yaml"], { stdio: "ignore" }).status === 0;
const jqAvailable = toolAvailable("jq", "--version");
const depsAvailable = pyyamlAvailable && jqAvailable;

const REPO = "acme/widget";

// A valid single-stream/single-branch config: minimizes the branch-existence
// checks doctor performs (only `main`).
const SINGLE_BRANCH_YAML = `flywheel:
  streams:
    - name: solo
      branches:
        - name: main
          release: production
          auto_merge: [fix, chore]
`;

const WORKFLOW_PR = `name: flywheel-pr
on: { pull_request: {} }
jobs:
  pr:
    uses: ./.github/workflows/pr.yml
    with:
      app-id: \${{ vars.FLYWHEEL_GH_APP_ID }}
`;
const WORKFLOW_PUSH = `name: flywheel-push
on: { push: {} }
jobs:
  push:
    uses: ./.github/workflows/push.yml
    with:
      app-id: \${{ vars.FLYWHEEL_GH_APP_ID }}
`;

/** Options that flip individual stub responses to engineer specific
 * pass/fail scenarios. Defaults yield a fully-clean run. */
interface StubOpts {
  /** allow_auto_merge value in the repos/<REPO> settings response. */
  allowAutoMerge?: boolean;
  /** delete_branch_on_merge value in the repos/<REPO> settings response. */
  deleteBranchOnMerge?: boolean;
  /** If true (default), the repos/<REPO> settings response includes the
   * admin-gated `allow_auto_merge` + `delete_branch_on_merge` fields. If
   * false, both are OMITTED from the (still-successful) response — modelling
   * an under-scoped / App-installation token, where GitHub drops admin-gated
   * fields from the repo object rather than failing the call. doctor must
   * then read them as "could not verify" (absent), not "disabled" (false). */
  adminFieldsVisible?: boolean;
  /** If true, `repos/<REPO>/contents/.flywheel.yml` returns the config;
   * if false, it 404s (→ instance block "no .flywheel.yml"). */
  hasConfig?: boolean;
  /** If true, rulesets are present and protect main + v* tags;
   * if false, `repos/<REPO>/rulesets` returns `[]` (→ instance blocks). */
  hasRulesets?: boolean;
  /** If true, the rulesets LIST still succeeds (so `hasRulesets` stays in
   * effect) but the BRANCH ruleset DETAIL read (`repos/<REPO>/rulesets/1`)
   * exits non-zero — modelling a permission gap where listing rulesets is
   * allowed but reading one requires repo-admin. doctor must then emit a
   * "could not verify ruleset" warn and downgrade the unmatched-branch BLOCK
   * to a could-not-verify warn, instead of a false "no ruleset covers branch"
   * (#239). The tag ruleset detail (id 2) is left readable, so v* protection
   * still verifies cleanly and this path introduces no block-severity finding. */
  rulesetDetailFails?: boolean;
}

/** Writes a `gh` stub into a temp bin dir and returns the dir + a cleanup.
 *
 * doctor.sh's `gh` calls in the explicit-repo + --skip-credentials path:
 *   gh repo view --json … -q …                          (cwd detection → empty)
 *   gh api repos/<REPO>/contents/.flywheel.yml -q .content
 *   gh api repos/<REPO>/branches/<b>
 *   gh api repos/<REPO>                                  (settings JSON → jq)
 *   gh api repos/<REPO>/contents/.github/workflows/<wf> -q .content
 *   gh api repos/<REPO>/rulesets                         (array → jq)
 *   gh api repos/<REPO>/rulesets/<id>                    (detail → jq)
 *
 * The stub branches on the api path (its first non-flag positional after
 * `api`) and emits canned base64 for contents paths, JSON for the rest. */
function setupGhStub(opts: StubOpts = {}): { binDir: string; cleanup: () => void } {
  const {
    allowAutoMerge = true,
    deleteBranchOnMerge = true,
    adminFieldsVisible = true,
    hasConfig = true,
    hasRulesets = true,
    rulesetDetailFails = false,
  } = opts;

  const binDir = mkdtempSync(join(tmpdir(), "flywheel-doctor-bin-"));

  const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

  // When adminFieldsVisible is false, omit the two admin-gated fields entirely
  // (an under-scoped/App token sees a successful response without them), while
  // keeping `private: false` so the object is still a valid non-empty repo.
  const settingsJson = JSON.stringify(
    adminFieldsVisible
      ? {
          allow_auto_merge: allowAutoMerge,
          delete_branch_on_merge: deleteBranchOnMerge,
          private: false,
        }
      : { private: false },
  );

  // One branch ruleset (id 1) covering refs/heads/main with a pull_request
  // rule, plus one tag ruleset (id 2) covering refs/tags/v*.
  const rulesetsList = JSON.stringify([
    { id: 1, target: "branch" },
    { id: 2, target: "tag" },
  ]);
  const branchRulesetDetail = JSON.stringify({
    conditions: { ref_name: { include: ["refs/heads/main"] } },
    rules: [{ type: "pull_request" }],
  });
  const tagRulesetDetail = JSON.stringify({
    conditions: { ref_name: { include: ["refs/tags/v*"] } },
    rules: [],
  });

  const stub = `#!/usr/bin/env bash
# Stubbed gh — answers only the api paths doctor.sh hits.
sub="$1"

if [[ "$sub" == "repo" ]]; then
  # 'gh repo view …' — emit nothing so doctor falls back to its REPO arg
  # and treats the run as remote_only.
  exit 0
fi

if [[ "$sub" != "api" ]]; then
  exit 0
fi

# The api path is the first positional after 'api' that is not a flag/flag-arg.
path=""
shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    -q|--jq|-H|--header|-X|--method|-f|--raw-field|-F|--field) shift 2; continue ;;
    --*) shift; continue ;;
    -*) shift; continue ;;
    *) path="$1"; break ;;
  esac
done

case "$path" in
  "repos/${REPO}/contents/.flywheel.yml")
    ${hasConfig ? `printf '%s\\n' "${b64(SINGLE_BRANCH_YAML)}"` : "exit 1"}
    ;;
  "repos/${REPO}/contents/.github/workflows/flywheel-pr.yml")
    printf '%s\\n' "${b64(WORKFLOW_PR)}"
    ;;
  "repos/${REPO}/contents/.github/workflows/flywheel-push.yml")
    printf '%s\\n' "${b64(WORKFLOW_PUSH)}"
    ;;
  "repos/${REPO}/branches/"*)
    # Any managed branch exists.
    printf '{"name":"main"}\\n'
    ;;
  "repos/${REPO}")
    printf '%s\\n' '${settingsJson}'
    ;;
  "repos/${REPO}/rulesets")
    ${hasRulesets ? `printf '%s\\n' '${rulesetsList}'` : `printf '%s\\n' '[]'`}
    ;;
  "repos/${REPO}/rulesets/1")
    # Branch ruleset detail. When rulesetDetailFails is set, exit non-zero to
    # model a permission gap (LIST allowed, DETAIL repo-admin-gated) — doctor
    # must surface this as could-not-verify, not a false coverage block (#239).
    ${rulesetDetailFails ? "exit 1" : `printf '%s\\n' '${branchRulesetDetail}'`}
    ;;
  "repos/${REPO}/rulesets/2")
    printf '%s\\n' '${tagRulesetDetail}'
    ;;
  *)
    # Unknown path → behave like a 404 so doctor's "if …; then" guards take
    # their else branch.
    exit 1
    ;;
esac
exit 0
`;
  writeFileSync(join(binDir, "gh"), stub);
  chmodSync(join(binDir, "gh"), 0o755);
  return {
    binDir,
    cleanup: () => rmSync(binDir, { recursive: true, force: true }),
  };
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Run doctor.sh against REPO with the given stub, from a throwaway cwd. */
function runDoctor(binDir: string, cwd: string, extraArgs: string[] = []): RunResult {
  const r = spawnSync("bash", [scriptPath, "--skip-credentials", ...extraArgs, REPO], {
    cwd,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
    encoding: "utf8",
  });
  return { exitCode: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe.skipIf(!depsAvailable)("doctor.sh — pre-flight classification (end-to-end)", () => {
  it("bucket-labels every finding line ([instance] and/or [config] appear)", () => {
    // Config present but allow_auto_merge disabled → at least one [config]
    // line. No rulesets → [instance] blocks. Both bucket labels surface.
    const stub = setupGhStub({ allowAutoMerge: false, hasRulesets: false });
    const cwd = mkdtempSync(join(tmpdir(), "flywheel-doctor-cwd-"));
    try {
      const r = runDoctor(stub.binDir, cwd);
      const plain = stripAnsi(r.stdout);
      // Every emitted finding (✗ block / ! warn / i info) carries a bracketed
      // bucket. Assert the two buckets exercised here both appear.
      expect(plain).toContain("[config]");
      expect(plain).toContain("[instance]");
    } finally {
      stub.cleanup();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("allow_auto_merge:false → a [config] warn that does NOT by itself force exit 1", () => {
    // Everything else passes; only allow_auto_merge is disabled. Per the
    // reclassification this is config + warn, so the run must still exit 0.
    const stub = setupGhStub({ allowAutoMerge: false });
    const cwd = mkdtempSync(join(tmpdir(), "flywheel-doctor-cwd-"));
    try {
      const r = runDoctor(stub.binDir, cwd);
      const plain = stripAnsi(r.stdout);
      // The allow_auto_merge finding is a [config] line…
      const autoMergeLine = plain
        .split("\n")
        .find((l) => l.includes("allow_auto_merge") && l.includes("disabled"));
      expect(autoMergeLine, "expected an allow_auto_merge disabled finding").toBeDefined();
      expect(autoMergeLine).toContain("[config]");
      // …and it is a warn, not a block — it does not flip the exit code.
      expect(r.exitCode, `stderr:\n${r.stderr}\nstdout:\n${plain}`).toBe(0);
      expect(plain).toMatch(/OK with warnings/);
    } finally {
      stub.cleanup();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("admin-gated settings absent → [local-env] could-not-verify, not [config] disabled (#239)", () => {
    // Under-scoped / App token: the repos/<REPO> call succeeds but GitHub omits
    // allow_auto_merge + delete_branch_on_merge. doctor must read these as
    // "could not verify" (a local-env warn), NOT misreport them as "disabled".
    const stub = setupGhStub({ adminFieldsVisible: false });
    const cwd = mkdtempSync(join(tmpdir(), "flywheel-doctor-cwd-"));
    try {
      const r = runDoctor(stub.binDir, cwd);
      const plain = stripAnsi(r.stdout);
      // Both could-not-verify lines surface on [local-env] lines.
      const autoMergeLine = plain
        .split("\n")
        .find((l) =>
          l.includes("could not verify allow_auto_merge — reading it requires repo-admin"),
        );
      expect(
        autoMergeLine,
        "expected an allow_auto_merge could-not-verify finding",
      ).toBeDefined();
      expect(autoMergeLine).toContain("[local-env]");
      const deleteBranchLine = plain
        .split("\n")
        .find((l) =>
          l.includes(
            "could not verify delete_branch_on_merge — reading it requires repo-admin",
          ),
        );
      expect(
        deleteBranchLine,
        "expected a delete_branch_on_merge could-not-verify finding",
      ).toBeDefined();
      expect(deleteBranchLine).toContain("[local-env]");
      // Absence must NOT be misreported as "disabled".
      const disabledLine = plain
        .split("\n")
        .find((l) => l.includes("allow_auto_merge") && l.includes("disabled"));
      expect(
        disabledLine,
        "absent allow_auto_merge must not be reported as disabled",
      ).toBeUndefined();
      // could-not-verify is a warn, not a block — exit stays 0.
      expect(r.exitCode, `stderr:\n${r.stderr}\nstdout:\n${plain}`).toBe(0);
    } finally {
      stub.cleanup();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("admin-gated settings present+true → ok 'allow_auto_merge enabled', no warn (#239)", () => {
    // Clean default stub: the field is present and true, so doctor emits the
    // ok "enabled" line — never a "disabled" or "could not verify" warn.
    const stub = setupGhStub();
    const cwd = mkdtempSync(join(tmpdir(), "flywheel-doctor-cwd-"));
    try {
      const r = runDoctor(stub.binDir, cwd);
      const plain = stripAnsi(r.stdout);
      const enabledLine = plain
        .split("\n")
        .find((l) => l.includes("allow_auto_merge enabled"));
      expect(enabledLine, "expected an allow_auto_merge enabled finding").toBeDefined();
      expect(plain).not.toContain("allow_auto_merge disabled");
      expect(plain).not.toContain("could not verify allow_auto_merge");
      expect(r.exitCode, `stderr:\n${r.stderr}\nstdout:\n${plain}`).toBe(0);
    } finally {
      stub.cleanup();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("ruleset DETAIL unreadable → [local-env] could-not-verify, not a false 'no ruleset covers branch' block (#239)", () => {
    // Permission gap: listing rulesets succeeds but reading a ruleset's detail
    // requires repo-admin and 404s/403s. doctor must NOT collapse the empty
    // includes into a false "no ruleset covers branch 'main'" instance BLOCK —
    // it emits a could-not-verify warn for the ruleset and downgrades the
    // unmatched-branch finding to a could-not-verify warn (both [local-env]).
    // The tag ruleset detail stays readable, so this path alone introduces no
    // block-severity finding and the run exits 0.
    const stub = setupGhStub({ rulesetDetailFails: true });
    const cwd = mkdtempSync(join(tmpdir(), "flywheel-doctor-cwd-"));
    try {
      const r = runDoctor(stub.binDir, cwd);
      const plain = stripAnsi(r.stdout);
      // The ruleset detail read failed → a could-not-verify warn on [local-env].
      const rulesetLine = plain
        .split("\n")
        .find((l) =>
          l.includes("could not verify ruleset 1 — reading it requires repo-admin"),
        );
      expect(
        rulesetLine,
        "expected a could-not-verify finding for the unreadable ruleset detail",
      ).toBeDefined();
      expect(rulesetLine).toContain("[local-env]");
      // The unmatched branch downgrades to a could-not-verify warn on [local-env].
      const branchLine = plain
        .split("\n")
        .find((l) =>
          l.includes(
            "could not verify branch 'main' is covered by a ruleset — reading rulesets requires repo-admin",
          ),
        );
      expect(
        branchLine,
        "expected the downgraded could-not-verify branch-coverage finding",
      ).toBeDefined();
      expect(branchLine).toContain("[local-env]");
      // The false BLOCK must be gone entirely.
      expect(plain).not.toContain("no ruleset covers branch 'main'");
      // could-not-verify is a warn, not a block — this path does not flip exit.
      expect(r.exitCode, `stderr:\n${r.stderr}\nstdout:\n${plain}`).toBe(0);
    } finally {
      stub.cleanup();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("readable ruleset details → coverage verified, no could-not-verify warn (regression guard) (#239)", () => {
    // Clean default stub (details readable): the generalized could-not-verify
    // path must stay dormant — branch + tag coverage verify exactly as before,
    // and NO "could not verify ruleset" / "could not verify branch" warn fires.
    const stub = setupGhStub();
    const cwd = mkdtempSync(join(tmpdir(), "flywheel-doctor-cwd-"));
    try {
      const r = runDoctor(stub.binDir, cwd);
      const plain = stripAnsi(r.stdout);
      expect(plain).toContain("branch 'main' protected, requires PRs");
      expect(plain).toContain("v* tag namespace protected");
      expect(plain).not.toContain("could not verify ruleset");
      expect(plain).not.toContain("could not verify branch");
      expect(r.exitCode, `stderr:\n${r.stderr}\nstdout:\n${plain}`).toBe(0);
    } finally {
      stub.cleanup();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("a block-severity finding → exit 1", () => {
    // Missing .flywheel.yml and missing rulesets are instance blocks.
    const stub = setupGhStub({ hasConfig: false, hasRulesets: false });
    const cwd = mkdtempSync(join(tmpdir(), "flywheel-doctor-cwd-"));
    try {
      const r = runDoctor(stub.binDir, cwd);
      const plain = stripAnsi(r.stdout);
      expect(r.exitCode, `stdout:\n${plain}\nstderr:\n${r.stderr}`).toBe(1);
      expect(plain).toMatch(/FAIL/);
      // The summary attributes the failure to blocking finding(s).
      expect(plain).toMatch(/blocking finding/);
    } finally {
      stub.cleanup();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("zero block-severity findings → exit 0", () => {
    // Fully-clean stub: config present, branch + tag rulesets present,
    // workflows present, settings enabled. No findings fire at all, so the
    // run exits 0 with the all-clear summary. (If a future check made a
    // 100%-clean stub disproportionately costly we'd instead engineer the
    // smallest zero-block stub and assert the weaker exit-0 invariant — but
    // the full clean run is feasible here, so we use it.)
    const stub = setupGhStub();
    const cwd = mkdtempSync(join(tmpdir(), "flywheel-doctor-cwd-"));
    try {
      const r = runDoctor(stub.binDir, cwd);
      const plain = stripAnsi(r.stdout);
      expect(r.exitCode, `stdout:\n${plain}\nstderr:\n${r.stderr}`).toBe(0);
      // No blocking-finding summary line.
      expect(plain).not.toMatch(/FAIL/);
    } finally {
      stub.cleanup();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("is read-only — writes nothing into the cwd it runs from", () => {
    // doctor is documented read-only. Run it against the remote REPO arg
    // from an empty temp dir and assert the dir is still empty afterward.
    const stub = setupGhStub();
    const cwd = mkdtempSync(join(tmpdir(), "flywheel-doctor-cwd-"));
    try {
      const before = readdirSync(cwd);
      expect(before).toEqual([]);
      runDoctor(stub.binDir, cwd);
      const after = readdirSync(cwd);
      expect(after, `doctor wrote into its cwd: ${after.join(", ")}`).toEqual([]);
    } finally {
      stub.cleanup();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
