import { describe, expect, it, afterEach } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
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

// End-to-end exercise of scripts/apply-rulesets.sh, focused on the PyYAML
// self-provisioning resolver added in #245. The script resolves a python
// interpreter that can `import yaml` in tiers:
//
//   Tier 0 (fast path): the invoking python3 already has PyYAML — no temp
//     dir, no venv, no added latency.
//   Tier 1: provision PyYAML into a throwaway `mktemp -d` venv for the run,
//     then `rm -rf` it on exit (cleanup_pyyaml trap on EXIT/INT/TERM).
//   Tier 2a: venv/ensurepip missing — degrade with a python3-venv remedy.
//   Tier 2b: venv built but pip install failed (no network) — degrade with
//     a network remedy.
//
// Every test here is HERMETIC: no real network, no real pip install, no real
// `gh`. We stub `gh` on PATH (it only ever records payloads), keep real `jq`
// and real `python3`, and — when exercising Tiers 1/2 — stub `python3` with a
// shim that delegates the actual YAML parse to the real interpreter (which
// has PyYAML in this sandbox) while faking out venv/pip.
//
// The cleanup oracle is the child's $TMPDIR: the script's `mktemp -d` honors
// it, so a fresh empty $TMPDIR that is still empty after a run proves the
// throwaway venv dir was created there and removed on exit.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = join(repoRoot, "scripts/apply-rulesets.sh");

// Capture the REAL python3 path BEFORE any stubbing, so the Tier-1 venv shim
// can delegate the real YAML parse to it.
const REAL_PY = execFileSync("bash", ["-lc", "command -v python3"], {
  encoding: "utf8",
}).trim();

// Minimal .flywheel.yml the inline python parse accepts (it only reads
// b["name"] and b.get("release")).
const FIXTURE_YAML = `flywheel:
  streams:
    - name: main-line
      branches:
        - {name: develop, release: prerelease}
        - {name: main, release: production}
    - name: customer-acme
      branches:
        - {name: customer-acme, release: prerelease}
`;

const EXPECTED_MANAGED = [
  "refs/heads/develop",
  "refs/heads/main",
  "refs/heads/customer-acme",
];
const EXPECTED_RELEASE = ["refs/heads/main"];

type PythonMode =
  | "tier0-record"
  | "tier1-success"
  | "tier1-pip-fail"
  | "tier1-venv-fail"
  | "tier1-venv-sleep";

const tmpDirs: string[] = [];
function freshDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

/** PATH-stub `gh` that records every `--input -` payload (NUL-terminated) to
 * $GH_PAYLOADS and prints nothing for the list `--jq` call (so the script
 * takes the POST/create path). Exits 0 for everything. */
function setupGhStub(binDir: string): void {
  const stub = `#!/usr/bin/env bash
# Capture create/replace payloads read from stdin (the --input - form).
for arg in "$@"; do
  if [[ "$arg" == "-" ]]; then
    { cat; printf '\\0'; } >> "\${GH_PAYLOADS}"
    exit 0
  fi
done
# Everything else (the rulesets list --jq call, PATCH repo settings):
# print nothing, succeed.
exit 0
`;
  writeFileSync(join(binDir, "gh"), stub);
  chmodSync(join(binDir, "gh"), 0o755);
}

/** Install a `python3` stub into binDir. See PythonMode for behaviors. The
 * stub records argv (NUL-terminated) to argvLog so tests can assert whether
 * `-m venv` was ever invoked. */
function setupPythonStub(
  binDir: string,
  argvLog: string,
  mode: PythonMode,
): void {
  // The venv shim (written as DIR/bin/python) the stub creates when it builds
  // a fake venv. pip install → no-op (success or fail per mode); anything
  // else → delegate to the real interpreter (which has PyYAML).
  const pipExit = mode === "tier1-pip-fail" ? 1 : 0;
  const venvShim = `#!/usr/bin/env bash
if [[ "$1" == "-m" && "$2" == "pip" ]]; then
  exit ${pipExit}
fi
exec ${REAL_PY} "$@"
`;

  let body: string;
  if (mode === "tier0-record") {
    body = `#!/usr/bin/env bash
printf '%s\\0' "$*" >> "${argvLog}"
exec ${REAL_PY} "$@"
`;
  } else {
    let venvBlock: string;
    if (mode === "tier1-venv-fail") {
      venvBlock = `  exit 1`;
    } else if (mode === "tier1-venv-sleep") {
      venvBlock = `  sleep 5
  exit 1`;
    } else {
      // Build a fake venv at $3 with a bin/python shim.
      venvBlock = `  mkdir -p "$3/bin"
  cat > "$3/bin/python" <<'SHIM'
${venvShim}SHIM
  chmod 0755 "$3/bin/python"
  exit 0`;
    }
    body = `#!/usr/bin/env bash
printf '%s\\0' "$*" >> "${argvLog}"
if [[ "$1" == "-c" && "$2" == "import yaml" ]]; then
  exit 1
fi
if [[ "$1" == "-m" && "$2" == "venv" ]]; then
${venvBlock}
fi
# Any other invocation of the outer python3 (shouldn't happen on Tier 1 since
# PYYAML_PYTHON becomes the venv shim) — delegate to the real interpreter.
exec ${REAL_PY} "$@"
`;
  }
  writeFileSync(join(binDir, "python3"), body);
  chmodSync(join(binDir, "python3"), 0o755);
}

