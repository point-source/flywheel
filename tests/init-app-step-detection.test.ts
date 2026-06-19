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

  it("defines and CALLS the read-only missing-pieces classifier in the step", () => {
    expect(source).toContain("app_step_missing_pieces() {");
    expect(source).toContain('missing="$(app_step_missing_pieces)"');
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

  it("takes SCOPE on confirm from the pre-flight found-at levels (no cold scope prompt)", () => {
    // The confirm branch derives SCOPE from where the present piece lives.
    expect(source).toContain('SCOPE="$app_id_found_at"');
    expect(source).toContain('SCOPE="$app_key_found_at"');
  });
});

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
          STUB_OWNER_TYPE: "Organization",
          STUB_REPO_VARS: "FLYWHEEL_GH_APP_ID",
          STUB_REPO_APP_ID: "12345",
          STUB_REPO_SECRETS: "FLYWHEEL_GH_APP_PRIVATE_KEY",
          STUB_INSTALLED_APP_IDS: "12345",
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
    const r = runInit({
      env: {
        STUB_OWNER_TYPE: "Organization",
        STUB_REPO_VARS: "FLYWHEEL_GH_APP_ID",
        STUB_REPO_APP_ID: "12345",
        STUB_REPO_SECRETS: "FLYWHEEL_GH_APP_PRIVATE_KEY",
        STUB_INSTALLED_APP_IDS: "12345",
      },
    });
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
});

// ===========================================================================
// C. RUNTIME INTERACTIVE — confirm / override / partial / org (Python pty)
// ===========================================================================
describe("init.sh App step — interactive confirm/override (Python pty)", () => {
  const bothPresentRepo = {
    STUB_OWNER_TYPE: "Organization",
    STUB_REPO_VARS: "FLYWHEEL_GH_APP_ID",
    STUB_REPO_APP_ID: "12345",
    STUB_REPO_SECRETS: "FLYWHEEL_GH_APP_PRIVATE_KEY",
    STUB_INSTALLED_APP_IDS: "12345",
  };

  it("confirm a fully-detected App (Enter) → keeps creds, no cold menu, no re-prompt", () => {
    const r = runInitPty({ answers: "\n", stub: bothPresentRepo });
    expect(r.exit, r.out).toBe(0);
    expect(r.out).toContain("Use the detected credentials? [Y/n]");
    expect(r.out).toContain("Keeping the detected credentials.");
    // Cold menu skipped (app_step_resolved set on confirm).
    expect(r.out).not.toContain("Pick a setup path");
    // Present pieces are never re-pasted.
    expect(r.out).not.toContain("GitHub App ID (numeric):");
    expect(r.out).not.toContain("Path to private-key PEM file:");
  });

  it("override (n) → falls through to the cold create/paste/skip menu", () => {
    // n = override → scope prompt (org owner) answer 1 (repo) → menu answer 3 (skip).
    const r = runInitPty({ answers: "n\n1\n3\n", stub: bothPresentRepo });
    expect(r.exit, r.out).toBe(0);
    expect(r.out).toContain("Use the detected credentials? [Y/n]");
    expect(r.out).toContain("Pick a setup path:");
  });

  it("partial (id present, key missing): confirm prompts only for the missing PEM", () => {
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
    expect(r.out).toContain("Path to private-key PEM file:");
    expect(r.out).not.toContain("GitHub App ID (numeric):");
    // Confirm path, not override → no cold menu.
    expect(r.out).not.toContain("Pick a setup path");
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
