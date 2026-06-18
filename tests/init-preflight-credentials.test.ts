import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { stripAnsi } from "./helpers/ansi.js";
import { writeDoctorStub } from "./helpers/doctorStub.js";

// End-to-end exercise of scripts/init.sh's READ-ONLY pre-flight App-credentials
// and GitHub-App detector (SPEC.md §spec:preflight-credentials-app). The detector
// lives in preflight_detect_credentials_app (detect_credentials +
// detect_app_installation), runs once inside the single pre-flight pass, and emits
// only info/warn findings — a clean greenfield repo must therefore see no blockers.
//
// These tests pin the detector's observable contract: the exact finding strings it
// renders (via scripts/lib/findings.sh, as `  <glyph> [<bucket>] <message>`), and
// that they appear under the single "Pre-flight checks:" header before any scaffold
// write. We assert on BOTH the bucket label ([config]/[instance]) AND the message
// text, to prove each finding carries a bucket and a severity.
//
// Hermetic with NO real gh/network: a PATH-shadowed `gh` stub (a bash case
// statement parameterized per scenario via env vars it reads) answers every gh
// call the detector makes; unhandled calls exit 1, which the detector tolerates
// (each call is `2>/dev/null || true`) and models as absent/unknown. init.sh is
// invoked by its real repo path so SCRIPT_DIR resolves to <repoRoot>/scripts and
// findings.sh + local presets are found on disk (no curl). Runs are non-interactive
// (input: "", no FLYWHEEL_ASSUME_INTERACTIVE) so the late prompt path is skipped.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const initSh = join(repoRoot, "scripts/init.sh");

const SCAFFOLD_ARGS = [
  "--preset",
  "minimal",
  "--version",
  "v0-preflight-test",
  "--skip-rulesets",
];

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  work: string;
}

// A configurable `gh` stub. It always answers `gh repo view` (REPO/OWNER
// resolution, required before pre-flight) with acme/widget, and `gh api users/acme`
// (owner type) from $STUB_OWNER_TYPE. The remaining branches are gated on env vars
// the stub reads, so each scenario parameterizes the stub purely through `env`:
//
//   STUB_OWNER_TYPE             Organization | User       (gh api users/acme)
//   STUB_REPO_VARS              newline list for repo `gh variable list`
//   STUB_REPO_SECRETS           newline list for repo `gh secret list`
//   STUB_ORG_VARS               newline list for org `gh variable list --org`
//   STUB_ORG_SECRETS            newline list for org `gh secret list --org`
//   STUB_REPO_APP_ID            value for `gh variable get ... --repo`
//   STUB_ORG_APP_ID             value for `gh variable get ... --org`
//   STUB_INSTALLED_APP_IDS      newline list for `gh api orgs/acme/installations`
//
// Any branch whose env var is empty/unset exits 1, which the detector treats as
// absent/unknown — this is exactly how a greenfield repo is modelled.
const GH_STUB = `#!/usr/bin/env bash
set -u

emit_or_fail() { # $1 = value; print non-empty value (exit 0) else exit 1
  if [[ -n "\${1:-}" ]]; then printf '%s\n' "\$1"; exit 0; fi
  exit 1
}

# gh auth status (pre-flight gh-capability probe — authenticated, repo scope)
if [[ "\${1:-}" == "auth" && "\${2:-}" == "status" ]]; then
  echo "  - Token scopes: 'repo', 'read:org'"; exit 0
fi

# gh repo view --json nameWithOwner -q .nameWithOwner
if [[ "\${1:-}" == "repo" && "\${2:-}" == "view" ]]; then
  echo "acme/widget"; exit 0
fi

# gh api ...
if [[ "\${1:-}" == "api" ]]; then
  case "\${2:-}" in
    users/acme) emit_or_fail "\${STUB_OWNER_TYPE:-}";;
    orgs/acme/installations) emit_or_fail "\${STUB_INSTALLED_APP_IDS:-}";;
  esac
  exit 1
fi

# gh variable list [--org acme] --json name -q '.[].name'
if [[ "\${1:-}" == "variable" && "\${2:-}" == "list" ]]; then
  if [[ "\$*" == *"--org"* ]]; then emit_or_fail "\${STUB_ORG_VARS:-}"; fi
  emit_or_fail "\${STUB_REPO_VARS:-}"
fi

# gh secret list [--org acme] --json name -q '.[].name'
if [[ "\${1:-}" == "secret" && "\${2:-}" == "list" ]]; then
  if [[ "\$*" == *"--org"* ]]; then emit_or_fail "\${STUB_ORG_SECRETS:-}"; fi
  emit_or_fail "\${STUB_REPO_SECRETS:-}"
fi

# gh variable get FLYWHEEL_GH_APP_ID (--repo acme/widget | --org acme)
if [[ "\${1:-}" == "variable" && "\${2:-}" == "get" ]]; then
  if [[ "\$*" == *"--org"* ]]; then emit_or_fail "\${STUB_ORG_APP_ID:-}"; fi
  emit_or_fail "\${STUB_REPO_APP_ID:-}"
fi

echo "stub gh: unhandled: \$*" >&2; exit 1
`;

