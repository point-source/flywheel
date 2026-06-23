import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
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

import { writeDoctorStub } from "./helpers/doctorStub.js";

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
  doctorStub: string;
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

  // Green doctor stub for the end-of-run auto-validation (§spec:setup-auto-validation).
  // These tests run init to completion, so without pinning a green doctor the real
  // doctor.sh is curl-fetched and run against the hermetic gh stub (which answers no
  // rulesets), reporting spurious block-severity findings that — under the exit
  // contract (§spec:setup-exit-contract) — would flip a clean run's exit non-zero.
  // Driven through the FLYWHEEL_DOCTOR_OVERRIDE seam (gated on FLYWHEEL_TEST_HOOKS),
  // via the shared helper the pre-flight suites already use.
  const doctorStub = writeDoctorStub(binDir, { blocks: 0, warns: 0 });

  const adopter = mkdtempSync(join(tmpdir(), "fw-rerun-adopter-"));
  execFileSync("git", ["init", "-q"], { cwd: adopter });
  execFileSync(
    "git",
    ["remote", "add", "origin", "git@github.com:test-owner/test-repo.git"],
    { cwd: adopter },
  );

  const ghLog = join(adopter, "gh.log");
  writeFileSync(ghLog, "");

  return { scriptDir, binDir, adopter, ghLog, doctorStub };
}

function teardown(s: Sandbox): void {
  rmSync(s.scriptDir, { recursive: true, force: true });
  rmSync(s.binDir, { recursive: true, force: true });
  rmSync(s.adopter, { recursive: true, force: true });
}

