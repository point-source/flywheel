import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
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
  /** If true, models a MIXED branch-ruleset permission gap: a READABLE branch
   * ruleset (id 1) covers main but carries NO pull_request rule, while a SECOND
   * branch ruleset (id 3) — which could supply the PR requirement — is unreadable
   * (its detail exits non-zero). With this combination the branch is matched
   * (pr_required stays 0) AND a detail read failed, so doctor must downgrade the
   * "no pull_request requirement" finding to a could-not-verify warn rather than
   * a false `fail instance` block (#239). The tag ruleset (id 2) stays readable,
   * so this path introduces no block-severity finding and the run exits 0. */
  branchPrUnreadable?: boolean;
  /** If true, `gh repo view` prints `${REPO}` instead of nothing, so doctor's
   * cwd-detection sets `cwd_repo == REPO` → `remote_only=0` (the LOCAL path).
   * That unlocks doctor's local-only sections — notably the .gitattributes
   * merge-driver scan (gated on `remote_only -eq 0 && -n "$yml"`). Default
   * false keeps every existing test on the remote path (stub emits nothing),
   * byte-for-byte unchanged. */
  localRepo?: boolean;
  /** Controls the `repos/<REPO>/actions/variables` LIST call that doctor's
   * App-token credential block (§spec:doctor-credential-clarity, #237) uses to
   * verify FLYWHEEL_GH_APP_ID. Three states:
   *   - "present"   → list succeeds and includes FLYWHEEL_GH_APP_ID
   *                   (→ ok "variable set (repo)").
   *   - "absent"    → list succeeds but is empty
   *                   (→ fail config "variable missing": a BLOCK).
   *   - "forbidden" → list call exits non-zero, modelling an under-scoped local
   *                   token that cannot list variables
   *                   (→ warn local-env "could not verify …": NOT a block).
   * Default "present" so the credential block (only reached when doctor runs
   * WITHOUT --skip-credentials) is clean; existing tests pass --skip-credentials
   * and never reach this arm, so any default leaves them unchanged. */
  credVarList?: "present" | "absent" | "forbidden";
  /** Mirror of credVarList for the `repos/<REPO>/actions/secrets` LIST call,
   * which verifies FLYWHEEL_GH_APP_PRIVATE_KEY. The "present"/"absent" JSON
   * deliberately omits any GH_PAT entry so the unrelated GH_PAT-leftover warn
   * never fires and muddies credential assertions. Default "present". */
  credSecretList?: "present" | "absent" | "forbidden";
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
    branchPrUnreadable = false,
    localRepo = false,
    credVarList = "present",
    credSecretList = "present",
  } = opts;

  // Map each credential-list knob to the stub's case-arm body for
  // repos/<REPO>/actions/{variables,secrets}. "forbidden" exits non-zero (the
  // list call failed → could-not-verify), "present"/"absent" succeed with a
  // populated/empty list. The success JSON omits GH_PAT so no unrelated warn
  // fires (see credSecretList doc).
  const listArm = (
    kind: "variables" | "secrets",
    name: string,
    state: "present" | "absent" | "forbidden",
  ): string =>
    state === "forbidden"
      ? "exit 1"
      : state === "present"
        ? `printf '%s\\n' '{"${kind}":[{"name":"${name}"}]}'`
        : `printf '%s\\n' '{"${kind}":[]}'`;
  const varListArm = listArm("variables", "FLYWHEEL_GH_APP_ID", credVarList);
  const secretListArm = listArm("secrets", "FLYWHEEL_GH_APP_PRIVATE_KEY", credSecretList);

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
  // rule, plus one tag ruleset (id 2) covering refs/tags/v*. When
  // branchPrUnreadable is set, a second branch ruleset (id 3) is added whose
  // detail is unreadable (see the stub below), and id 1 drops its PR rule so
  // the only possible PR requirement lives in the unreadable ruleset.
  const rulesetsList = JSON.stringify(
    branchPrUnreadable
      ? [
          { id: 1, target: "branch" },
          { id: 3, target: "branch" },
          { id: 2, target: "tag" },
        ]
      : [
          { id: 1, target: "branch" },
          { id: 2, target: "tag" },
        ],
  );
  const branchRulesetDetail = JSON.stringify({
    conditions: { ref_name: { include: ["refs/heads/main"] } },
    rules: branchPrUnreadable ? [] : [{ type: "pull_request" }],
  });
  const tagRulesetDetail = JSON.stringify({
    conditions: { ref_name: { include: ["refs/tags/v*"] } },
    rules: [],
  });

  const stub = `#!/usr/bin/env bash
# Stubbed gh — answers only the api paths doctor.sh hits.
sub="$1"

if [[ "$sub" == "repo" ]]; then
  ${
    localRepo
      ? `# 'gh repo view …' — print REPO so cwd_repo == REPO → remote_only=0
  # (LOCAL path), unlocking doctor's local-only .gitattributes scan.
  printf '%s\\n' "${REPO}"
  exit 0`
      : `# 'gh repo view …' — emit nothing so doctor falls back to its REPO arg
  # and treats the run as remote_only.
  exit 0`
  }
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
  "repos/${REPO}/rulesets/3")
    # Second branch ruleset, present only when branchPrUnreadable is set. Its
    # detail is repo-admin-gated and 404s — it is the ruleset that *would* carry
    # the pull_request requirement, so doctor must report could-not-verify
    # rather than a false "no pull_request requirement" block (#239).
    exit 1
    ;;
  "repos/${REPO}/actions/variables")
    # App-token credential block (#237): FLYWHEEL_GH_APP_ID variable LIST.
    # forbidden→exit 1 (could-not-verify warn); present→populated; absent→empty.
    ${varListArm}
    ;;
  "repos/${REPO}/actions/secrets")
    # App-token credential block (#237): FLYWHEEL_GH_APP_PRIVATE_KEY secret LIST.
    # Same three states as variables; JSON omits GH_PAT so no leftover warn.
    ${secretListArm}
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

/** Run doctor.sh against REPO with the given stub, from a throwaway cwd. By
 * default passes --skip-credentials so the App-token credential block is not
 * exercised (the stub stays small); pass { skipCredentials: false } to run that
 * block — the §spec:doctor-credential-clarity (#237) path that hits the
 * repos/<REPO>/actions/{variables,secrets} stub arms. */
function runDoctor(
  binDir: string,
  cwd: string,
  extraArgs: string[] = [],
  {
    skipCredentials = true,
    summaryFile,
  }: { skipCredentials?: boolean; summaryFile?: string } = {},
): RunResult {
  const flags = skipCredentials ? ["--skip-credentials"] : [];
  // GITHUB_STEP_SUMMARY is scrubbed from the child env by default: when this
  // suite itself runs inside GitHub Actions, process.env.GITHUB_STEP_SUMMARY is
  // set, which would otherwise make WS1's step-summary affordance fire for EVERY
  // test — polluting the real Actions step summary and making the run
  // non-hermetic. Setting it to undefined drops it from the spawned env, so the
  // affordance only fires when a test opts in via `summaryFile` (which points
  // GITHUB_STEP_SUMMARY at a caller-owned temp path).
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    GITHUB_STEP_SUMMARY: summaryFile,
  };
  const r = spawnSync("bash", [scriptPath, ...flags, ...extraArgs, REPO], {
    cwd,
    env,
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

  it("matched branch, PR rule only in an unreadable ruleset → could-not-verify, not a false 'no pull_request requirement' block (#239)", () => {
    // Mixed permission gap: a READABLE branch ruleset covers main but has no PR
    // rule, while a SECOND branch ruleset that could supply the PR requirement
    // is unreadable. The branch is matched (so the "no ruleset covers branch"
    // arm does not apply) yet pr_required stays 0 — doctor must downgrade the
    // "no pull_request requirement" finding to a could-not-verify warn instead
    // of a false instance BLOCK, since the unread ruleset may carry the rule.
    const stub = setupGhStub({ branchPrUnreadable: true });
    const cwd = mkdtempSync(join(tmpdir(), "flywheel-doctor-cwd-"));
    try {
      const r = runDoctor(stub.binDir, cwd);
      const plain = stripAnsi(r.stdout);
      const prLine = plain
        .split("\n")
        .find((l) =>
          l.includes(
            "could not verify branch 'main' pull_request requirement — reading rulesets requires repo-admin",
          ),
        );
      expect(
        prLine,
        "expected the downgraded could-not-verify pull_request-requirement finding",
      ).toBeDefined();
      expect(prLine).toContain("[local-env]");
      // The false BLOCK must be gone entirely.
      expect(plain).not.toContain("no pull_request requirement");
      // could-not-verify is a warn, not a block — exit stays 0.
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

// --summary mode (SPEC.md §spec:setup-auto-validation, WS1). The read-only seam
// init.sh consumes: doctor still emits every finding through the shared `finding`
// vocabulary (glyph + [<bucket>] label intact) but drops all decoration —
// no bold section headers, no green ok lines, no FAIL/OK summary block — and
// prints a single machine-readable trailer as its LAST line:
//   DOCTOR_RESULT blocks=<n> warns=<m>
// Exit contract is unchanged (1 iff a block fired, else 0).
describe.skipIf(!depsAvailable)("doctor.sh — --summary mode (machine seam)", () => {
  /** Parse the trailing DOCTOR_RESULT line out of summary-mode stdout. */
  function parseTrailer(plain: string): { last: string; blocks: number; warns: number } {
    const lines = plain.split("\n").filter((l) => l.length > 0);
    const last = lines[lines.length - 1] ?? "";
    const m = last.match(/^DOCTOR_RESULT blocks=(\d+) warns=(\d+)$/);
    expect(m, `last line was not a DOCTOR_RESULT trailer: ${JSON.stringify(last)}`).not.toBeNull();
    return { last, blocks: Number(m![1]), warns: Number(m![2]) };
  }

  it("suppresses headers and ok lines but keeps findings + emits the trailer", () => {
    // allow_auto_merge disabled (a [config] warn) and no rulesets (instance
    // blocks): findings of both severities fire, so we can prove they survive.
    const stub = setupGhStub({ allowAutoMerge: false, hasRulesets: false });
    const cwd = mkdtempSync(join(tmpdir(), "flywheel-doctor-cwd-"));
    try {
      const r = runDoctor(stub.binDir, cwd, ["--summary"]);
      const plain = stripAnsi(r.stdout);

      // No section-header decoration and no green ok lines.
      expect(plain).not.toContain("Flywheel doctor — ");
      expect(plain).not.toContain(".flywheel.yml");
      expect(plain).not.toContain("✓");
      // No human FAIL/OK summary block.
      expect(plain).not.toMatch(/FAIL/);
      expect(plain).not.toMatch(/OK with warnings/);
      expect(plain).not.toMatch(/all checks pass/);

      // Findings still render with their bucket labels.
      expect(plain).toContain("[config]");
      expect(plain).toContain("[instance]");

      // The last line is the machine trailer, and its counts match the run.
      const { blocks, warns } = parseTrailer(plain);
      expect(blocks).toBeGreaterThan(0);
      expect(warns).toBeGreaterThan(0);
      // A block fired → exit 1 (findings_exit_code is 1 iff blocks>0).
      expect(r.exitCode, `stdout:\n${plain}\nstderr:\n${r.stderr}`).toBe(1);
    } finally {
      stub.cleanup();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("zero blocks → trailer blocks=0 and exit 0", () => {
    // Fully-clean stub: no findings at all. Trailer reports blocks=0 warns=0.
    const stub = setupGhStub();
    const cwd = mkdtempSync(join(tmpdir(), "flywheel-doctor-cwd-"));
    try {
      const r = runDoctor(stub.binDir, cwd, ["--summary"]);
      const plain = stripAnsi(r.stdout);
      const { blocks, warns } = parseTrailer(plain);
      expect(blocks).toBe(0);
      expect(warns).toBe(0);
      expect(r.exitCode, `stdout:\n${plain}\nstderr:\n${r.stderr}`).toBe(0);
      // Still no decoration even on a clean run.
      expect(plain).not.toContain("✓");
      expect(plain).not.toMatch(/all checks pass/);
    } finally {
      stub.cleanup();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("a warn-only run → trailer blocks=0 warns>0 and exit 0", () => {
    // allow_auto_merge disabled is the only finding (config + warn). The exit
    // code stays 0 because no block fired; the trailer records the warn.
    const stub = setupGhStub({ allowAutoMerge: false });
    const cwd = mkdtempSync(join(tmpdir(), "flywheel-doctor-cwd-"));
    try {
      const r = runDoctor(stub.binDir, cwd, ["--summary"]);
      const plain = stripAnsi(r.stdout);
      const { blocks, warns } = parseTrailer(plain);
      expect(blocks).toBe(0);
      expect(warns).toBeGreaterThan(0);
      expect(r.exitCode, `stdout:\n${plain}\nstderr:\n${r.stderr}`).toBe(0);
    } finally {
      stub.cleanup();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("is read-only in --summary mode — writes nothing into its cwd", () => {
    const stub = setupGhStub({ allowAutoMerge: false, hasRulesets: false });
    const cwd = mkdtempSync(join(tmpdir(), "flywheel-doctor-cwd-"));
    try {
      const before = readdirSync(cwd);
      expect(before).toEqual([]);
      runDoctor(stub.binDir, cwd, ["--summary"]);
      const after = readdirSync(cwd);
      expect(after, `doctor wrote into its cwd: ${after.join(", ")}`).toEqual([]);
    } finally {
      stub.cleanup();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// Run a sibling-less COPY of doctor.sh, modelling the documented
// `curl -fsSL …/doctor.sh | bash` path where nothing of flywheel is on disk.
// We copy ONLY doctor.sh + the linter into a throwaway dir and deliberately
// omit `lib/findings.sh`, so doctor's single invocation-mode seam reads
// "no on-disk siblings" (doctor_local=0) and both its findings.sh fetch AND
// its recommended-fix remediation take the network/curl path. FLYWHEEL_TEMPLATES_BASE
// is pointed at the repo's own scripts/templates via a `file://` URL so the
// findings.sh fetch resolves locally — the test never touches the network or
// the rate-limited e2e sandbox (§spec:sandbox-test-budget, §req:sandbox-ci-budget),
// and the same base flows into the emitted curl remediation URL, which lets us
// assert the fix URL honors the configured ref rather than hard-coding `main`.
function runDoctorNoSiblings(
  binDir: string,
  cwd: string,
  templatesBase: string,
): RunResult {
  const isolated = mkdtempSync(join(tmpdir(), "flywheel-doctor-curl-"));
  try {
    const isolatedScript = join(isolated, "doctor.sh");
    copyFileSync(scriptPath, isolatedScript);
    // Copy the linter as a sibling so its own (separate) lookup resolves
    // locally too — keeping the run fully offline — while findings.sh stays
    // absent so the invocation-mode seam still reports the curl path.
    copyFileSync(
      join(repoRoot, "scripts/lint-flywheel-config.py"),
      join(isolated, "lint-flywheel-config.py"),
    );
    const r = spawnSync("bash", [isolatedScript, "--skip-credentials", REPO], {
      cwd,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        FLYWHEEL_TEMPLATES_BASE: templatesBase,
      },
      encoding: "utf8",
    });
    return { exitCode: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }
}

