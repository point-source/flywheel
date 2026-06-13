import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// init.sh's re-run hazard: when both the FLYWHEEL_GH_APP_ID variable and
// FLYWHEEL_GH_APP_PRIVATE_KEY secret already exist, the App-credential
// prompt block short-circuits and CREATED_APP_ID stays empty. Without
// --app-id, apply-rulesets.sh PUTs an empty bypass_actors and the App
// loses its bypass entry, breaking semantic-release pushes. Recovery:
// init.sh reads the App ID back from the repo Variable.
//
// These tests stub `gh` so the test never talks to GitHub, then run
// init.sh non-interactively (yn defaults to N → "skipped ruleset apply"
// hint). That hint embeds --app-id iff CREATED_APP_ID was resolved, via
// the same `${CREATED_APP_ID:+ --app-id $CREATED_APP_ID}` expansion the
// apply-rulesets.sh args= line uses — equivalent probe, no need to also
// stub apply-rulesets.sh execution.
//
// `detached: true` puts the child in a new session via setsid(), so
// /dev/tty isn't inherited and init.sh's INTERACTIVE detection lands on
// 0 even when vitest runs from a developer terminal. Without this, the
// yn read on /dev/tty would block locally.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const realInitSh = join(repoRoot, "scripts/init.sh");
const realTemplates = join(repoRoot, "scripts/templates");
// init.sh's pre-flight pass sources scripts/lib/findings.sh from $SCRIPT_DIR/lib
// (§spec:preflight-gate); the copied scriptDir must ship it alongside init.sh,
// mirroring real deployment, or init.sh hard-exits before doing anything.
const realLib = join(repoRoot, "scripts/lib/findings.sh");
const TEST_VERSION = "v9.99.0-rerun-test";

// Stub differentiates repo-vs-org by scanning args for --org. Defaults
// preserve the legacy single-scope behavior (creds present at repo level)
// so existing tests don't need to plumb the new env vars; org-scope tests
// override via GH_ORG_*.
const GH_STUB = `#!/usr/bin/env bash
set -e
printf '%s\\n' "$*" >> "$GH_STUB_LOG"
is_org=0
for arg in "$@"; do
  [[ "$arg" == "--org" ]] && is_org=1
done
case "$1 $2" in
  "auth status")
    printf '%s\\n' "  - Token scopes: 'repo', 'admin:org', 'read:org'"
    ;;
  "repo view")
    echo "test-owner/test-repo"
    ;;
  "secret list")
    if [[ $is_org -eq 1 ]]; then
      printf '%s\\n' "\${GH_ORG_SECRET_LIST-}"
    else
      printf '%s\\n' "\${GH_REPO_SECRET_LIST-FLYWHEEL_GH_APP_PRIVATE_KEY}"
    fi
    ;;
  "variable list")
    if [[ $is_org -eq 1 ]]; then
      printf '%s\\n' "\${GH_ORG_VARIABLE_LIST-}"
    else
      printf '%s\\n' "\${GH_REPO_VARIABLE_LIST-FLYWHEEL_GH_APP_ID}"
    fi
    ;;
  "secret set"|"variable set")
    cat >/dev/null
    ;;
  "variable get")
    if [[ $is_org -eq 1 ]]; then
      if [[ -n "\${GH_ORG_VARIABLE_VALUE:-}" ]]; then
        printf '%s' "\$GH_ORG_VARIABLE_VALUE"
      else
        exit 1
      fi
    else
      if [[ -n "\${GH_VARIABLE_VALUE:-}" ]]; then
        printf '%s' "\$GH_VARIABLE_VALUE"
      else
        exit 1
      fi
    fi
    ;;
  "api -X")
    cat >/dev/null
    ;;
  "api users/test-owner")
    printf '%s\\n' "\${GH_OWNER_TYPE:-User}"
    ;;
esac
`;

interface Sandbox {
  scriptDir: string;
  binDir: string;
  adopter: string;
  ghLog: string;
}