function runInit(
  s: Sandbox,
  env: Record<string, string>,
  extraArgs: string[] = [],
): string {
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
      // Pin the end-of-run validation to a green doctor stub (see setup()).
      FLYWHEEL_TEST_HOOKS: "1",
      FLYWHEEL_DOCTOR_OVERRIDE: s.doctorStub,
      ...env,
    },
  } as Parameters<typeof spawnSync>[2];
  const result = spawnSync(
    "bash",
    [
      join(s.scriptDir, "init.sh"),
      "--preset", "minimal",
      "--version", TEST_VERSION,
      ...extraArgs,
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

// WS1 reworded the App-credential prompts so both values are named as the
// Flywheel GitHub App's *shared* credentials — FLYWHEEL_GH_APP_ID as an
// Actions Variable, FLYWHEEL_GH_APP_PRIVATE_KEY as an Actions Secret — and
// explicitly NOT a personal access token / per-user secret. The harness
// forces INTERACTIVE=0, so the only reachable runtime surface is the
// non-interactive manual-setup branch (init.sh ~441-451): the
// `elif [[ "$INTERACTIVE" -eq 0 ]]` arm that prints the manual `gh
// variable set` / `gh secret set` commands. These tests drive that branch
// with neither credential present and pin the wording so a cosmetic
// rewording can't silently regress. The interactive prompt strings (scope
// menu, setup-path menu, prompt_existing_app_credentials) are unreachable
// here and are pinned separately by tests/init-credential-wording.test.ts.
describe("init.sh non-interactive manual-setup App-credential wording", () => {
  // Anchor unique to the manual-setup branch — if a refactor stops routing
  // through `elif [[ "$INTERACTIVE" -eq 0 ]]`, every assertion keyed off
  // this string fails loudly rather than the test passing vacuously.
  const MANUAL_SETUP_ANCHOR =
    "non-interactive shell — skipping App-credential prompts";

  it("repo branch names the Variable + Secret as the App's shared credentials", () => {
    const s = setup();
    try {
      // Neither credential present at repo level → manual-setup branch.
      // User-owned so no org probe, SCOPE unset → repo-scoped commands.
      const out = runInit(s, {
        GH_REPO_VARIABLE_LIST: "",
        GH_REPO_SECRET_LIST: "",
        GH_OWNER_TYPE: "User",
      });

      // Confirm we are actually in the manual-setup branch.
      expect(out).toContain(MANUAL_SETUP_ANCHOR);

      // Framed as the Flywheel GitHub App's shared credentials, not a bare blob.
      expect(out).toContain("Flywheel");

      // FLYWHEEL_GH_APP_ID = Variable, FLYWHEEL_GH_APP_PRIVATE_KEY = Secret.
      expect(out).toMatch(/FLYWHEEL_GH_APP_ID Variable/);
      expect(out).toMatch(/FLYWHEEL_GH_APP_PRIVATE_KEY Secret/);

      // Storage location surfaced to the adopter.
      expect(out).toContain("Settings → Secrets and variables → Actions");

      // Exact repo-scoped gh commands still emitted.
      expect(out).toContain(
        "gh variable set FLYWHEEL_GH_APP_ID --body '<your-app-id>' --repo test-owner/test-repo",
      );
      expect(out).toContain(
        "gh secret set FLYWHEEL_GH_APP_PRIVATE_KEY < /path/to/private-key.pem --repo test-owner/test-repo",
      );

      // Repo branch must not leak the org flags.
      expect(out).not.toContain("--visibility all");
    } finally {
      teardown(s);
    }
  });

  it("org branch (--scope org) emits org-wide Variable + Secret commands with visibility all", () => {
    const s = setup();
    try {
      // Neither credential present + --scope org + org owner → manual-setup
      // org branch (init.sh ~445-447).
      const out = runInit(
        s,
        {
          GH_REPO_VARIABLE_LIST: "",
          GH_REPO_SECRET_LIST: "",
          GH_ORG_VARIABLE_LIST: "",
          GH_ORG_SECRET_LIST: "",
          GH_OWNER_TYPE: "Organization",
        },
        ["--scope", "org"],
      );

      expect(out).toContain(MANUAL_SETUP_ANCHOR);

      // Same App-credential framing as the repo branch.
      expect(out).toContain("Flywheel");
      expect(out).toMatch(/FLYWHEEL_GH_APP_ID Variable/);
      expect(out).toMatch(/FLYWHEEL_GH_APP_PRIVATE_KEY Secret/);
      expect(out).toContain("Settings → Secrets and variables → Actions");

      // Org-scoped gh commands with visibility=all so every repo in the
      // org shares the one App's credentials.
      expect(out).toContain(
        "gh variable set FLYWHEEL_GH_APP_ID --body '<your-app-id>' --org test-owner --visibility all",
      );
      expect(out).toContain(
        "gh secret set FLYWHEEL_GH_APP_PRIVATE_KEY < /path/to/private-key.pem --org test-owner --visibility all",
      );
    } finally {
      teardown(s);
    }
  });
});

// WS2 (#235-2) adds partial-state detection: when exactly one of the two
// values already exists, the interactive flow reports the present value +
// scope, co-locates the missing value's scope, and prompts only for the
// gap. That interactive report/prompt is UNREACHABLE in this harness
// (detached:true → INTERACTIVE=0 → exactly-one-present routes to the
// non-interactive manual-setup elif), so the interactive report strings are
// pinned by source-slice in tests/init-credential-wording.test.ts. Here we
// pin the runtime CONTRACT that survives non-interactively: detection adds
// no GitHub API calls beyond the repo/org probes init.sh already performs
// (§req:init-credentials-prompt-criteria — "no GitHub API calls beyond the
// repo- and org-level probes"), no credential write happens on a re-run
// when something is already present, and the run completes (exit 0; runInit
// throws on non-zero).
describe("init.sh partial-credential detection adds no extra gh probing", () => {
  // The probe writes only into existing-state lookups; a re-run must never
  // issue `variable set` / `secret set`. Asserting their absence guards
  // against a regression where detection accidentally re-writes a present
  // value or over-writes during gap-fill in the non-interactive path.
  function assertNoCredentialWrites(ghLog: string): void {
    expect(ghLog).not.toMatch(/^variable set/m);
    expect(ghLog).not.toMatch(/^secret set/m);
  }

  it("both present at repo (user owner): reports both, writes nothing, no org probe", () => {
    const s = setup();
    try {
      const out = runInit(s, {
        GH_REPO_VARIABLE_LIST: "FLYWHEEL_GH_APP_ID",
        GH_REPO_SECRET_LIST: "FLYWHEEL_GH_APP_PRIVATE_KEY",
        GH_OWNER_TYPE: "User",
        GH_VARIABLE_VALUE: "123456",
      });

      const ghLog = readFileSync(s.ghLog, "utf8");
      // Both-present report (same-scope wording).
      expect(out).toContain(
        "FLYWHEEL_GH_APP_ID variable + FLYWHEEL_GH_APP_PRIVATE_KEY secret already set (repo-level).",
      );
      // No writes, no org probe (both present at repo → never fans out).
      assertNoCredentialWrites(ghLog);
      expect(ghLog).not.toMatch(/--org/);
      // Only the repo existence probes (one each) ran for detection.
      expect(ghLog).toMatch(/^variable list --json name/m);
      expect(ghLog).toMatch(/^secret list --json name/m);
      // App-ID readback still happens (apply-rulesets --app-id recovery).
      expect(ghLog).toMatch(
        /^variable get FLYWHEEL_GH_APP_ID --repo test-owner\/test-repo$/m,
      );
    } finally {
      teardown(s);
    }
  });

  it("both present at org: reports org-level, writes nothing", () => {
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
      expect(out).toContain("already set (org-level)");
      assertNoCredentialWrites(ghLog);
    } finally {
      teardown(s);
    }
  });

  it("exactly one present at repo (user owner): no org probe, no extra rounds", () => {
    const s = setup();
    try {
      // App ID present at repo, private key missing. User owner → no org
      // fan-out even though a value is missing.
      const out = runInit(s, {
        GH_REPO_VARIABLE_LIST: "FLYWHEEL_GH_APP_ID",
        GH_REPO_SECRET_LIST: "",
        GH_OWNER_TYPE: "User",
        GH_VARIABLE_VALUE: "123456",
      });

      const ghLog = readFileSync(s.ghLog, "utf8");
      // INTERACTIVE=0 → partial state routes to the manual-setup branch.
      expect(out).toContain(
        "non-interactive shell — skipping App-credential prompts",
      );
      assertNoCredentialWrites(ghLog);
      // No org-level probing for a user-owned repo.
      expect(ghLog).not.toMatch(/--org/);
      // Exactly the detection probes (repo variable+secret list) ran.
      expect(ghLog).toMatch(/^variable list --json name/m);
      expect(ghLog).toMatch(/^secret list --json name/m);
      // Single repo App-ID readback for the apply-rulesets --app-id recovery.
      const getCount = (ghLog.match(/^variable get FLYWHEEL_GH_APP_ID/gm) ?? [])
        .length;
      expect(getCount).toBe(1);
    } finally {
      teardown(s);
    }
  });

  it("exactly one present at org: probes org level once, no writes", () => {
    const s = setup();
    try {
      // Private key present at org, App ID missing everywhere. Owner is org
      // → the missing-value probe fans out to org level exactly once each.
      const out = runInit(s, {
        GH_REPO_VARIABLE_LIST: "",
        GH_REPO_SECRET_LIST: "",
        GH_ORG_VARIABLE_LIST: "",
        GH_ORG_SECRET_LIST: "FLYWHEEL_GH_APP_PRIVATE_KEY",
        GH_OWNER_TYPE: "Organization",
        GH_VARIABLE_VALUE: "",
        GH_ORG_VARIABLE_VALUE: "",
      });

      const ghLog = readFileSync(s.ghLog, "utf8");
      // INTERACTIVE=0 → manual-setup branch, no credential writes.
      expect(out).toContain(
        "non-interactive shell — skipping App-credential prompts",
      );
      assertNoCredentialWrites(ghLog);
      // Org fan-out: exactly one org variable list + one org secret list.
      expect(
        (ghLog.match(/^variable list --org test-owner/gm) ?? []).length,
      ).toBe(1);
      expect(
        (ghLog.match(/^secret list --org test-owner/gm) ?? []).length,
      ).toBe(1);
    } finally {
      teardown(s);
    }
  });

  it("--skip-secrets: prints the skip message and writes no credentials", () => {
    const s = setup();
    try {
      const out = runInit(
        s,
        { GH_OWNER_TYPE: "User" },
        ["--skip-secrets"],
      );

      const ghLog = readFileSync(s.ghLog, "utf8");
      expect(out).toContain(
        "--skip-secrets set; not touching the App's FLYWHEEL_GH_APP_ID Variable or FLYWHEEL_GH_APP_PRIVATE_KEY Secret.",
      );
      // The #235 contract under --skip-secrets: no credential WRITES happen.
      assertNoCredentialWrites(ghLog);
      // NOTE: the variable/secret list-probes DO appear in the gh log — they
      // come from the pre-flight environment pass (detect_credentials), which
      // runs up front regardless of --skip-secrets. #235's partial-state
      // detection REUSES that pre-flight result rather than adding its own
      // probes (§req:init-credentials-prompt — "no GitHub API calls beyond the
      // repo- and org-level probes init.sh already performs"), so there is no
      // extra credential probing to assert the absence of here.
    } finally {
      teardown(s);
    }
  });
});

// ===========================================================================
// WS4 (#233-3) — BROWNFIELD RE-RUN IDEMPOTENCY (SPEC.md §spec:brownfield-resolvers,
// §spec:brownfield-resolution: "idempotent — a second run re-reads live state").
//
// A resolver mutates pre-existing repo state once; a SECOND run must re-derive
// from the now-mutated LIVE state and neither re-offer the block nor re-apply the
// change. These cases stand up the post-resolution live state for each resolver
// and assert the re-run is quiet: no block named, no mutation re-attempted.
//
// This uses its OWN self-contained harness (separate from the credential-focused
// setup() above) because brownfield detection keys off local git tags + ruleset
// API responses + on-disk files, not the App-credential variable/secret probes.
// It ships a GREEN doctor stub via FLYWHEEL_DOCTOR_OVERRIDE so a resolved/quiet
// run reaches a clean exit under the end-of-run exit contract, and runs
// non-interactively (input "") — the resolved live state emits no block, so no
// interactive prompt is reachable and the run completes without one.
// ===========================================================================

const brownfieldGitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

/** A gh stub that answers auth/repo-view + the credential probes, and dispatches
 * `gh api …` over an ordered [needle, exit, stdout] ladder (default `[]`). Records
 * every `gh api -X PUT …rulesets/…` to $PUT_LOG so a re-run can assert NO PUT. */
function brownfieldGhStub(apiCases: Array<[string, number, string]>): string {
  const ladder = apiCases
    .map(
      ([needle, code, out]) =>
        `  if [[ "$args" == *${JSON.stringify(needle)}* ]]; then ` +
        `printf '%s' ${JSON.stringify(out)}; exit ${code}; fi`,
    )
    .join("\n");
  return (
    `#!/usr/bin/env bash\n` +
    `if [[ "$1" == "auth" && "$2" == "status" ]]; then echo "  - Token scopes: 'repo', 'admin:org', 'read:org'"; exit 0; fi\n` +
    `if [[ "$1" == "repo" && "$2" == "view" ]]; then echo "acme/widget"; exit 0; fi\n` +
    `if [[ "$1" == "variable" && "$2" == "list" ]]; then echo "FLYWHEEL_GH_APP_ID"; exit 0; fi\n` +
    `if [[ "$1" == "variable" && "$2" == "get" ]]; then echo "123"; exit 0; fi\n` +
    `if [[ "$1" == "variable" || "$1" == "secret" ]]; then echo ""; exit 0; fi\n` +
    `if [[ "$1" == "api" ]]; then\n` +
    `  shift\n` +
    `  args="$*"\n` +
    `  if [[ "$args" == *"-X PUT"*"rulesets/"* ]]; then printf 'PUT %s\\n' "$args" >> "$PUT_LOG"; exit 0; fi\n` +
    ladder +
    `\n  echo "[]"; exit 0\n` +
    `fi\n` +
    `echo "stub gh: unhandled: $*" >&2; exit 1\n`
  );
}

interface BrownfieldSandbox {
  work: string;
  binDir: string;
  doctorStub: string;
  putLog: string;
}

/** Stand up a git-init'd work dir with the brownfield gh + green doctor stubs,
 * the given pre-existing `tags`, and optional on-disk `files` (committed). */
function brownfieldSetup(opts: {
  apiCases?: Array<[string, number, string]>;
  tags?: string[];
  files?: Record<string, string>;
}): BrownfieldSandbox {
  const work = mkdtempSync(join(tmpdir(), "fw-bf-rerun-"));
  const binDir = join(work, "bin");
  mkdirSync(binDir);
  writeFileSync(join(binDir, "gh"), brownfieldGhStub(opts.apiCases ?? []));
  chmodSync(join(binDir, "gh"), 0o755);
  // Green doctor stub so a quiet re-run reaches a clean exit (exit contract).
  const doctorStub = join(binDir, "doctor-stub.sh");
  writeFileSync(
    doctorStub,
    "#!/usr/bin/env bash\nset -euo pipefail\nprintf 'DOCTOR_RESULT blocks=0 warns=0\\n'\nexit 0\n",
  );
  chmodSync(doctorStub, 0o755);
  const putLog = join(work, "put.log");
  writeFileSync(putLog, "");

  execFileSync("git", ["init", "-q"], { cwd: work });
  for (const [rel, contents] of Object.entries(opts.files ?? {})) {
    const dest = join(work, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, contents);
  }
  execFileSync("git", ["add", "-A"], { cwd: work, env: brownfieldGitEnv });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], {
    cwd: work,
    env: brownfieldGitEnv,
  });
  for (const tag of opts.tags ?? []) {
    execFileSync("git", ["tag", tag], { cwd: work, env: brownfieldGitEnv });
  }
  return { work, binDir, doctorStub, putLog };
}