interface RunCtx {
  controlledTmp: string;
  payloadsLog: string;
  pyArgvLog: string;
  fixturePath: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

function setupRun(opts: { pythonMode?: PythonMode } = {}): RunCtx {
  const binDir = freshDir("flywheel-ar-bin-");
  const controlledTmp = freshDir("flywheel-ar-tmp-");
  const workDir = freshDir("flywheel-ar-work-");
  const payloadsLog = join(binDir, "gh-payloads");
  const pyArgvLog = join(binDir, "py-argv");
  writeFileSync(payloadsLog, "");
  writeFileSync(pyArgvLog, "");

  setupGhStub(binDir);
  if (opts.pythonMode) setupPythonStub(binDir, pyArgvLog, opts.pythonMode);

  const fixturePath = join(workDir, ".flywheel.yml");
  writeFileSync(fixturePath, FIXTURE_YAML);

  // --app-id + --release-required-checks force the release-gate ruleset to be
  // applied, so its payload's include array exposes the production subset.
  const args = [
    scriptPath,
    "owner/repo",
    "--config",
    fixturePath,
    "--app-id",
    "123456",
    "--release-required-checks",
    "e2e",
  ];

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    TMPDIR: controlledTmp,
    GH_PAYLOADS: payloadsLog,
  };
  return { controlledTmp, payloadsLog, pyArgvLog, fixturePath, args, env };
}

function readNulRecords(log: string): string[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").split("\0").filter(Boolean);
}

/** include[] array parsed from the captured ruleset payload whose .name
 * contains `nameMatch` (first match in capture order). */
function includeFor(payloads: string[], nameMatch: string): string[] | null {
  for (const blob of payloads) {
    const obj = JSON.parse(blob);
    if (typeof obj.name === "string" && obj.name.includes(nameMatch)) {
      return obj.conditions.ref_name.include;
    }
  }
  return null;
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  payloads: string[];
  tmpdir: string;
  pyArgv: string[];
}

function run(opts: { pythonMode?: PythonMode } = {}): RunResult {
  const ctx = setupRun(opts);
  // spawnSync (not execFileSync) so we capture stderr on the SUCCESS path too,
  // not only when the process exits non-zero.
  const r = spawnSync("bash", ctx.args, { env: ctx.env, encoding: "utf8" });
  return {
    exitCode: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    payloads: readNulRecords(ctx.payloadsLog),
    tmpdir: ctx.controlledTmp,
    pyArgv: readNulRecords(ctx.pyArgvLog),
  };
}