/** Run init.sh from a fresh git-init'd temp cwd with the configurable PATH-shadowed
 * `gh` stub above. Non-interactive (input: ""). Returns raw streams + the work dir. */
function runInit(opts: { args?: string[]; env?: Record<string, string> } = {}): RunResult {
  const work = mkdtempSync(join(tmpdir(), "flywheel-preflight-cred-"));
  const binDir = join(work, "bin");
  mkdirSync(binDir);
  const gh = join(binDir, "gh");
  writeFileSync(gh, GH_STUB);
  chmodSync(gh, 0o755);
  // Pin end-of-run validation to a green doctor stub so this PRE-FLIGHT suite
  // isn't flipped non-zero by spurious doctor blocks under the exit contract
  // (§spec:setup-exit-contract); see writeDoctorStub for the full rationale.
  const doctorStub = writeDoctorStub(binDir, { blocks: 0, warns: 0 });
  execFileSync("git", ["init", "-q"], { cwd: work });
  const r = spawnSync("bash", [initSh, ...(opts.args ?? SCAFFOLD_ARGS)], {
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

/** stdout up to (but excluding) the first scaffold/gate output, so assertions are
 * scoped to the pre-flight section as required. */
function preflightSection(stdout: string): string {
  const out = stripAnsi(stdout);
  const header = out.indexOf("Pre-flight checks:");
  // The first thing after the pre-flight summary line is the templates/scaffold
  // output ("templates will pin to:" / "wrote .flywheel.yml"). Cut there.
  const cut = out.indexOf("templates will pin to:");
  return cut > header ? out.slice(header, cut) : out.slice(header);
}

describe("init.sh — pre-flight App-credentials & GitHub-App detection (§spec:preflight-credentials-app)", () => {
  it("credentials present at REPO level + App installed → repo-level findings + installed", () => {
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
      const pre = preflightSection(r.stdout);
      expect(r.status, `stderr:\n${r.stderr}\nstdout:\n${stripAnsi(r.stdout)}`).toBe(0);
      expect(pre).toContain("[config] FLYWHEEL_GH_APP_ID variable found (repo-level)");
      expect(pre).toContain("[config] FLYWHEEL_GH_APP_PRIVATE_KEY secret found (repo-level)");
      expect(pre).toContain("[instance] GitHub App (id 12345) installed on acme");
      expect(pre).toContain("pre-flight: no blockers.");
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("credentials present at ORG level → org-level findings for both variable and secret", () => {
    const r = runInit({
      env: {
        STUB_OWNER_TYPE: "Organization",
        // repo-level lists empty (stub branches exit 1) → detector falls through to org.
        STUB_ORG_VARS: "FLYWHEEL_GH_APP_ID",
        STUB_ORG_APP_ID: "12345",
        STUB_ORG_SECRETS: "FLYWHEEL_GH_APP_PRIVATE_KEY",
        STUB_INSTALLED_APP_IDS: "12345",
      },
    });
    try {
      const pre = preflightSection(r.stdout);
      expect(r.status, `stderr:\n${r.stderr}\nstdout:\n${stripAnsi(r.stdout)}`).toBe(0);
      expect(pre).toContain("[config] FLYWHEEL_GH_APP_ID variable found (org-level)");
      expect(pre).toContain("[config] FLYWHEEL_GH_APP_PRIVATE_KEY secret found (org-level)");
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("App-ID present but NOT installed → warn-severity not-installed finding, run still 0", () => {
    const r = runInit({
      env: {
        STUB_OWNER_TYPE: "Organization",
        STUB_REPO_VARS: "FLYWHEEL_GH_APP_ID",
        STUB_REPO_APP_ID: "12345",
        STUB_REPO_SECRETS: "FLYWHEEL_GH_APP_PRIVATE_KEY",
        STUB_INSTALLED_APP_IDS: "99999", // a different App installed, not ours
      },
    });
    try {
      const pre = preflightSection(r.stdout);
      expect(r.status, `stderr:\n${r.stderr}\nstdout:\n${stripAnsi(r.stdout)}`).toBe(0);
      expect(pre).toContain(
        "[instance] GitHub App (id 12345) not installed on acme — install it so installation-token minting works",
      );
      // The not-installed finding is warn severity: rendered with the `!` glyph.
      expect(pre).toMatch(/!\s+\[instance\] GitHub App \(id 12345\) not installed on acme/);
      // warn never halts.
      expect(pre).toContain("pre-flight: no blockers.");
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("greenfield / clean repo → not-set + no-App-ID info findings, no blockers (backward compat)", () => {
    // Stub answers ONLY gh repo view; everything else exits 1 (no env vars set).
    const r = runInit();
    try {
      const pre = preflightSection(r.stdout);
      expect(r.status, `stderr:\n${r.stderr}\nstdout:\n${stripAnsi(r.stdout)}`).toBe(0);
      expect(pre).toContain(
        "[config] FLYWHEEL_GH_APP_ID variable not set (setup will provision it)",
      );
      expect(pre).toContain(
        "[config] FLYWHEEL_GH_APP_PRIVATE_KEY secret not set (setup will provision it)",
      );
      expect(pre).toContain(
        "[instance] GitHub App installation: no App ID configured yet (setup will create or prompt for the App)",
      );
      expect(pre).toContain("pre-flight: no blockers.");
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("runs in a single pass: credential + App findings appear under one Pre-flight header, prompts untouched", () => {
    // Scenario 1's stub (everything present + installed).
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

      // Exactly one pre-flight pass — a single header.
      const headers = out.split("Pre-flight checks:").length - 1;
      expect(headers).toBe(1);

      // The detector lives IN the pre-flight pass: its findings come after the
      // header and before the summary line / any scaffold write.
      const headerAt = out.indexOf("Pre-flight checks:");
      const varAt = out.indexOf("FLYWHEEL_GH_APP_ID variable found");
      const appAt = out.indexOf("GitHub App (id 12345) installed on acme");
      const summaryAt = out.indexOf("pre-flight: no blockers.");
      const writeAt = out.indexOf("wrote .flywheel.yml");
      expect(headerAt).toBeGreaterThanOrEqual(0);
      expect(varAt).toBeGreaterThan(headerAt);
      expect(appAt).toBeGreaterThan(headerAt);
      expect(varAt).toBeLessThan(summaryAt);
      expect(appAt).toBeLessThan(summaryAt);
      expect(summaryAt).toBeLessThan(writeAt);

      // The detector is additive and does not introduce a setup-path prompt:
      // a non-interactive run defaults the preset without any "Pick a setup path"
      // wording in the pre-flight pass.
      expect(preflightSection(r.stdout)).not.toContain("Pick a setup path");
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });
});