function runBrownfield(s: BrownfieldSandbox): {
  status: number | null;
  out: string;
} {
  const res = spawnSync(
    "bash",
    [
      realInitSh,
      "--preset",
      "minimal",
      "--version",
      TEST_VERSION,
      "--skip-secrets",
      "--skip-rulesets",
    ],
    {
      cwd: s.work,
      encoding: "utf8",
      input: "",
      timeout: 30000,
      env: {
        ...process.env,
        PATH: `${s.binDir}:${process.env.PATH}`,
        FLYWHEEL_TEST_HOOKS: "1",
        FLYWHEEL_DOCTOR_OVERRIDE: s.doctorStub,
        FLYWHEEL_ASSUME_INTERACTIVE: "1",
        PUT_LOG: s.putLog,
      },
    },
  );
  return { status: res.status, out: (res.stdout ?? "") + (res.stderr ?? "") };
}

function bfLocalTags(work: string): string[] {
  return execFileSync("git", ["tag", "-l"], { cwd: work, encoding: "utf8" })
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function bfPutLines(putLog: string): string[] {
  return readFileSync(putLog, "utf8").split("\n").filter(Boolean);
}

/** A branch ruleset on refs/heads/main with a pull_request rule + given bypass. */
const bfRuleset = (id: number, bypass: unknown[] = []) =>
  JSON.stringify({
    id,
    name: `protect-main-${id}`,
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
    rules: [{ type: "pull_request" }, { type: "non_fast_forward" }],
    bypass_actors: bypass,
  });

describe("brownfield resolver re-run idempotency", () => {
  it("retag: repo already has 3.4.2 AND v3.4.2 ⇒ re-run emits no bare-semver block, no re-tag", () => {
    // Post-retag live state: both the bare tag and its v-twin exist.
    const s = brownfieldSetup({ tags: ["3.4.2", "v3.4.2"] });
    try {
      const r = runBrownfield(s);
      // Clean re-run: no collision block, no brownfield hard-stop, exit 0.
      expect(r.status, `out:\n${r.out}`).toBe(0);
      expect(r.out).not.toMatch(/collide with Flywheel's v-prefixed scheme/);
      expect(r.out).not.toContain("Brownfield conditions need your hand");
      expect(r.out).not.toContain("Create and push these v-prefixed tags?");
      // No new tag created (v3.4.2 already present, none added; no other v* tags).
      const tags = bfLocalTags(s.work);
      expect(tags.filter((t) => t.startsWith("v"))).toEqual(["v3.4.2"]);
      expect(tags).toContain("3.4.2");
      expect(existsSync(join(s.work, ".flywheel.yml"))).toBe(true);
    } finally {
      rmSync(s.work, { recursive: true, force: true });
    }
  });

  it("release removal: prior release file already gone ⇒ re-run detects no release conflict", () => {
    // Post-removal live state: the prior release-system file is gone (committed
    // removal), so the working tree has no release-system file → detector flags
    // nothing. Only a benign CI workflow remains.
    const s = brownfieldSetup({
      files: {
        ".github/workflows/ci.yml":
          "name: ci\non:\n  pull_request:\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n",
      },
    });
    try {
      const r = runBrownfield(s);
      expect(r.status, `out:\n${r.out}`).toBe(0);
      expect(r.out).not.toMatch(/races Flywheel's tag\/release creation/);
      expect(r.out).not.toContain("Remove these prior release-system files?");
      expect(r.out).not.toContain("Brownfield conditions need your hand");
      expect(existsSync(join(s.work, ".flywheel.yml"))).toBe(true);
    } finally {
      rmSync(s.work, { recursive: true, force: true });
    }
  });

  it("bypass: ruleset already lists the App as Integration bypass ⇒ re-run emits no block, no ruleset PUT", () => {
    // Post-resolution live state: ruleset 1 already carries the App's Integration
    // bypass entry, so the detector does not flag a branch_protection_bypass block.
    const s = brownfieldSetup({
      apiCases: [
        ["repos/acme/widget/branches/main/protection", 1, ""],
        ["repos/acme/widget/branches/main", 0, ""],
        [
          "repos/acme/widget/rulesets/1",
          0,
          bfRuleset(1, [{ actor_id: 123, actor_type: "Integration", bypass_mode: "always" }]),
        ],
        ["repos/acme/widget/rulesets", 0, JSON.stringify([{ id: 1, target: "branch" }])],
      ],
    });
    try {
      const r = runBrownfield(s);
      expect(r.status, `out:\n${r.out}`).toBe(0);
      expect(r.out).not.toMatch(/omits the Flywheel App as a bypass actor/);
      expect(r.out).not.toContain("Add the Flywheel App as a bypass actor");
      expect(r.out).not.toContain("Brownfield conditions need your hand");
      // No ruleset PUT issued on the re-run.
      expect(bfPutLines(s.putLog)).toEqual([]);
      expect(existsSync(join(s.work, ".flywheel.yml"))).toBe(true);
    } finally {
      rmSync(s.work, { recursive: true, force: true });
    }
  });
});
