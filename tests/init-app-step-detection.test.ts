import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { stripAnsi } from "./helpers/ansi.js";
import { writeDoctorStub } from "./helpers/doctorStub.js";

// WS3 (#236) — proves scripts/init.sh's GitHub-App step CONSUMES the pre-flight
// pass's detected App/credentials instead of starting cold or re-probing gh
// (§spec:init-app-step tier 2). The reworked step presents what pre-flight found
// (PREFLIGHT_* globals) as a confirm-or-override default: confirm reuses the
// detection and fills only the missing piece; override wipes the locals and falls
// through to the cold create/paste/skip menu. This is TESTS ONLY — no production
// changes.
//
// Three layers of coverage, matching the three ways the step is reachable:
//
//   A. SOURCE-SLICE (always runs) — pins the confirm/override STRUCTURE and copy
//      by reading init.sh as text. These never execute init.sh, so they are
//      immune to the harness's INTERACTIVE gating.
//
//   B. RUNTIME NON-INTERACTIVE (executes init.sh to completion) — the stable
//      contract: backward-compat strings still print, greenfield still completes,
//      and crucially the App step adds ZERO extra credential lookups on top of the
//      single pre-flight pass (the reuse boundary, proven via a gh call log).
//
//   C. RUNTIME INTERACTIVE (executes init.sh under a real Python pty) — drives
//      the confirm/override/partial/org-level branches that live behind
//      `read -u 3`. A pty makes `[[ -t 0 ]]` true, so init sets INTERACTIVE=1 and
//      `exec 3<&0` wires fd 3 to the pty — the ONLY way to reach these branches at
//      runtime (the vitest spawn harness forces INTERACTIVE=0, and the
//      FLYWHEEL_ASSUME_INTERACTIVE hook flips INTERACTIVE but never opens fd 3).

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const initSh = join(repoRoot, "scripts/init.sh");
const source = readFileSync(initSh, "utf8");

// Args that scaffold a minimal config and skip rulesets so the run reaches the
// App-credentials step and then completes without a (network) ruleset apply.
const SCAFFOLD_ARGS = [
  "--preset",
  "minimal",
  "--version",
  "v0-app-step-test",
  "--skip-rulesets",
];

// A configurable `gh` stub — the init-preflight-credentials.test.ts stub, EXTENDED
// with a STUB_CALL_LOG seam: when set, every invocation appends its argv ("$*") to
// that file, so a test can prove the App step issues no duplicate credential reads
// beyond the single pre-flight pass. Branches are gated on STUB_* env vars; any
// unset branch exits 1, which the detector tolerates and models as absent/unknown.
//
//   STUB_OWNER_TYPE         Organization | User       (gh api users/<owner>)
//   STUB_REPO_VARS          newline list for repo `gh variable list`
//   STUB_REPO_SECRETS       newline list for repo `gh secret list`
//   STUB_ORG_VARS           newline list for org `gh variable list --org`
//   STUB_ORG_SECRETS        newline list for org `gh secret list --org`
//   STUB_REPO_APP_ID        value for repo `gh variable get`
//   STUB_ORG_APP_ID         value for org `gh variable get --org`
//   STUB_INSTALLED_APP_IDS  newline list for `gh api orgs/<owner>/installations`
//   STUB_CALL_LOG           if set, append every gh argv to this file
const GH_STUB = `#!/usr/bin/env bash
set -u

if [[ -n "\${STUB_CALL_LOG:-}" ]]; then printf '%s\n' "\$*" >> "\$STUB_CALL_LOG"; fi

emit_or_fail() { # $1 = value; print non-empty value (exit 0) else exit 1
  if [[ -n "\${1:-}" ]]; then printf '%s\n' "\$1"; exit 0; fi
  exit 1
}

if [[ "\${1:-}" == "auth" && "\${2:-}" == "status" ]]; then
  echo "  - Token scopes: 'repo', 'read:org'"; exit 0
fi

if [[ "\${1:-}" == "repo" && "\${2:-}" == "view" ]]; then
  echo "acme/widget"; exit 0
fi

if [[ "\${1:-}" == "api" ]]; then
  case "\${2:-}" in
    users/acme) emit_or_fail "\${STUB_OWNER_TYPE:-}";;
    orgs/acme/installations) emit_or_fail "\${STUB_INSTALLED_APP_IDS:-}";;
  esac
  exit 1
fi

if [[ "\${1:-}" == "variable" && "\${2:-}" == "list" ]]; then
  if [[ "\$*" == *"--org"* ]]; then emit_or_fail "\${STUB_ORG_VARS:-}"; fi
  emit_or_fail "\${STUB_REPO_VARS:-}"
fi

if [[ "\${1:-}" == "secret" && "\${2:-}" == "list" ]]; then
  if [[ "\$*" == *"--org"* ]]; then emit_or_fail "\${STUB_ORG_SECRETS:-}"; fi
  emit_or_fail "\${STUB_REPO_SECRETS:-}"
fi

if [[ "\${1:-}" == "variable" && "\${2:-}" == "get" ]]; then
  if [[ "\$*" == *"--org"* ]]; then emit_or_fail "\${STUB_ORG_APP_ID:-}"; fi
  emit_or_fail "\${STUB_REPO_APP_ID:-}"
fi

echo "stub gh: unhandled: \$*" >&2; exit 1
`;