describe("apply-rulesets.sh — PyYAML provisioning (#245)", () => {
  it("Tier 0 fast path: real python3 with PyYAML, no venv, controlled TMPDIR stays empty", () => {
    // tier0-record delegates to the real interpreter (which has yaml) but
    // records every argv, so we can prove venv was never invoked.
    const r = run({ pythonMode: "tier0-record" });
    expect(r.exitCode, r.stderr).toBe(0);

    // No throwaway dir left behind.
    expect(readdirSync(r.tmpdir)).toEqual([]);

    // The import-yaml probe succeeded on the fast path → no `-m venv` ever.
    expect(r.pyArgv.some((a) => a.includes("-m venv"))).toBe(false);
    // Sanity: the probe itself ran.
    expect(r.pyArgv.some((a) => a.includes("import yaml"))).toBe(true);

    expect(includeFor(r.payloads, "managed branches")).toEqual(EXPECTED_MANAGED);
  });

  it("Tier 1 provisioning success: venv built, parses correct, controlled TMPDIR cleaned up", () => {
    const r = run({ pythonMode: "tier1-success" });
    expect(r.exitCode, r.stderr).toBe(0);

    // Provisioning happened: the stub received a `-m venv` call.
    expect(r.pyArgv.some((a) => a.includes("-m venv"))).toBe(true);
    expect(r.stderr).toMatch(/provisioning it into a disposable virtualenv/);

    // Both parses produced the golden refs.
    expect(includeFor(r.payloads, "managed branches")).toEqual(EXPECTED_MANAGED);
    expect(includeFor(r.payloads, "release gate")).toEqual(EXPECTED_RELEASE);

    // Cleanup on success: the throwaway venv dir is gone.
    expect(readdirSync(r.tmpdir)).toEqual([]);
  });

  it("parse parity: Tier 0 and Tier 1 yield identical include arrays (and match the golden)", () => {
    const t0 = run({ pythonMode: "tier0-record" });
    const t1 = run({ pythonMode: "tier1-success" });
    expect(t0.exitCode, t0.stderr).toBe(0);
    expect(t1.exitCode, t1.stderr).toBe(0);

    const m0 = includeFor(t0.payloads, "managed branches");
    const m1 = includeFor(t1.payloads, "managed branches");
    const r0 = includeFor(t0.payloads, "release gate");
    const r1 = includeFor(t1.payloads, "release gate");

    // Identical to each other.
    expect(m0).toEqual(m1);
    expect(r0).toEqual(r1);
    // Identical to the golden.
    expect(m0).toEqual(EXPECTED_MANAGED);
    expect(m1).toEqual(EXPECTED_MANAGED);
    expect(r0).toEqual(EXPECTED_RELEASE);
    expect(r1).toEqual(EXPECTED_RELEASE);
  });

  it("Tier 2b cleanup on pip failure: non-zero exit, network remedy, TMPDIR cleaned up", () => {
    const r = run({ pythonMode: "tier1-pip-fail" });
    expect(r.exitCode).not.toBe(0);

    // Actionable network/install remedy — NOT a bare "PyYAML is required".
    expect(r.stderr).toMatch(/failed to install PyYAML/);
    expect(r.stderr).toMatch(/no network or the package index is unreachable/);
    expect(r.stderr).not.toMatch(/PyYAML is required/);

    // Cleanup ran on the error-exit path (set -euo pipefail + EXIT trap).
    expect(readdirSync(r.tmpdir)).toEqual([]);
  });

  it("Tier 2a graceful degradation when venv is unavailable: python3-venv remedy, TMPDIR cleaned up", () => {
    const r = run({ pythonMode: "tier1-venv-fail" });
    expect(r.exitCode).not.toBe(0);

    expect(r.stderr).toMatch(/python3-venv/);
    expect(r.stderr).toMatch(/venv\/ensurepip module is missing/);
    expect(r.stderr).not.toMatch(/PyYAML is required/);

    expect(readdirSync(r.tmpdir)).toEqual([]);
  });

  it("cleanup on interrupt: SIGINT mid-provision still removes the throwaway dir", async () => {
    const ctx = setupRun({ pythonMode: "tier1-venv-sleep" });
    // detached:true puts the child in its own process group so we can signal
    // the WHOLE group — reaching the `sleep` grandchild that the venv stub
    // spawned. A bare child.kill("SIGINT") would hit only bash, which defers
    // the INT trap until its sleeping foreground child returns.
    const child = spawn("bash", ctx.args, { env: ctx.env, detached: true });

    // Poll the controlled TMPDIR until the script's `mktemp -d` subdir appears
    // (deterministic — don't race on a fixed delay), then interrupt.
    const sawTmp = await new Promise<boolean>((resolve) => {
      const deadline = Date.now() + 20000;
      const tick = (): void => {
        let entries: string[] = [];
        try {
          entries = readdirSync(ctx.controlledTmp);
        } catch {
          entries = [];
        }
        // $TMPDIR started empty and only the script's `mktemp -d` writes
        // there, so any new entry is that throwaway dir — no need to couple to
        // mktemp's naming (consistent with the name-agnostic cleanup oracle).
        if (entries.length > 0) {
          resolve(true);
          return;
        }
        if (Date.now() > deadline) {
          resolve(false);
          return;
        }
        setTimeout(tick, 50);
      };
      tick();
    });
    expect(sawTmp, "mktemp -d subdir should appear mid-provision").toBe(true);

    // Signal the whole process group (negative pid). The script's INT trap
    // (exit 130) fires the EXIT trap → cleanup_pyyaml removes the throwaway dir.
    if (child.pid) process.kill(-child.pid, "SIGINT");
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));

    expect(readdirSync(ctx.controlledTmp)).toEqual([]);
  }, 30000);
});