function setup(): Sandbox {
  const scriptDir = mkdtempSync(join(tmpdir(), "fw-rerun-scripts-"));
  // SCRIPT_DIR is derived from BASH_SOURCE[0] inside init.sh, so the
  // copy decides where init.sh looks for templates/ and apply-rulesets.sh.
  // Copy (not symlink) for portability across runners.
  copyFileSync(realInitSh, join(scriptDir, "init.sh"));
  chmodSync(join(scriptDir, "init.sh"), 0o755);
  mkdirSync(join(scriptDir, "templates"));
  for (const f of readdirSync(realTemplates)) {
    copyFileSync(join(realTemplates, f), join(scriptDir, "templates", f));
  }
  // Ship the shared findings vocabulary lib so init.sh's pre-flight source
  // (`$SCRIPT_DIR/lib/findings.sh`) resolves on disk instead of curl-fetching.
  mkdirSync(join(scriptDir, "lib"));
  copyFileSync(realLib, join(scriptDir, "lib", "findings.sh"));
  // No apply-rulesets.sh in scriptDir — non-interactive yn=N never invokes
  // it, and its absence makes the elif "apply-rulesets.sh not adjacent"
  // branch trigger if the test misroutes (loud failure beats silent miss).
  // We want the if-branch though, so write a no-op stub that satisfies -x.
  const stubApply = join(scriptDir, "apply-rulesets.sh");
  writeFileSync(stubApply, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(stubApply, 0o755);

  const binDir = mkdtempSync(join(tmpdir(), "fw-rerun-bin-"));
  writeFileSync(join(binDir, "gh"), GH_STUB);
  chmodSync(join(binDir, "gh"), 0o755);

  const adopter = mkdtempSync(join(tmpdir(), "fw-rerun-adopter-"));
  execFileSync("git", ["init", "-q"], { cwd: adopter });
  execFileSync(
    "git",
    ["remote", "add", "origin", "git@github.com:test-owner/test-repo.git"],
    { cwd: adopter },
  );

  const ghLog = join(adopter, "gh.log");
  writeFileSync(ghLog, "");

  return { scriptDir, binDir, adopter, ghLog };
}

function teardown(s: Sandbox): void {
  rmSync(s.scriptDir, { recursive: true, force: true });
  rmSync(s.binDir, { recursive: true, force: true });
  rmSync(s.adopter, { recursive: true, force: true });
}

function runInit(s: Sandbox, env: Record<string, string>): string {
  // @types/node doesn't expose `detached` on SpawnSyncOptions, but Node
  // honors it at runtime (calls setsid → child in new session without an
  // inherited controlling tty → init.sh's `exec 3</dev/tty` fails →
  // INTERACTIVE=0). Without it, the yn read on /dev/tty would block this
  // test when run from a developer terminal.
  const opts = {
    cwd: s.adopter,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PATH: `${s.binDir}:${process.env.PATH}`,
      GH_STUB_LOG: s.ghLog,
      ...env,
    },
  } as Parameters<typeof spawnSync>[2];
  const result = spawnSync(
    "bash",
    [
      join(s.scriptDir, "init.sh"),
      "--preset", "minimal",
      "--version", TEST_VERSION,
    ],
    opts,
  );
  if (result.status !== 0) {
    throw new Error(
      `init.sh failed (status ${result.status})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return (result.stdout?.toString() ?? "") + (result.stderr?.toString() ?? "");
}

describe("init.sh re-run resolves App ID via repo variable", () => {
  it("recovers --app-id from repo variable when secrets already exist", () => {
    const s = setup();
    try {
      const out = runInit(s, { GH_VARIABLE_VALUE: "123456" });

      const ghLog = readFileSync(s.ghLog, "utf8");
      expect(ghLog).toMatch(
        /^variable get FLYWHEEL_GH_APP_ID --repo test-owner\/test-repo$/m,
      );

      expect(out).toContain(
        "scripts/apply-rulesets.sh test-owner/test-repo --app-id 123456",
      );
    } finally {
      teardown(s);
    }
  });

  it("omits --app-id when variable missing in non-interactive re-run", () => {
    const s = setup();
    try {
      const out = runInit(s, { GH_VARIABLE_VALUE: "" });

      const ghLog = readFileSync(s.ghLog, "utf8");
      expect(ghLog).toMatch(/^variable get FLYWHEEL_GH_APP_ID/m);

      expect(out).toContain("scripts/apply-rulesets.sh test-owner/test-repo");
      expect(out).not.toContain("--app-id");
    } finally {
      teardown(s);
    }
  });

  // When the App credentials live at org level (e.g. one App installed
  // org-wide, with FLYWHEEL_GH_APP_ID/FLYWHEEL_GH_APP_PRIVATE_KEY set on
  // the org with visibility=all), a re-run from any repo in the org should:
  //   1) detect the creds via `gh {variable,secret} list --org $owner`
  //      and not double-prompt,
  //   2) recover the App ID via `gh variable get FLYWHEEL_GH_APP_ID --org`
  //      (the pre-flight probe reads the value once at the level where the
  //      variable actually exists — org here, since the repo-level list missed —
  //      and the --app-id readback reuses it rather than re-fetching),
  //   3) pass --app-id through to apply-rulesets.sh.
  it("recovers --app-id from org-level variable when owner is org and repo level missing", () => {
    const s = setup();
    try {
      const out = runInit(s, {
        GH_REPO_VARIABLE_LIST: "",
        GH_REPO_SECRET_LIST: "",
        GH_ORG_VARIABLE_LIST: "FLYWHEEL_GH_APP_ID",
        GH_ORG_SECRET_LIST: "FLYWHEEL_GH_APP_PRIVATE_KEY",
        GH_OWNER_TYPE: "Organization",
        GH_VARIABLE_VALUE: "",
        GH_ORG_VARIABLE_VALUE: "654321",
      });

      const ghLog = readFileSync(s.ghLog, "utf8");
      // Existence-check fan-out: repo first, then org.
      expect(ghLog).toMatch(/^variable list --org test-owner/m);
      expect(ghLog).toMatch(/^secret list --org test-owner/m);
      // App ID value is read once, at the level where the variable exists (org).
      // The repo-level list missed, so no repo-level `variable get` is issued —
      // the --app-id readback reuses the value the pre-flight probe captured.
      expect(ghLog).not.toMatch(/^variable get FLYWHEEL_GH_APP_ID --repo/m);
      expect(ghLog).toMatch(/^variable get FLYWHEEL_GH_APP_ID --org test-owner$/m);

      expect(out).toContain("already set (org-level)");
      expect(out).toContain(
        "scripts/apply-rulesets.sh test-owner/test-repo --app-id 654321",
      );
    } finally {
      teardown(s);
    }
  });

  // Symmetric to the above but for User-owned repos: the script must not
  // attempt org-level lookups when the owner isn't an Organization, since
  // the gh API rejects /orgs/<user>/... and admin:org isn't applicable.
  it("does not probe org-level when owner is a user account", () => {
    const s = setup();
    try {
      const out = runInit(s, {
        GH_REPO_VARIABLE_LIST: "",
        GH_REPO_SECRET_LIST: "",
        GH_OWNER_TYPE: "User",
        GH_VARIABLE_VALUE: "",
      });

      const ghLog = readFileSync(s.ghLog, "utf8");
      expect(ghLog).not.toMatch(/--org/);

      expect(out).toContain("scripts/apply-rulesets.sh test-owner/test-repo");
      expect(out).not.toContain("--app-id");
    } finally {
      teardown(s);
    }
  });
});