describe.skipIf(!depsAvailable)(
  "doctor.sh — apply-rulesets remediation matches invocation mode (#238)",
  () => {
    // We use the "no branch rulesets defined" finding (hasRulesets:false) as a
    // representative apply-rulesets remediation site; all six route through the
    // same fix_script_cmd helper.
    const findRulesetsLine = (plain: string): string | undefined =>
      plain.split("\n").find((l) => l.includes("no branch rulesets defined"));

    it("checkout mode (on-disk siblings) → local scripts/ path WITH --app-id, no curl", () => {
      // runDoctor invokes the real scripts/doctor.sh, so lib/findings.sh is on
      // disk → doctor_local=1 → remediation is the local path form.
      const stub = setupGhStub({ hasRulesets: false });
      const cwd = mkdtempSync(join(tmpdir(), "flywheel-doctor-cwd-"));
      try {
        const r = runDoctor(stub.binDir, cwd);
        const plain = stripAnsi(r.stdout);
        const line = findRulesetsLine(plain);
        expect(line, `expected a no-rulesets finding\n${plain}`).toBeDefined();
        // Local path, complete with the App-ID flag the script requires and the
        // resolved repo target — not the bare path that omitted --app-id before.
        expect(line).toContain("scripts/apply-rulesets.sh");
        expect(line).toContain("--app-id <your-app-id>");
        expect(line).toContain(REPO);
        // A checkout user is NOT pushed to re-download a script they already have.
        expect(line).not.toContain("curl");
      } finally {
        stub.cleanup();
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    it("curl mode (no on-disk siblings) → network curl form honoring the configured ref, not main", () => {
      const stub = setupGhStub({ hasRulesets: false });
      const cwd = mkdtempSync(join(tmpdir(), "flywheel-doctor-cwd-"));
      // file:// base = the repo's own templates dir; %/templates → …/scripts, so
      // both findings.sh and the emitted apply-rulesets URL resolve against it.
      const templatesBase = `file://${repoRoot}/scripts/templates`;
      const expectedBase = `file://${repoRoot}/scripts`;
      try {
        const r = runDoctorNoSiblings(stub.binDir, cwd, templatesBase);
        const plain = stripAnsi(r.stdout);
        const line = findRulesetsLine(plain);
        expect(
          line,
          `expected a no-rulesets finding under curl mode\nexit=${r.exitCode}\nstdout:\n${plain}\nstderr:\n${r.stderr}`,
        ).toBeDefined();
        // The paste-able network one-liner: fetch the named script and run it.
        expect(line).toContain(`curl -fsSL ${expectedBase}/apply-rulesets.sh`);
        expect(line).toContain("| bash -s --");
        // Same arguments the local form carries.
        expect(line).toContain("--app-id <your-app-id>");
        expect(line).toContain(REPO);
        // Version-consistency: the URL resolves against the configured base
        // (here the file:// pin), NOT a hard-coded github.com/.../main path.
        expect(line).not.toContain("raw.githubusercontent.com");
        expect(line).not.toContain("/main/");
      } finally {
        stub.cleanup();
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  },
);

describe.skipIf(!depsAvailable)(
  "doctor.sh — .gitattributes/init.sh remediation matches invocation mode (#238)",
  () => {
    // The .gitattributes merge-driver scan is doctor's local-only section 8,
    // gated on `remote_only -eq 0 && -n "$yml"`. To exercise it we drive doctor
    // into LOCAL mode: localRepo:true makes `gh repo view` print REPO so
    // cwd_repo == REPO → remote_only=0, and a local .flywheel.yml sets $yml.
    // With .gitattributes ABSENT, the representative ".gitattributes missing"
    // finding fires, routing through fix_script_cmd init.sh — the converted
    // remediation site we want to pin across invocation modes.
    const setupLocalCwd = (): string => {
      const cwd = mkdtempSync(join(tmpdir(), "flywheel-doctor-cwd-"));
      // $yml: a valid config on disk so doctor's local branch sets
      // yml=".flywheel.yml" and section 8 runs (the config also validates
      // against the linter, which is on disk / copied as a sibling).
      writeFileSync(join(cwd, ".flywheel.yml"), SINGLE_BRANCH_YAML);
      // Leave .gitattributes ABSENT so the missing-file finding fires.
      return cwd;
    };

    const findGitattributesLine = (plain: string): string | undefined =>
      plain.split("\n").find((l) => l.includes(".gitattributes missing"));

    it("checkout mode (on-disk siblings) → local scripts/init.sh path, no curl", () => {
      // runDoctor invokes the real scripts/doctor.sh, so lib/findings.sh is on
      // disk → doctor_local=1 → remediation is the local path form.
      const stub = setupGhStub({ localRepo: true });
      const cwd = setupLocalCwd();
      try {
        const r = runDoctor(stub.binDir, cwd);
        const plain = stripAnsi(r.stdout);
        const line = findGitattributesLine(plain);
        expect(
          line,
          `expected a .gitattributes-missing finding\nexit=${r.exitCode}\nstdout:\n${plain}\nstderr:\n${r.stderr}`,
        ).toBeDefined();
        // A checkout user re-runs the script they already have, by local path.
        expect(line).toContain("scripts/init.sh");
        expect(line).not.toContain("curl");
      } finally {
        stub.cleanup();
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    it("curl mode (no on-disk siblings) → network curl form honoring the configured ref, not main", () => {
      const stub = setupGhStub({ localRepo: true });
      const cwd = setupLocalCwd();
      // file:// base = the repo's own templates dir; %/templates → …/scripts, so
      // both findings.sh and the emitted init.sh URL resolve against it.
      const templatesBase = `file://${repoRoot}/scripts/templates`;
      const expectedBase = `file://${repoRoot}/scripts`;
      try {
        const r = runDoctorNoSiblings(stub.binDir, cwd, templatesBase);
        const plain = stripAnsi(r.stdout);
        const line = findGitattributesLine(plain);
        expect(
          line,
          `expected a .gitattributes-missing finding under curl mode\nexit=${r.exitCode}\nstdout:\n${plain}\nstderr:\n${r.stderr}`,
        ).toBeDefined();
        // The paste-able network one-liner: fetch the named script and run it.
        expect(line).toContain(`curl -fsSL ${expectedBase}/init.sh`);
        expect(line).toContain("| bash");
        // Version-consistency: the URL resolves against the configured base
        // (here the file:// pin), NOT a hard-coded github.com/.../main path.
        expect(line).not.toContain("raw.githubusercontent.com");
        expect(line).not.toContain("/main/");
      } finally {
        stub.cleanup();
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  },
);

// App-token credential clarity (§spec:doctor-credential-clarity, #237). For each
// of FLYWHEEL_GH_APP_ID (a Variable) and FLYWHEEL_GH_APP_PRIVATE_KEY (a Secret),
// doctor distinguishes four outcomes when run WITHOUT --skip-credentials:
//   - verified-present → ok "… set (repo)"
//   - skipped          → note (covered by the --skip-credentials default path)
//   - could-not-verify → warn local-env "could not verify …" (the LIST call
//                        exited non-zero — an under-scoped local token, NOT a
//                        defect in the repo). This is a WARN → exit 0.
//   - genuinely-missing→ fail config "… missing" (the LIST succeeded but the
//                        name is absent). This is a BLOCK → exit 1.
// These tests drive doctor with { skipCredentials: false } so the block runs,
// and pin that could-not-verify never collapses into a false "missing" block.
describe.skipIf(!depsAvailable)("doctor.sh — App-token credential clarity (#237)", () => {
  it("could-not-verify → [local-env] warn, exit 0 (regression guard)", () => {
    // Under-scoped local token: both the variable and secret LIST calls exit
    // non-zero. doctor must surface could-not-verify warns — NOT "missing"
    // blocks — and exit 0, proving an under-scoped run no longer falsely reports
    // the repo broken.
    const stub = setupGhStub({ credVarList: "forbidden", credSecretList: "forbidden" });
    const cwd = mkdtempSync(join(tmpdir(), "flywheel-doctor-cwd-"));
    try {
      const r = runDoctor(stub.binDir, cwd, [], { skipCredentials: false });
      const plain = stripAnsi(r.stdout);

      // Both could-not-verify lines surface, each on a [local-env] warn line.
      const varLine = plain
        .split("\n")
        .find((l) => l.includes("could not verify FLYWHEEL_GH_APP_ID"));
      expect(varLine, "expected a could-not-verify line for the App-ID variable").toBeDefined();
      expect(varLine).toContain("[local-env]");
      const secretLine = plain
        .split("\n")
        .find((l) => l.includes("could not verify FLYWHEEL_GH_APP_PRIVATE_KEY"));
      expect(
        secretLine,
        "expected a could-not-verify line for the App private-key secret",
      ).toBeDefined();
      expect(secretLine).toContain("[local-env]");

      // No false "missing" claim for either credential.
      expect(plain).not.toContain("variable missing");
      expect(plain).not.toContain("secret missing");

      // A could-not-verify warn is not a block — the run exits 0.
      expect(r.exitCode, `stderr:\n${r.stderr}\nstdout:\n${plain}`).toBe(0);
    } finally {
      stub.cleanup();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("genuinely-missing → [config] block, exit 1", () => {
    // Both LIST calls succeed but are empty: the credentials really are absent.
    // doctor must emit "missing" blocks (with the gh remediation) on [config],
    // and the block flips the exit code to 1.
    const stub = setupGhStub({ credVarList: "absent", credSecretList: "absent" });
    const cwd = mkdtempSync(join(tmpdir(), "flywheel-doctor-cwd-"));
    try {
      const r = runDoctor(stub.binDir, cwd, [], { skipCredentials: false });
      const plain = stripAnsi(r.stdout);

      // The App-ID variable is reported missing, with the gh-variable-set fix.
      const varLine = plain
        .split("\n")
        .find((l) => l.includes("FLYWHEEL_GH_APP_ID variable missing"));
      expect(varLine, "expected a 'variable missing' block for the App ID").toBeDefined();
      expect(varLine).toContain("[config]");
      expect(varLine).toContain("gh variable set FLYWHEEL_GH_APP_ID");

      // The App private-key secret is reported missing too.
      const secretLine = plain
        .split("\n")
        .find((l) => l.includes("FLYWHEEL_GH_APP_PRIVATE_KEY secret missing"));
      expect(secretLine, "expected a 'secret missing' block for the App key").toBeDefined();
      expect(secretLine).toContain("[config]");

      // Neither should masquerade as a could-not-verify warn.
      expect(plain).not.toContain("could not verify FLYWHEEL_GH_APP_ID");
      expect(plain).not.toContain("could not verify FLYWHEEL_GH_APP_PRIVATE_KEY");

      // A real block fired → exit 1.
      expect(r.exitCode, `stderr:\n${r.stderr}\nstdout:\n${plain}`).toBe(1);
    } finally {
      stub.cleanup();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("verified-present → ok lines, no credential warn/block, exit 0", () => {
    // Both LIST calls succeed and include the credential names: doctor verifies
    // each at the repo level and emits ok lines, with no could-not-verify or
    // missing finding. The rest of the default stub is clean, so the run exits 0.
    const stub = setupGhStub({ credVarList: "present", credSecretList: "present" });
    const cwd = mkdtempSync(join(tmpdir(), "flywheel-doctor-cwd-"));
    try {
      const r = runDoctor(stub.binDir, cwd, [], { skipCredentials: false });
      const plain = stripAnsi(r.stdout);

      expect(plain).toContain("FLYWHEEL_GH_APP_ID variable set (repo)");
      expect(plain).toContain("FLYWHEEL_GH_APP_PRIVATE_KEY secret set (repo)");

      // No could-not-verify and no missing finding for either credential.
      expect(plain).not.toContain("could not verify FLYWHEEL_GH_APP_ID");
      expect(plain).not.toContain("could not verify FLYWHEEL_GH_APP_PRIVATE_KEY");
      expect(plain).not.toContain("variable missing");
      expect(plain).not.toContain("secret missing");

      // Otherwise clean → exit 0.
      expect(r.exitCode, `stderr:\n${r.stderr}\nstdout:\n${plain}`).toBe(0);
    } finally {
      stub.cleanup();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// CI-invocation contract (SPEC.md §spec:doctor-ci-workflow). The flywheel-doctor
// CI workflow checks out the adopter repo and invokes doctor against it with
// --skip-credentials (the App-token mint upstream is the credential proof).
// These guards lock the observable contract #240-2 depends on:
//   1. when the target IS the checked-out repo (remote_only==0) doctor runs its
//      on-disk checks, not just the API checks;
//   2. --skip-credentials reports a NON-FATAL info skip note, never a failure;
//   3. doctor stays read-only under that invocation — nothing under cwd, and
//      with the step-summary affordance active the ONLY write is the external
//      $GITHUB_STEP_SUMMARY file;
//   4. exit is 1 ONLY on a block-severity finding (warn / could-not-verify stay
//      green).
// Where the same behavior is already pinned elsewhere in this file we note it
// rather than duplicate it.
describe.skipIf(!depsAvailable)("doctor.sh — CI-invocation contract (#240)", () => {
  // Contract bullet 1: on-disk checks run when target == checked-out repo.
  // localRepo:true makes `gh repo view` print REPO → cwd_repo == REPO →
  // remote_only=0, the LOCAL path, which unlocks the on-disk .gitattributes /
  // merge-driver scan (gated on `remote_only -eq 0 && -n "$yml"`). A local
  // .flywheel.yml sets $yml; .gitattributes is left absent so the on-disk
  // ".gitattributes missing" finding fires. We then prove that SAME finding does
  // NOT appear on the remote path (localRepo:false), so it can only have come
  // from the on-disk section a self-checkout CI run reaches.
  it("on-disk checks run when target == checked-out repo (a local-only finding appears that the remote path lacks)", () => {
    const localStub = setupGhStub({ localRepo: true });
    const localCwd = mkdtempSync(join(tmpdir(), "flywheel-doctor-cwd-"));
    writeFileSync(join(localCwd, ".flywheel.yml"), SINGLE_BRANCH_YAML);
    const remoteStub = setupGhStub({ localRepo: false });
    const remoteCwd = mkdtempSync(join(tmpdir(), "flywheel-doctor-cwd-"));
    try {
      const local = stripAnsi(runDoctor(localStub.binDir, localCwd).stdout);
      const remote = stripAnsi(runDoctor(remoteStub.binDir, remoteCwd).stdout);
      // The on-disk merge-driver scan ran on the local (self-checkout) path.
      expect(
        local,
        `expected the on-disk .gitattributes scan to run on the local path\n${local}`,
      ).toContain(".gitattributes missing");
      // …and did NOT run on the remote-only path — proving it is genuinely the
      // on-disk section, not an API check that fires everywhere.
      expect(
        remote,
        "the .gitattributes scan must be skipped on the remote-only path",
      ).not.toContain(".gitattributes missing");
    } finally {
      localStub.cleanup();
      rmSync(localCwd, { recursive: true, force: true });
      remoteStub.cleanup();
      rmSync(remoteCwd, { recursive: true, force: true });
    }
  });

  // Contract bullet 2: --skip-credentials → a NON-FATAL info skip note, not a
  // failure. The default runDoctor passes --skip-credentials; on an otherwise
  // clean stub the skip note must be an INFO finding (glyph 'i', carries
  // [config], NOT a block) and the run must exit 0. (No existing test asserts
  // the skip-note line itself — App-token clarity tests run with
  // skipCredentials:false and never reach this arm.)
  it("--skip-credentials → a non-fatal [config] info skip note, exit 0", () => {
    const stub = setupGhStub();
    const cwd = mkdtempSync(join(tmpdir(), "flywheel-doctor-cwd-"));
    try {
      const r = runDoctor(stub.binDir, cwd); // --skip-credentials is the default
      const plain = stripAnsi(r.stdout);
      const skipLine = plain
        .split("\n")
        .find((l) => l.includes("skipped (--skip-credentials)"));
      expect(skipLine, `expected a --skip-credentials skip note\n${plain}`).toBeDefined();
      // It is an info note on [config] — not a block, and not a "missing" claim.
      expect(skipLine).toContain("[config]");
      expect(plain).not.toContain("variable missing");
      expect(plain).not.toContain("secret missing");
      // The skip is non-fatal — the otherwise-clean run exits 0.
      expect(r.exitCode, `stderr:\n${r.stderr}\nstdout:\n${plain}`).toBe(0);
      expect(plain).not.toMatch(/FAIL/);
    } finally {
      stub.cleanup();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  // Contract bullet 3: read-only under the CI invocation. The remote-path
  // read-only guarantee is already covered (the "is read-only — writes nothing
  // into the cwd" test and the --summary variant); add the LOCAL (self-checkout)
  // path, which runs more on-disk sections, and prove that when the
  // step-summary affordance is active the ONLY thing written is the EXTERNAL
  // $GITHUB_STEP_SUMMARY file — never anything under cwd.
  it("is read-only on the local (self-checkout) path, even with the step summary active", () => {
    const stub = setupGhStub({ localRepo: true });
    const cwd = mkdtempSync(join(tmpdir(), "flywheel-doctor-cwd-"));
    // The only pre-existing entry is the config we seed; record it as baseline.
    writeFileSync(join(cwd, ".flywheel.yml"), SINGLE_BRANCH_YAML);
    const before = readdirSync(cwd).sort();
    // The step-summary sink lives OUTSIDE cwd so the read-only-cwd guarantee
    // holds even while the affordance fires.
    const ssDir = mkdtempSync(join(tmpdir(), "flywheel-doctor-ss-"));
    const summaryFile = join(ssDir, "summary.md");
    try {
      runDoctor(stub.binDir, cwd, [], { summaryFile });
      const after = readdirSync(cwd).sort();
      expect(after, `doctor wrote into its cwd: ${after.join(", ")}`).toEqual(before);
      // The affordance fired into the external sink — its only write.
      expect(existsSync(summaryFile), "expected the external summary file to be written").toBe(
        true,
      );
    } finally {
      stub.cleanup();
      rmSync(cwd, { recursive: true, force: true });
      rmSync(ssDir, { recursive: true, force: true });
    }
  });

  // Contract bullet 4: exit is red ONLY on a block. Pinned as a cohesive set.
  // block → exit 1 and warn-only → exit 0 are already asserted (the "a
  // block-severity finding → exit 1" / "allow_auto_merge:false …" /
  // "zero block-severity findings → exit 0" tests above); the could-not-verify →
  // exit 0 arm is also covered (admin-gated absent, unreadable rulesets, and the
  // credVarList:"forbidden" credential path). This guard re-pins the three arms
  // together so the exit contract reads as one unit, using minimal distinct
  // stubs and adding the combinations not already grouped.
  it("exit contract: block → 1, warn-only → 0, could-not-verify-only → 0", () => {
    // (a) A block-severity finding (missing config + missing rulesets) → exit 1.
    const blockStub = setupGhStub({ hasConfig: false, hasRulesets: false });
    const blockCwd = mkdtempSync(join(tmpdir(), "flywheel-doctor-cwd-"));
    // (b) A warn-only run (allow_auto_merge disabled, nothing else) → exit 0.
    const warnStub = setupGhStub({ allowAutoMerge: false });
    const warnCwd = mkdtempSync(join(tmpdir(), "flywheel-doctor-cwd-"));
    // (c) A could-not-verify-only run (admin-gated settings absent) → exit 0.
    const cnvStub = setupGhStub({ adminFieldsVisible: false });
    const cnvCwd = mkdtempSync(join(tmpdir(), "flywheel-doctor-cwd-"));
    try {
      const block = runDoctor(blockStub.binDir, blockCwd);
      expect(
        block.exitCode,
        `block run must exit 1\n${stripAnsi(block.stdout)}\n${block.stderr}`,
      ).toBe(1);
      expect(stripAnsi(block.stdout)).toMatch(/FAIL/);

      const warn = runDoctor(warnStub.binDir, warnCwd);
      const warnPlain = stripAnsi(warn.stdout);
      expect(warn.exitCode, `warn-only run must exit 0\n${warnPlain}\n${warn.stderr}`).toBe(0);
      expect(warnPlain).toMatch(/OK with warnings/);

      const cnv = runDoctor(cnvStub.binDir, cnvCwd);
      const cnvPlain = stripAnsi(cnv.stdout);
      expect(
        cnv.exitCode,
        `could-not-verify-only run must exit 0\n${cnvPlain}\n${cnv.stderr}`,
      ).toBe(0);
      // It is a could-not-verify (warn), never a block.
      expect(cnvPlain).toContain("could not verify allow_auto_merge");
      expect(cnvPlain).not.toMatch(/FAIL/);
    } finally {
      blockStub.cleanup();
      rmSync(blockCwd, { recursive: true, force: true });
      warnStub.cleanup();
      rmSync(warnCwd, { recursive: true, force: true });
      cnvStub.cleanup();
      rmSync(cnvCwd, { recursive: true, force: true });
    }
  });
});

// Step-summary affordance (WS1, SPEC.md §spec:doctor-ci-workflow). When
// $GITHUB_STEP_SUMMARY is set (only inside a GitHub Actions step) doctor appends
// an ANSI-free markdown rendering of its whole run to that file as a SECOND sink
// — stdout is unchanged. The markdown is a `## Flywheel doctor — <REPO>`
// heading, the captured run body inside a fenced code block, and a verdict line
// mirroring the local FAIL / "OK with warnings" / "OK — all checks pass" text.
// The summary sink is pointed at a temp file OUTSIDE the doctor cwd so the
// read-only-cwd guarantee is preserved.
describe.skipIf(!depsAvailable)("doctor.sh — step-summary affordance (#240, WS1)", () => {
  it("renders an ANSI-free markdown summary to $GITHUB_STEP_SUMMARY, stdout unchanged", () => {
    // A stub that produces findings of every kind: a [config] warn
    // (allow_auto_merge disabled) and [instance] blocks (no rulesets), so the
    // verdict is FAIL and at least one bracketed finding line is present in both
    // sinks.
    const stub = setupGhStub({ allowAutoMerge: false, hasRulesets: false });
    const cwd = mkdtempSync(join(tmpdir(), "flywheel-doctor-cwd-"));
    const ssDir = mkdtempSync(join(tmpdir(), "flywheel-doctor-ss-"));
    const summaryFile = join(ssDir, "summary.md");
    try {
      const r = runDoctor(stub.binDir, cwd, [], { summaryFile });
      const stdoutPlain = stripAnsi(r.stdout);

      // The summary file was written (outside cwd) and has the documented shape.
      expect(existsSync(summaryFile), "expected the step-summary file to be created").toBe(true);
      const summary = readFileSync(summaryFile, "utf8");

      // Heading naming the repo.
      expect(summary).toContain(`## Flywheel doctor — ${REPO}`);
      // The run body lives in a fenced code block.
      expect(summary, `summary had no fenced code block:\n${summary}`).toMatch(/```[\s\S]*```/);
      // Verdict line mirrors the local FAIL summary (a block fired here).
      expect(summary).toMatch(/FAIL — \d+ blocking finding\(s\), \d+ warning\(s\)/);

      // The markdown is ANSI-free — no raw escape sequences leak into the file.
      expect(summary.includes("\x1b["), "summary must not contain ANSI escapes").toBe(false);

      // The findings present in stdout are also present in the summary: a
      // bracketed finding line and the verdict both appear in both sinks.
      expect(summary).toContain("[config]");
      expect(summary).toContain("[instance]");
      expect(stdoutPlain).toContain("[config]");
      expect(stdoutPlain).toContain("[instance]");
      // A representative finding line carries through verbatim.
      const autoMergeLine = stdoutPlain
        .split("\n")
        .find((l) => l.includes("allow_auto_merge") && l.includes("disabled"))
        ?.trim();
      expect(autoMergeLine, "expected an allow_auto_merge finding in stdout").toBeDefined();
      expect(summary, "the stdout finding must also appear in the summary").toContain(
        autoMergeLine!,
      );
    } finally {
      stub.cleanup();
      rmSync(cwd, { recursive: true, force: true });
      rmSync(ssDir, { recursive: true, force: true });
    }
  });

  it("clean run → an 'OK — all checks pass' verdict in the summary", () => {
    // Verdict text varies by outcome; pin the all-clear form on a clean stub.
    const stub = setupGhStub();
    const cwd = mkdtempSync(join(tmpdir(), "flywheel-doctor-cwd-"));
    const ssDir = mkdtempSync(join(tmpdir(), "flywheel-doctor-ss-"));
    const summaryFile = join(ssDir, "summary.md");
    try {
      const r = runDoctor(stub.binDir, cwd, [], { summaryFile });
      expect(r.exitCode, `stderr:\n${r.stderr}`).toBe(0);
      const summary = readFileSync(summaryFile, "utf8");
      expect(summary).toContain(`## Flywheel doctor — ${REPO}`);
      expect(summary).toContain("OK — all checks pass");
      expect(summary.includes("\x1b["), "summary must not contain ANSI escapes").toBe(false);
    } finally {
      stub.cleanup();
      rmSync(cwd, { recursive: true, force: true });
      rmSync(ssDir, { recursive: true, force: true });
    }
  });

  it("GITHUB_STEP_SUMMARY unset (local default) → stdout byte-for-byte identical to a run with it set", () => {
    // The step-summary affordance is a SECOND sink only: turning it on (via
    // GITHUB_STEP_SUMMARY) must not change one byte of stdout. Prove it directly
    // by diffing stdout across an enabled run and the local-default (scrubbed)
    // run on the same stub + cwd, then confirm none of the summary-only markdown
    // leaks into the local-default stdout. (Comparing against a literal empty
    // temp dir proved nothing — doctor was never told that path.)
    const stub = setupGhStub({ allowAutoMerge: false, hasRulesets: false });
    const cwd = mkdtempSync(join(tmpdir(), "flywheel-doctor-cwd-"));
    const ssDir = mkdtempSync(join(tmpdir(), "flywheel-doctor-ss-"));
    const summaryFile = join(ssDir, "summary.md");
    try {
      const enabled = runDoctor(stub.binDir, cwd, [], { summaryFile });
      const localDefault = runDoctor(stub.binDir, cwd);
      // Byte-for-byte: the feature is invisible on stdout whether on or off.
      expect(localDefault.stdout).toBe(enabled.stdout);
      // The local default is still the normal decorated report (verdict + findings)...
      const plain = stripAnsi(localDefault.stdout);
      expect(plain).toContain("[config]");
      expect(plain).toContain("[instance]");
      expect(plain).toMatch(/FAIL/);
      // ...with no summary-only heading markdown leaking to stdout (it lives only
      // in the file sink).
      expect(plain).not.toContain("## Flywheel doctor");
      // Sanity: the enabled run really did write the second sink, so the diff
      // above compared an active-affordance run against the scrubbed one.
      expect(readFileSync(summaryFile, "utf8")).toContain(`## Flywheel doctor — ${REPO}`);
    } finally {
      stub.cleanup();
      rmSync(cwd, { recursive: true, force: true });
      rmSync(ssDir, { recursive: true, force: true });
    }
  });
});