const DOCTOR_STUB_REL = "doctor-stub.sh";

/** Create a fresh git-init'd temp work dir with the gh stub + green doctor stub on
 * a private bin/ dir. Returns { work, binDir, doctorStub }. Caller must rmSync(work). */
function makeWorkdir(): { work: string; binDir: string; doctorStub: string } {
  const work = mkdtempSync(join(tmpdir(), "flywheel-app-step-"));
  const binDir = join(work, "bin");
  mkdirSync(binDir);
  const gh = join(binDir, "gh");
  writeFileSync(gh, GH_STUB);
  chmodSync(gh, 0o755);
  // Green doctor stub: this suite exercises the App step, not end-of-run
  // validation, and the end-of-run exit contract (§spec:setup-exit-contract)
  // would otherwise flip a clean run non-zero on spurious doctor blocks.
  const doctorStub = writeDoctorStub(binDir, { blocks: 0, warns: 0 });
  execFileSync("git", ["init", "-q"], { cwd: work });
  return { work, binDir, doctorStub };
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  work: string;
}

/** Run init.sh NON-interactively (input: "") from a fresh work dir. */
function runInit(opts: { env?: Record<string, string> } = {}): RunResult {
  const { work, binDir, doctorStub } = makeWorkdir();
  const r = spawnSync("bash", [initSh, ...SCAFFOLD_ARGS], {
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

// ---------------------------------------------------------------------------
// A Python pty driver. init.sh's interactive prompts read from fd 3, which is
// only opened when INTERACTIVE=1 (i.e. `[[ -t 0 ]]` true → `exec 3<&0`). Under a
// real pty stdin is a tty, so fd 3 is the pty and `read -u 3` works — exactly the
// path a curl|bash adopter exercises. We fork a pty, exec `bash init.sh ...` with
// the gh + doctor stubs on PATH, feed newline-delimited answers, and capture the
// combined output. Inline Python keeps the helper self-contained (no extra files).
// ---------------------------------------------------------------------------
const PTY_DRIVER = String.raw`
import json, os, pty, re, select, sys, time

cfg = json.loads(sys.argv[1])
env = dict(os.environ)
env["PATH"] = cfg["bin"] + ":" + env.get("PATH", "")
env["FLYWHEEL_TEST_HOOKS"] = "1"
env["FLYWHEEL_DOCTOR_OVERRIDE"] = cfg["doctor"]
for k, v in cfg.get("stub", {}).items():
    env[k] = v

answers = cfg["answers"].encode()
argv = ["bash", cfg["init"]] + cfg["args"]

pid, fd = pty.fork()
if pid == 0:
    os.execvpe("bash", argv, env)

out = b""
sent = False
send_at = time.time() + 0.5
deadline = time.time() + 25
while time.time() < deadline:
    r, _, _ = select.select([fd], [], [], 0.3)
    if r:
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            break
        if not chunk:
            break
        out += chunk
    if not sent and time.time() >= send_at:
        os.write(fd, answers)
        sent = True
try:
    os.close(fd)
except OSError:
    pass
_, status = os.waitpid(pid, 0)
code = os.waitstatus_to_exitcode(status)
text = re.sub(r"\x1b\[[0-9;]*m", "", out.decode("utf-8", "replace"))
print(json.dumps({"exit": code, "out": text}))
`;

interface PtyResult {
  exit: number;
  out: string;
}

/** Drive init.sh under a real pty with the given keystroke `answers` (use "\n"
 * for Enter). Returns the captured exit code + ANSI-stripped combined output. */
function runInitPty(opts: {
  answers: string;
  stub?: Record<string, string>;
}): PtyResult {
  const { work, binDir, doctorStub } = makeWorkdir();
  try {
    const cfg = JSON.stringify({
      bin: binDir,
      doctor: doctorStub,
      init: initSh,
      args: SCAFFOLD_ARGS,
      answers: opts.answers,
      stub: opts.stub ?? {},
    });
    const r = spawnSync("python3", ["-c", PTY_DRIVER, cfg], {
      cwd: work,
      encoding: "utf8",
      timeout: 40000,
    });
    if (r.status !== 0 || !r.stdout) {
      throw new Error(
        `pty driver failed (status ${r.status}):\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
      );
    }
    // The driver prints exactly one JSON line (last line of stdout).
    const lines = r.stdout.trim().split("\n");
    const lastLine = lines[lines.length - 1] ?? "";
    const parsed = JSON.parse(lastLine) as PtyResult;
    return { exit: parsed.exit, out: stripAnsi(parsed.out) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ===========================================================================
// A. SOURCE-SLICE — confirm/override structure & copy (always runs)
// ===========================================================================
describe("init.sh App step — detected-credentials confirm/override (source-slice)", () => {
  it("introduces the detected summary before the confirm prompt", () => {
    // The intro line precedes app_step_render_detected's summary.
    expect(source).toContain("Pre-flight already found App credentials");
  });

  it("offers the confirm-or-override prompt", () => {
    expect(source).toContain("Use the detected credentials? [Y/n]");
  });

  it("keeps the detected credentials when nothing is missing", () => {
    expect(source).toContain("Keeping the detected credentials.");
  });

  it("defines and CALLS the read-only detected-summary renderer in the step", () => {
    expect(source).toContain("app_step_render_detected() {");
    // Invoked right after the intro line (consumes pre-flight, no re-probe).
    const introAt = source.indexOf("Pre-flight already found App credentials");
    const callAt = source.indexOf("app_step_render_detected\n", introAt);
    expect(callAt).toBeGreaterThan(introAt);
  });

  it("keeps detected creds only when BOTH pieces are present, else fills the missing one", () => {
    // The confirm branch decides keep-vs-fill straight off the has_app_id/has_app_key
    // locals; the per-piece prompting lives in prompt_existing_app_credentials.
    expect(source).toContain(
      'if [[ "$has_app_id" -eq 1 && "$has_app_key" -eq 1 ]]; then',
    );
  });

  it("override path clears the locals so the cold paste prompts for BOTH pieces", () => {
    expect(source).toContain("has_app_id=0; has_app_key=0");
  });

  it("guards the cold setup-path menu on app_step_resolved (skip it after confirm)", () => {
    expect(source).toContain(
      'if [[ "$INTERACTIVE" -eq 1 && -z "${app_step_resolved:-}" ]]; then',
    );
    expect(source).toContain("app_step_resolved=1");
  });

  it("confirm writes a missing piece without a cold scope prompt; a missing App ID goes to repo level", () => {
    // When the App ID is present, a missing key is written beside it (its level).
    expect(source).toContain('SCOPE="$app_id_found_at"');
    // When the App ID is the MISSING piece, it is written at repo level: a
    // repo-scoped variable never needs an admin:org token, so an under-scoped
    // adopter can finish. Inheriting the key's org level would force admin:org.
    expect(source).toContain('SCOPE="repo"');
    expect(source).not.toContain('SCOPE="$app_key_found_at"');
  });
});

// ===========================================================================
// A1. SOURCE-SLICE — org-App-not-installed install action & menu (WS1/WS2)
// ===========================================================================
// PREFLIGHT_APP_INSTALLED == "no" means: an org-level flywheel App ID is
// detected but is NOT installed on THIS repo, so its credentials exist yet its
// tokens cannot mint for the repo. WS1/WS2 added a guided "install the existing
// App on this repo" action: a 3-option menu interactively, and a print-the-
// manual-finish-command + defer outcome non-interactively. These slices pin the
// literal copy/structure of that action (immune to INTERACTIVE gating).
describe("init.sh App step — org-App-not-installed install action (source-slice)", () => {
  it("defines install_app_on_repo, app_install_finish_cmd, and the shared app_install_url", () => {
    expect(source).toContain("install_app_on_repo() {");
    expect(source).toContain("app_install_finish_cmd() {");
    // The org-installations URL lives in exactly one place; both renderers call it.
    expect(source).toContain("app_install_url() {");
    expect(source).toContain(
      'printf \'%s\' "https://github.com/organizations/$OWNER/settings/installations"',
    );
  });

  it("install_app_on_repo routes to the org installations settings URL via app_install_url", () => {
    expect(source).toContain('Open: $(app_install_url)');
    expect(source).toContain(
      "Find the flywheel App, click Configure, add $REPO under 'Only select repositories', and Save.",
    );
    expect(source).toContain(
      "This is the one step that lets the App mint tokens for $REPO.",
    );
  });

  it("install_app_on_repo waits for ENTER once interactive", () => {
    expect(source).toContain(
      'read -r -u 3 -p "  Press ENTER once the App is installed on $REPO..."',
    );
  });

  it("app_install_finish_cmd is the single-source one-line install instruction (org URL via app_install_url)", () => {
    expect(source).toContain(
      "Install the existing flywheel App on $REPO: open $(app_install_url) , Configure the App, and add $REPO under 'Only select repositories'.",
    );
  });

  it("offers the 3-option install menu when the org App is not installed", () => {
    expect(source).toContain(
      "1) Install the existing App on this repo (recommended)",
    );
    expect(source).toContain("2) Use the detected credentials anyway");
    expect(source).toContain(
      "3) Override — create or paste different credentials",
    );
    // The menu is gated on PREFLIGHT_APP_INSTALLED == "no".
    expect(source).toContain('if [[ "$PREFLIGHT_APP_INSTALLED" == "no" ]]; then');
  });

  it("non-interactive 'no' path prints the manual finish line and DEFERS (not configured)", () => {
    expect(source).toContain(
      "non-interactive shell — the org App is not installed on $REPO. Finish manually:",
    );
    // The deferred outcome is recorded with the config bucket + warn severity
    // (NOT configured) — the credentials exist but the App can't mint yet.
    expect(source).toContain(
      'record_outcome "App credentials" deferred config warn "$app_install_cmd"',
    );
  });
});

// The canonical "both credentials present at repo level, App installed" stub —
// the scenario the reuse boundary and the confirm path both exercise.
const BOTH_PRESENT_REPO: Record<string, string> = {
  STUB_OWNER_TYPE: "Organization",
  STUB_REPO_VARS: "FLYWHEEL_GH_APP_ID",
  STUB_REPO_APP_ID: "12345",
  STUB_REPO_SECRETS: "FLYWHEEL_GH_APP_PRIVATE_KEY",
  STUB_INSTALLED_APP_IDS: "12345",
};

// Org-level App ID + key detected, but the App is NOT in the org's installations
// list → detect_app_installation sets PREFLIGHT_APP_INSTALLED="no". Owner must be
// an Organization, the App ID must be found at org level (so PREFLIGHT_HAS_APP_ID=1,
// PREFLIGHT_APP_ID_AT=org), and the installations list must be readable, non-empty,
// and EXCLUDE our App ID (a different App is installed). This is the new WS1/WS2
// "exists at the org level but is not installed on this repo" path.
const ORG_APP_NOT_INSTALLED: Record<string, string> = {
  STUB_OWNER_TYPE: "Organization",
  STUB_ORG_VARS: "FLYWHEEL_GH_APP_ID",
  STUB_ORG_APP_ID: "12345",
  STUB_ORG_SECRETS: "FLYWHEEL_GH_APP_PRIVATE_KEY",
  STUB_INSTALLED_APP_IDS: "99999", // a DIFFERENT App is installed, not ours
};

// ===========================================================================
// B. RUNTIME NON-INTERACTIVE — stable contract & no duplicate lookups
// ===========================================================================
describe("init.sh App step — non-interactive runtime (reuse boundary)", () => {
  it("no duplicate lookups: App step adds ZERO credential reads beyond pre-flight", () => {
    const { work, binDir, doctorStub } = makeWorkdir();
    const callLog = join(work, "gh-calls.log");
    try {
      const r = spawnSync("bash", [initSh, ...SCAFFOLD_ARGS], {
        cwd: work,
        encoding: "utf8",
        input: "",
        timeout: 30000,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          FLYWHEEL_TEST_HOOKS: "1",
          FLYWHEEL_DOCTOR_OVERRIDE: doctorStub,
          STUB_CALL_LOG: callLog,
          ...BOTH_PRESENT_REPO,
        },
      });
      expect(
        r.status,
        `stderr:\n${r.stderr}\nstdout:\n${stripAnsi(r.stdout ?? "")}`,
      ).toBe(0);

      const log = readFileSync(callLog, "utf8");
      const count = (re: RegExp) =>
        log.split("\n").filter((l) => re.test(l)).length;

      // The single pre-flight pass reads each credential exactly once at repo
      // level; because both are found at repo, NO org calls happen, and the App
      // step (consuming PREFLIGHT_*) adds none. Exactly-one is the reuse proof.
      expect(count(/^variable list\b/)).toBe(1);
      expect(count(/^variable get\b/)).toBe(1);
      expect(count(/^secret list\b/)).toBe(1);
      // No org-level credential probes at all (both found at repo).
      expect(count(/^variable (list|get).*--org/)).toBe(0);
      expect(count(/^secret list.*--org/)).toBe(0);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("backward-compat: both present → prints the existing already-set line, configured, exit 0", () => {
    const r = runInit({ env: BOTH_PRESENT_REPO });
    try {
      const out = stripAnsi(r.stdout);
      expect(r.status, `stderr:\n${r.stderr}\nstdout:\n${out}`).toBe(0);
      expect(out).toContain(
        "FLYWHEEL_GH_APP_ID variable + FLYWHEEL_GH_APP_PRIVATE_KEY secret already set (repo-level).",
      );
      expect(out).toContain(
        'FLYWHEEL_SETUP_STEP outcome=configured bucket= severity= command="" label="App credentials"',
      );
      // The non-interactive path never shows the cold menu.
      expect(out).not.toContain("Pick a setup path");
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("greenfield: nothing detected → completes exit 0, cold menu skipped on non-TTY", () => {
    const r = runInit(); // no STUB_* → everything absent
    try {
      const out = stripAnsi(r.stdout);
      expect(r.status, `stderr:\n${r.stderr}\nstdout:\n${out}`).toBe(0);
      expect(out).toContain("non-interactive shell — skipping App-credential prompts.");
      expect(out).not.toContain("Pick a setup path");
      expect(out).not.toContain("Use the detected credentials?");
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("org App not installed → prints the manual install finish line, DEFERS (not configured), exit 0", () => {
    const r = runInit({ env: ORG_APP_NOT_INSTALLED });
    try {
      const out = stripAnsi(r.stdout);
      // Deferred is warn severity, not block → the run still completes 0.
      expect(r.status, `stderr:\n${r.stderr}\nstdout:\n${out}`).toBe(0);
      // The install-finish instruction is printed (the org installations URL).
      expect(out).toContain(
        "non-interactive shell — the org App is not installed on acme/widget. Finish manually:",
      );
      expect(out).toContain(
        "Install the existing flywheel App on acme/widget: open https://github.com/organizations/acme/settings/installations , Configure the App, and add acme/widget under 'Only select repositories'.",
      );
      // It must NOT claim the creds are already-set/configured: the App still
      // cannot mint tokens here. Assert the deferred machine record explicitly.
      expect(out).not.toContain("already set");
      expect(out).toMatch(
        /FLYWHEEL_SETUP_STEP outcome=deferred bucket=config severity=warn command="Install the existing flywheel App on acme\/widget:.*" label="App credentials"/,
      );
      expect(out).not.toMatch(
        /FLYWHEEL_SETUP_STEP outcome=configured .* label="App credentials"/,
      );
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("org App not installed AND private key missing → surfaces BOTH the install and the key finish command, DEFERS, exit 0", () => {
    // has_app_id=1 (org App ID) but NO private-key secret anywhere, and the App is
    // not installed on the repo. The not-installed branch must not stop at the
    // install instruction — it must also tell the adopter the key is still unset,
    // or they install an App whose token cannot be minted (#236 review finding ①).
    const r = runInit({
      env: {
        STUB_OWNER_TYPE: "Organization",
        STUB_ORG_VARS: "FLYWHEEL_GH_APP_ID",
        STUB_ORG_APP_ID: "12345",
        // no STUB_ORG_SECRETS / STUB_REPO_SECRETS → private key missing
        STUB_INSTALLED_APP_IDS: "99999",
      },
    });
    try {
      const out = stripAnsi(r.stdout);
      expect(r.status, `stderr:\n${r.stderr}\nstdout:\n${out}`).toBe(0);
      expect(out).toContain(
        "non-interactive shell — the org App is not installed on acme/widget. Finish manually:",
      );
      // The missing-key finish command is surfaced alongside the install action.
      expect(out).toContain(
        "The FLYWHEEL_GH_APP_PRIVATE_KEY secret is also missing — set it too:",
      );
      expect(out).toContain(
        "gh secret set FLYWHEEL_GH_APP_PRIVATE_KEY < /path/to/private-key.pem --org acme --visibility all",
      );
      // Deferred (warn), and the recorded command carries BOTH actions.
      expect(out).toMatch(
        /FLYWHEEL_SETUP_STEP outcome=deferred bucket=config severity=warn command="Install the existing flywheel App on acme\/widget:.* ; gh variable set FLYWHEEL_GH_APP_ID .*" label="App credentials"/,
      );
      expect(out).not.toMatch(
        /FLYWHEEL_SETUP_STEP outcome=configured .* label="App credentials"/,
      );
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// B. STABLE-IDENTIFIER CONTRACT — a working installed run is unchanged
// ===========================================================================
// Proves WS1/WS2's org-App-not-installed work did not perturb the credentials a
// previously-working run leaves behind: both creds present at the SAME level AND
// the App installed (so NOT the new "no" path). The run must still print the
// existing already-set line, record the App configured, and perform ZERO
// credential WRITES (no `gh variable set` / `gh secret set`).
describe("init.sh App step — stable-identifier contract (working run unchanged)", () => {
  it("both creds present + App installed → already-set line, configured, ZERO credential writes", () => {
    const { work, binDir, doctorStub } = makeWorkdir();
    const callLog = join(work, "gh-calls.log");
    try {
      const r = spawnSync("bash", [initSh, ...SCAFFOLD_ARGS], {
        cwd: work,
        encoding: "utf8",
        input: "",
        timeout: 30000,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          FLYWHEEL_TEST_HOOKS: "1",
          FLYWHEEL_DOCTOR_OVERRIDE: doctorStub,
          STUB_CALL_LOG: callLog,
          ...BOTH_PRESENT_REPO,
        },
      });
      const out = stripAnsi(r.stdout ?? "");
      expect(r.status, `stderr:\n${r.stderr}\nstdout:\n${out}`).toBe(0);

      // The existing backward-compat already-set line + configured outcome.
      expect(out).toContain(
        "FLYWHEEL_GH_APP_ID variable + FLYWHEEL_GH_APP_PRIVATE_KEY secret already set (repo-level).",
      );
      expect(out).toContain(
        'FLYWHEEL_SETUP_STEP outcome=configured bucket= severity= command="" label="App credentials"',
      );

      // The credentials a working run leaves behind are UNCHANGED: it writes
      // neither the FLYWHEEL_GH_APP_ID variable nor the FLYWHEEL_GH_APP_PRIVATE_KEY
      // secret. Assert via the gh call log (no write subcommands logged).
      const log = readFileSync(callLog, "utf8");
      expect(log).not.toMatch(/variable set FLYWHEEL_GH_APP_ID/);
      expect(log).not.toMatch(/secret set FLYWHEEL_GH_APP_PRIVATE_KEY/);
      // No writes of ANY kind in this read-only working run.
      expect(log).not.toMatch(/^variable set\b/m);
      expect(log).not.toMatch(/^secret set\b/m);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("uses the exact identifiers FLYWHEEL_GH_APP_ID (variable) and FLYWHEEL_GH_APP_PRIVATE_KEY (secret) — not renamed", () => {
    // Source-slice guard: the credential identifiers and their kinds are a stable
    // contract shared with workflows, doctor.sh, and docs. Pin both names and that
    // init describes them as a "variable" and a "secret" respectively.
    expect(source).toContain("FLYWHEEL_GH_APP_ID variable");
    expect(source).toContain("FLYWHEEL_GH_APP_PRIVATE_KEY secret");
  });
});

// ===========================================================================
// C. RUNTIME INTERACTIVE — confirm / override / partial / org (Python pty)
// ===========================================================================
describe("init.sh App step — interactive confirm/override (Python pty)", () => {
  it("confirm a fully-detected App (Enter) → keeps creds, no cold menu, no re-prompt", () => {
    const r = runInitPty({ answers: "\n", stub: BOTH_PRESENT_REPO });
    expect(r.exit, r.out).toBe(0);
    expect(r.out).toContain("Use the detected credentials? [Y/n]");
    expect(r.out).toContain("Keeping the detected credentials.");
    // Cold menu skipped (app_step_resolved set on confirm).
    expect(r.out).not.toContain("Pick a setup path");
    // Present pieces are never re-pasted.
    expect(r.out).not.toContain("App ID (numeric, stored as the FLYWHEEL_GH_APP_ID Variable):");
    expect(r.out).not.toContain("Path to PEM private-key file (stored as the FLYWHEEL_GH_APP_PRIVATE_KEY Secret):");
  });

  it("override (n) → falls through to the cold create/paste/skip menu", () => {
    // n = override → scope prompt (org owner) answer 1 (repo) → menu answer 3 (skip).
    const r = runInitPty({ answers: "n\n1\n3\n", stub: BOTH_PRESENT_REPO });
    expect(r.exit, r.out).toBe(0);
    expect(r.out).toContain("Use the detected credentials? [Y/n]");
    expect(r.out).toContain("Pick a setup path:");
  });

  it("partial (id present, key missing): confirm prompts only for the missing PEM; skipping it DEFERS (not configured)", () => {
    const r = runInitPty({
      answers: "\n\n", // confirm, then empty PEM path (skip the write)
      stub: {
        STUB_OWNER_TYPE: "Organization",
        STUB_REPO_VARS: "FLYWHEEL_GH_APP_ID",
        STUB_REPO_APP_ID: "12345",
        // repo secrets EMPTY → key missing.
      },
    });
    expect(r.exit, r.out).toBe(0);
    expect(r.out).toContain("Use the detected credentials? [Y/n]");
    // Missing piece is prompted; present piece (App ID) is NOT.
    expect(r.out).toContain("Path to PEM private-key file (stored as the FLYWHEEL_GH_APP_PRIVATE_KEY Secret):");
    expect(r.out).not.toContain("App ID (numeric, stored as the FLYWHEEL_GH_APP_ID Variable):");
    // Confirm path, not override → no cold menu.
    expect(r.out).not.toContain("Pick a setup path");
    // The PEM write was skipped, so the secret is still unset — the summary must
    // record this as DEFERRED, never a false "configured" (#236 review finding ⑤).
    expect(r.out).toContain("App credentials — deferred");
    expect(r.out).not.toContain("App credentials — configured");
  });

  it("org-level detected: summary shows org-level, confirm keeps the creds", () => {
    const r = runInitPty({
      answers: "\n",
      stub: {
        STUB_OWNER_TYPE: "Organization",
        // repo lists empty → detector falls through to org.
        STUB_ORG_VARS: "FLYWHEEL_GH_APP_ID",
        STUB_ORG_APP_ID: "12345",
        STUB_ORG_SECRETS: "FLYWHEEL_GH_APP_PRIVATE_KEY",
        STUB_INSTALLED_APP_IDS: "12345",
      },
    });
    expect(r.exit, r.out).toBe(0);
    expect(r.out).toContain("FLYWHEEL_GH_APP_ID variable: found (org-level)");
    expect(r.out).toContain("FLYWHEEL_GH_APP_PRIVATE_KEY secret: found (org-level)");
    expect(r.out).toContain("Keeping the detected credentials.");
    expect(r.out).not.toContain("Pick a setup path");
  });
});

// ===========================================================================
// C. RUNTIME INTERACTIVE — org-App-not-installed install MENU (Python pty)
// ===========================================================================
// The 3-option install menu lives behind `read -u 3` and only renders when
// PREFLIGHT_APP_INSTALLED == "no". Drive it under the pty for each option:
//   1) install (recommended) → install instructions + Press-ENTER, then keep creds
//   2) use anyway            → keep the detected credentials (no install detour)
//   3) override              → fall through to the cold create/paste/skip menu
describe("init.sh App step — org-App-not-installed install menu (Python pty)", () => {
  it("renders the 3-option menu only when the org App is not installed", () => {
    // Option 2 (use anyway) is the simplest no-`read ENTER` path to confirm the
    // menu renders. answers: "2\n" selects "use the detected credentials anyway".
    const r = runInitPty({ answers: "2\n", stub: ORG_APP_NOT_INSTALLED });
    expect(r.exit, r.out).toBe(0);
    expect(r.out).toContain(
      "This App is not installed on acme/widget, so its tokens cannot act here yet.",
    );
    expect(r.out).toContain("Pick how to proceed:");
    expect(r.out).toContain(
      "1) Install the existing App on this repo (recommended)",
    );
    expect(r.out).toContain("2) Use the detected credentials anyway");
    expect(r.out).toContain(
      "3) Override — create or paste different credentials",
    );
  });

  it("option 1 (install, recommended) → prints install instructions + Press-ENTER, then keeps creds", () => {
    // "1\n\n" = select install, then press ENTER at install_app_on_repo's
    // "Press ENTER once the App is installed" prompt. The run then keeps the
    // already-detected credentials and records configured.
    const r = runInitPty({ answers: "1\n\n", stub: ORG_APP_NOT_INSTALLED });
    expect(r.exit, r.out).toBe(0);
    // install_app_on_repo's guided instructions (org installations settings URL).
    expect(r.out).toContain("Install the existing App on this repo:");
    expect(r.out).toContain(
      "Open: https://github.com/organizations/acme/settings/installations",
    );
    expect(r.out).toContain(
      "Find the flywheel App, click Configure, add acme/widget under 'Only select repositories', and Save.",
    );
    expect(r.out).toContain("Press ENTER once the App is installed on acme/widget");
    // After the install detour, the detected credentials are kept (configured).
    expect(r.out).toContain("Keeping the detected credentials.");
    expect(r.out).toContain("App credentials — configured");
    // The install path is NOT an override → the cold menu never appears.
    expect(r.out).not.toContain("Pick a setup path");
  });

  it("option 2 (use anyway) → keeps the detected credentials, no install detour, no cold menu", () => {
    const r = runInitPty({ answers: "2\n", stub: ORG_APP_NOT_INSTALLED });
    expect(r.exit, r.out).toBe(0);
    expect(r.out).toContain("Keeping the detected credentials.");
    expect(r.out).toContain("App credentials — configured");
    // "Use anyway" skips the install instructions and the cold menu.
    expect(r.out).not.toContain("Install the existing App on this repo:");
    expect(r.out).not.toContain("Pick a setup path");
  });

  it("option 3 (override) → falls through to the cold create/paste/skip menu", () => {
    // "3\n1\n3\n" = override → scope prompt answer 1 (repo) → cold menu answer 3 (skip).
    const r = runInitPty({ answers: "3\n1\n3\n", stub: ORG_APP_NOT_INSTALLED });
    expect(r.exit, r.out).toBe(0);
    expect(r.out).toContain("Pick a setup path:");
    // Override clears the detected locals → it does NOT keep them.
    expect(r.out).not.toContain("Keeping the detected credentials.");
  });
});
