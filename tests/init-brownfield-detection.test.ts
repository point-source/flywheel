import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
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

// End-to-end exercise of scripts/init.sh's READ-ONLY brownfield detectors
// (SPEC.md §spec:brownfield-detection), driven through the real pre-flight pass +
// gate (§spec:preflight-gate). Sibling workstreams add further detectors (branch
// protection, signed-commit/tag, history awareness) to THIS file — keep each
// detector's cases in its own describe block.
//
// This slice covers preflight_detect_version_tag_shape: pre-existing tags whose
// shape would mislead semantic-release's v-prefixed versioning. The detector reads
// tags via `git tag -l`, so these tests create REAL local tags in the work dir
// BEFORE invoking init, exercising the classification logic end to end.
//
// Hermetic with NO real gh/network: a PATH-shadowed `gh` stub answers `gh auth
// status`, `gh repo view`, and a default `gh api …` branch (echoing `[]`) so
// unrelated detectors stay quiet. SCAFFOLD_ARGS make init skip the credential
// prompts and apply-rulesets — leaving the gate as the first thing that can change
// observable state.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const initSh = join(repoRoot, "scripts/init.sh");

const SCAFFOLD_ARGS = [
  "--preset",
  "minimal",
  "--version",
  "v0-preflight-test",
  "--skip-secrets",
  "--skip-rulesets",
];

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  work: string;
}

/** Run init.sh from a fresh git-init'd temp cwd with a PATH-shadowed `gh` stub.
 * The stub answers `gh auth status` (with classic Token scopes so the gh-capability
 * detector stays green), `gh repo view` (acme/widget), and a default `gh api …`
 * branch that echoes `[]` and exits 0 so the remote-tag cross-check and other
 * detectors stay quiet. `tags` are created as REAL git tags in the work dir BEFORE
 * invoking init, so preflight_detect_version_tag_shape actually classifies them. */
function runInit(
  opts: { args?: string[]; env?: Record<string, string>; tags?: string[] } = {},
): RunResult {
  const work = mkdtempSync(join(tmpdir(), "flywheel-brownfield-"));
  const binDir = join(work, "bin");
  mkdirSync(binDir);
  const gh = join(binDir, "gh");
  writeFileSync(
    gh,
    `#!/usr/bin/env bash\n` +
      `if [[ "$1" == "auth" && "$2" == "status" ]]; then echo "  - Token scopes: 'repo', 'read:org'"; exit 0; fi\n` +
      `if [[ "$1" == "repo" && "$2" == "view" ]]; then echo "acme/widget"; exit 0; fi\n` +
      `if [[ "$1" == "api" ]]; then echo "[]"; exit 0; fi\n` +
      `echo "stub gh: unhandled: $*" >&2; exit 1\n`,
  );
  chmodSync(gh, 0o755);
  // Pin end-of-run validation to a green doctor stub so this PRE-FLIGHT suite
  // isn't flipped non-zero by spurious doctor blocks under the exit contract
  // (§spec:setup-exit-contract).
  const doctorStub = writeDoctorStub(binDir, { blocks: 0, warns: 0 });
  execFileSync("git", ["init", "-q"], { cwd: work });
  // git tags need a commit to point at — make a hermetic empty one before tagging.
  if ((opts.tags ?? []).length > 0) {
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    };
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: work, env: gitEnv });
    for (const tag of opts.tags ?? []) {
      execFileSync("git", ["tag", tag], { cwd: work, env: gitEnv });
    }
  }
  const r = spawnSync("bash", [initSh, ...(opts.args ?? [])], {
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

describe("init.sh — brownfield version-tag-shape detection", () => {
  it("bare-semver tag 3.4.2 ⇒ instance+block, resolvable by re-tagging with 'v'; writes nothing", () => {
    const r = runInit({ args: SCAFFOLD_ARGS, tags: ["3.4.2"] });
    try {
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).not.toBe(0);
      expect(combined).toMatch(/pre-flight (failed|halted)/i);
      expect(combined).toContain("[instance]");
      expect(combined).toContain("3.4.2");
      expect(combined).toMatch(/re-tagging with a 'v'|v.?prefix/i);
      expect(existsSync(join(r.work, ".flywheel.yml")), "expected .flywheel.yml NOT written").toBe(
        false,
      );
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("non-semver release-2024-q4 ⇒ instance+block, needs adopter baseline / not auto-resolvable", () => {
    const r = runInit({ args: SCAFFOLD_ARGS, tags: ["release-2024-q4"] });
    try {
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).not.toBe(0);
      expect(combined).toMatch(/pre-flight (failed|halted)/i);
      expect(combined).toContain("[instance]");
      expect(combined).toContain("release-2024-q4");
      expect(combined).toMatch(/baseline choice/i);
      expect(combined).toMatch(/not auto-resolvable/i);
      expect(existsSync(join(r.work, ".flywheel.yml"))).toBe(false);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("stable-v1 ⇒ instance+block (non-semver named-release path)", () => {
    const r = runInit({ args: SCAFFOLD_ARGS, tags: ["stable-v1"] });
    try {
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).not.toBe(0);
      expect(combined).toMatch(/pre-flight (failed|halted)/i);
      expect(combined).toContain("[instance]");
      expect(combined).toContain("stable-v1");
      expect(combined).toMatch(/not auto-resolvable/i);
      expect(existsSync(join(r.work, ".flywheel.yml"))).toBe(false);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("prerelease bare-semver 3.4.2-rc1 ⇒ instance+block, retag-resolvable (incl. prerelease)", () => {
    const r = runInit({ args: SCAFFOLD_ARGS, tags: ["3.4.2-rc1"] });
    try {
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).not.toBe(0);
      expect(combined).toContain("[instance]");
      expect(combined).toContain("3.4.2-rc1");
      expect(combined).toMatch(/re-tagging with a 'v'|v.?prefix/i);
      expect(existsSync(join(r.work, ".flywheel.yml"))).toBe(false);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("4-component 3.4.2.5 (not semver) ⇒ no block (exotic-ignore, false-negative bias)", () => {
    const r = runInit({ args: SCAFFOLD_ARGS, tags: ["3.4.2.5"] });
    try {
      const out = stripAnsi(r.stdout);
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).toBe(0);
      expect(out).toContain("pre-flight: no blockers.");
      expect(combined).not.toMatch(/collide with Flywheel's v-prefixed scheme/);
      expect(existsSync(join(r.work, ".flywheel.yml"))).toBe(true);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("clean repo with only v1.2.3 ⇒ no block, proceeds and writes .flywheel.yml", () => {
    const r = runInit({ args: SCAFFOLD_ARGS, tags: ["v1.2.3"] });
    try {
      const out = stripAnsi(r.stdout);
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).toBe(0);
      expect(out).toContain("pre-flight: no blockers.");
      expect(combined).not.toMatch(/collide with Flywheel's v-prefixed scheme/);
      expect(existsSync(join(r.work, ".flywheel.yml"))).toBe(true);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("clean repo with an unrelated tag (nightly) ⇒ no block (false-negative bias), proceeds", () => {
    const r = runInit({ args: SCAFFOLD_ARGS, tags: ["nightly"] });
    try {
      const out = stripAnsi(r.stdout);
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).toBe(0);
      expect(out).toContain("pre-flight: no blockers.");
      expect(combined).not.toMatch(/collide with Flywheel's v-prefixed scheme/);
      expect(existsSync(join(r.work, ".flywheel.yml"))).toBe(true);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// preflight_detect_branch_protection_bypass (§spec:brownfield-detection).
//
// This detector probes the REMOTE (branch existence + rulesets) via `gh api`, so
// unlike the tag-shape suite it drives behavior entirely through a configurable
// `gh` stub rather than local git state. The stub dispatches on the full arg
// string ("$*") to return realistic ruleset/branch JSON; the cases vary the
// ruleset detail (blocking rules + bypass_actors) to exercise hazard / no-hazard
// / could-not-verify paths. .flywheel.yml-written assertions confirm the gate
// behaves (block ⇒ nothing written; clean ⇒ written).
// ---------------------------------------------------------------------------

/** Run init with a gh stub whose `gh api …` responses are scripted by `apiCases`
 * (an ordered list of [matchSubstring, exitCode, stdout]). The first case whose
 * substring appears in the full `gh api` arg string wins; unmatched `gh api`
 * calls fall back to echoing `[]` exit 0 so unrelated detectors stay quiet.
 * `gh auth status` and `gh repo view` always answer so the gh-capability /
 * REPO-resolution detectors stay green. A thin wrapper over runInitCfg (defined
 * below, the general config-aware runner) with the default scaffold args — BP
 * cases need neither its gh-call log nor its fixture-config / arg overrides. */
function runInitBP(
  apiCases: Array<[string, number, string]>,
  opts: { env?: Record<string, string> } = {},
): RunResult {
  return runInitCfg(apiCases, opts);
}

// Ruleset detail covering refs/heads/main with a pull_request rule. `bypass` is
// spliced into bypass_actors so a case can include/omit the Integration App.
const rulesetDetail = (bypass: string) =>
  JSON.stringify({
    id: 1,
    target: "branch",
    conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
    rules: [{ type: "pull_request" }],
    bypass_actors: JSON.parse(bypass),
  });

// Ruleset scoped to ~DEFAULT_BRANCH (the repo's default branch only), PR-required,
// no bypass actors — exercises that ~DEFAULT_BRANCH coverage is evaluated against
// the ACTUAL default branch, not treated as covering every managed branch.
const rulesetDefaultBranch = JSON.stringify({
  id: 2,
  target: "branch",
  conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
  rules: [{ type: "pull_request" }],
  bypass_actors: [],
});

describe("init.sh — brownfield branch-protection bypass detection", () => {
  it("main protected (PR-required) with EMPTY bypass_actors ⇒ [instance] block; exits non-zero; no .flywheel.yml", () => {
    const r = runInitBP([
      ["repos/acme/widget/branches/main", 0, ""],
      ["repos/acme/widget/rulesets/1", 0, rulesetDetail("[]")],
      ["repos/acme/widget/rulesets", 0, JSON.stringify([{ id: 1, target: "branch" }])],
    ]);
    try {
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).not.toBe(0);
      expect(combined).toMatch(/pre-flight (failed|halted)/i);
      expect(combined).toContain("[instance]");
      expect(combined).toContain("main");
      expect(combined).toMatch(/bypass actor/i);
      expect(existsSync(join(r.work, ".flywheel.yml")), "expected .flywheel.yml NOT written").toBe(
        false,
      );
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("main protected but bypass_actors lists the Integration App ⇒ NO block; proceeds; writes .flywheel.yml", () => {
    const r = runInitBP([
      ["repos/acme/widget/branches/main", 0, ""],
      [
        "repos/acme/widget/rulesets/1",
        0,
        rulesetDetail('[{"actor_type":"Integration","actor_id":123}]'),
      ],
      ["repos/acme/widget/rulesets", 0, JSON.stringify([{ id: 1, target: "branch" }])],
    ]);
    try {
      const out = stripAnsi(r.stdout);
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).toBe(0);
      expect(out).toContain("pre-flight: no blockers.");
      expect(combined).not.toMatch(/omits the Flywheel App as a bypass actor/);
      expect(existsSync(join(r.work, ".flywheel.yml"))).toBe(true);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("ruleset scoped to ~DEFAULT_BRANCH (default=main), no App bypass ⇒ flags ONLY main, NOT develop/staging (no false positive)", () => {
    const r = runInitBP([
      // The default-branch read (`gh api repos/$REPO -q .default_branch`); the stub
      // can't apply -q, so it returns the already-extracted value directly.
      [".default_branch", 0, "main"],
      ["repos/acme/widget/rulesets/2", 0, rulesetDefaultBranch],
      ["repos/acme/widget/rulesets", 0, JSON.stringify([{ id: 2, target: "branch" }])],
    ]);
    try {
      const combined = stripAnsi(r.stdout + r.stderr);
      // main IS the default branch, so the ~DEFAULT_BRANCH rule genuinely applies.
      expect(r.status, `combined:\n${combined}`).not.toBe(0);
      expect(combined).toContain("[instance]");
      expect(combined).toMatch(/bypass actor/i);
      expect(combined).toContain("main");
      // The fix: develop/staging are NOT the default branch, so the ~DEFAULT_BRANCH
      // rule must not falsely flag them.
      expect(combined).not.toMatch(/\bdevelop\b/);
      expect(combined).not.toMatch(/\bstaging\b/);
      expect(existsSync(join(r.work, ".flywheel.yml"))).toBe(false);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("rulesets listable but a ruleset DETAIL read fails ⇒ could-not-verify warn (local-env), NOT a block; proceeds", () => {
    const r = runInitBP([
      ["repos/acme/widget/branches/main", 0, ""],
      // Detail read fails (exit non-zero) — must not collapse into a false block.
      ["repos/acme/widget/rulesets/1", 1, ""],
      ["repos/acme/widget/rulesets", 0, JSON.stringify([{ id: 1, target: "branch" }])],
    ]);
    try {
      const out = stripAnsi(r.stdout);
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).toBe(0);
      expect(out).toContain("pre-flight: no blockers.");
      expect(combined).toContain("[local-env]");
      expect(combined).toMatch(/could not verify/i);
      expect(combined).not.toMatch(/omits the Flywheel App as a bypass actor/);
      expect(existsSync(join(r.work, ".flywheel.yml"))).toBe(true);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("no rulesets / no protection (rulesets ⇒ []) but branches exist ⇒ NO block, proceeds (greenfield parity)", () => {
    const r = runInitBP([
      // Order matters: the case-ladder matches the first substring hit, so the
      // more-specific `…/protection` path must precede the bare branch path.
      // Classic-protection fallback returns 404-ish (non-zero) → no protection.
      ["repos/acme/widget/branches/main/protection", 1, ""],
      ["repos/acme/widget/branches/main", 0, ""],
      ["repos/acme/widget/rulesets", 0, "[]"],
    ]);
    try {
      const out = stripAnsi(r.stdout);
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).toBe(0);
      expect(out).toContain("pre-flight: no blockers.");
      expect(combined).not.toMatch(/omits the Flywheel App as a bypass actor/);
      expect(combined).not.toMatch(/could not verify .* branch protection bypass/);
      expect(existsSync(join(r.work, ".flywheel.yml"))).toBe(true);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// preflight_detect_signed_commit_requirement (§spec:brownfield-detection).
// A "require signed commits/tags" rule on a managed branch (or refs/tags/v*)
// that flywheel's App identity can't satisfy ⇒ instance + block, NOT
// auto-resolvable. Reuses the configurable runInitBP gh stub. To isolate the
// signing dimension from the branch-protection-bypass detector, the hazard
// rulesets here carry ONLY a required_signatures rule (no pull_request rule),
// so the bypass detector finds no blocking rule and stays quiet.
// ---------------------------------------------------------------------------

// Branch ruleset on refs/heads/<branch> with the given `rules` array.
const branchRuleset = (rules: object[], branch = "main") =>
  JSON.stringify({
    id: 1,
    target: "branch",
    conditions: { ref_name: { include: [`refs/heads/${branch}`], exclude: [] } },
    rules,
    bypass_actors: [],
  });

describe("init.sh — brownfield signed-commit requirement detection", () => {
  it("main ruleset has required_signatures ⇒ [instance] block; exits non-zero; NOT auto-resolvable; no .flywheel.yml", () => {
    const r = runInitBP([
      ["repos/acme/widget/branches/main", 0, ""],
      ["repos/acme/widget/rulesets/1", 0, branchRuleset([{ type: "required_signatures" }])],
      ["repos/acme/widget/rulesets", 0, JSON.stringify([{ id: 1, target: "branch" }])],
    ]);
    try {
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).not.toBe(0);
      expect(combined).toMatch(/pre-flight (failed|halted)/i);
      expect(combined).toContain("[instance]");
      expect(combined).toContain("main");
      expect(combined).toMatch(/signed commits\/tags/i);
      expect(combined).toMatch(/NOT auto-resolvable/i);
      // The bypass detector must NOT also fire (no pull_request rule present).
      expect(combined).not.toMatch(/omits the Flywheel App as a bypass actor/);
      expect(existsSync(join(r.work, ".flywheel.yml")), "expected .flywheel.yml NOT written").toBe(
        false,
      );
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("ruleset with NO required_signatures rule ⇒ NO block from this detector; proceeds; writes .flywheel.yml", () => {
    const r = runInitBP([
      ["repos/acme/widget/branches/main", 0, ""],
      // pull_request rule WITH an Integration bypass actor: the bypass detector
      // stays quiet, and there is no required_signatures rule for THIS detector.
      [
        "repos/acme/widget/rulesets/1",
        0,
        JSON.stringify({
          id: 1,
          target: "branch",
          conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
          rules: [{ type: "pull_request" }],
          bypass_actors: [{ actor_type: "Integration", actor_id: 123 }],
        }),
      ],
      ["repos/acme/widget/rulesets", 0, JSON.stringify([{ id: 1, target: "branch" }])],
    ]);
    try {
      const out = stripAnsi(r.stdout);
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).toBe(0);
      expect(out).toContain("pre-flight: no blockers.");
      expect(combined).not.toMatch(/signed commits\/tags/i);
      expect(existsSync(join(r.work, ".flywheel.yml"))).toBe(true);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("ruleset DETAIL read fails ⇒ could-not-verify warn (local-env), NOT a block; proceeds", () => {
    const r = runInitBP([
      ["repos/acme/widget/branches/main/protection", 1, ""],
      ["repos/acme/widget/branches/main", 0, ""],
      // Detail read fails ⇒ PREFLIGHT_RULESET_UNREADABLE; must not collapse to a block.
      ["repos/acme/widget/rulesets/1", 1, ""],
      ["repos/acme/widget/rulesets", 0, JSON.stringify([{ id: 1, target: "branch" }])],
    ]);
    try {
      const out = stripAnsi(r.stdout);
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).toBe(0);
      expect(out).toContain("pre-flight: no blockers.");
      expect(combined).toContain("[local-env]");
      expect(combined).toMatch(/could not verify .* signed-commit requirement/i);
      expect(combined).not.toMatch(/^\s*✗.*signed commits\/tags/im);
      expect(existsSync(join(r.work, ".flywheel.yml"))).toBe(true);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("tag-target ruleset on refs/tags/v* with required_signatures ⇒ [instance] block; no .flywheel.yml", () => {
    const r = runInitBP([
      ["repos/acme/widget/branches/main/protection", 1, ""],
      ["repos/acme/widget/branches/main", 0, ""],
      // Branch ruleset detail: no signing rule on the branch itself.
      ["repos/acme/widget/rulesets/1", 0, branchRuleset([])],
      // Tag ruleset detail: required_signatures on refs/tags/v*.
      [
        "repos/acme/widget/rulesets/2",
        0,
        JSON.stringify({
          id: 2,
          target: "tag",
          conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
          rules: [{ type: "required_signatures" }],
          bypass_actors: [],
        }),
      ],
      [
        "repos/acme/widget/rulesets",
        0,
        JSON.stringify([
          { id: 1, target: "branch" },
          { id: 2, target: "tag" },
        ]),
      ],
    ]);
    try {
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).not.toBe(0);
      expect(combined).toMatch(/pre-flight (failed|halted)/i);
      expect(combined).toContain("[instance]");
      expect(combined).toContain("refs/tags/v*");
      expect(combined).toMatch(/signed commits\/tags/i);
      expect(existsSync(join(r.work, ".flywheel.yml")), "expected .flywheel.yml NOT written").toBe(
        false,
      );
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// preflight_detect_history_and_prs (§spec:brownfield-detection).
//
// ADVISORY-ONLY detector: legacy non-conventional / [skip ci] commits in recent
// history, and open PRs whose titles flywheel rewrites at cutover, are reported
// as `info` (with a could-not-verify `warn` for the token-gated PR read). Flywheel
// cannot/should not mutate history or others' PRs, so these NEVER halt setup — in
// every case the run proceeds (exit 0) and writes .flywheel.yml. The history scan
// reads REAL git commits in the work dir; the PR scan is driven by a `gh api …
// pulls` stub returning a JSON array of PR objects with `title` fields.
// ---------------------------------------------------------------------------

const GIT_IDENT = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

/** Run init with REAL commits in the work-dir git repo and a `gh` stub whose
 * `gh api …/pulls…` response is scripted by `pulls` ([exitCode, stdout]); all
 * other `gh api …` calls (auth/repo-view aside) echo `[]` exit 0 so the OTHER
 * brownfield detectors stay quiet. `commits` are made (oldest→newest) as
 * `git commit --allow-empty` with a committer identity so they succeed in CI. */
function runInitHist(opts: {
  commits: string[];
  pulls?: [number, string];
}): RunResult {
  const work = mkdtempSync(join(tmpdir(), "flywheel-hist-"));
  const binDir = join(work, "bin");
  mkdirSync(binDir);
  const gh = join(binDir, "gh");
  const [pullsCode, pullsOut] = opts.pulls ?? [0, "[]"];
  writeFileSync(
    gh,
    `#!/usr/bin/env bash\n` +
      `if [[ "$1" == "auth" && "$2" == "status" ]]; then echo "  - Token scopes: 'repo', 'read:org'"; exit 0; fi\n` +
      `if [[ "$1" == "repo" && "$2" == "view" ]]; then echo "acme/widget"; exit 0; fi\n` +
      `if [[ "$1" == "variable" || "$1" == "secret" ]]; then echo ""; exit 0; fi\n` +
      `if [[ "$1" == "api" ]]; then\n` +
      `  shift\n` +
      `  args="$*"\n` +
      `  if [[ "$args" == *"pulls?state=open"* ]]; then printf '%s' ${JSON.stringify(
        pullsOut,
      )}; exit ${pullsCode}; fi\n` +
      `  echo "[]"; exit 0\n` +
      `fi\n` +
      `echo "stub gh: unhandled: $*" >&2; exit 1\n`,
  );
  chmodSync(gh, 0o755);
  const doctorStub = writeDoctorStub(binDir, { blocks: 0, warns: 0 });
  execFileSync("git", ["init", "-q"], { cwd: work });
  const gitEnv = { ...process.env, ...GIT_IDENT };
  for (const subject of opts.commits) {
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", subject], {
      cwd: work,
      env: gitEnv,
    });
  }
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
    },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", work };
}

describe("init.sh — brownfield history & open-PR awareness", () => {
  it("a [skip ci] commit in history ⇒ info advisory mentions skip-ci; still exits 0 and writes .flywheel.yml", () => {
    const r = runInitHist({
      commits: ["feat: real work", "chore: tweak [skip ci]"],
    });
    try {
      const out = stripAnsi(r.stdout);
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).toBe(0);
      expect(out).toContain("[instance]");
      expect(out).toMatch(/skip ci/i);
      expect(existsSync(join(r.work, ".flywheel.yml"))).toBe(true);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("a non-conventional commit subject ⇒ info advisory about non-conventional history; exits 0", () => {
    const r = runInitHist({
      commits: ["feat: real work", "WIP fixing stuff"],
    });
    try {
      const out = stripAnsi(r.stdout);
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).toBe(0);
      expect(out).toContain("[instance]");
      expect(out).toMatch(/not Conventional Commits/i);
      expect(out).toMatch(/distort the first/i);
      expect(existsSync(join(r.work, ".flywheel.yml"))).toBe(true);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("open PRs with non-conventional titles ⇒ info advisory naming the count; exits 0", () => {
    const r = runInitHist({
      commits: ["feat: real work"],
      pulls: [
        0,
        JSON.stringify([
          { title: "WIP make it go" },
          { title: "Random title" },
          { title: "feat: already good" },
        ]),
      ],
    });
    try {
      const out = stripAnsi(r.stdout);
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).toBe(0);
      expect(out).toContain("[instance]");
      expect(out).toMatch(/2 open PR\(s\)/);
      expect(out).toMatch(/rewrite/i);
      expect(existsSync(join(r.work, ".flywheel.yml"))).toBe(true);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("clean: only conventional commits + empty PR list ⇒ NO history/PR advisory; exits 0; no blockers", () => {
    const r = runInitHist({
      commits: ["feat: alpha", "fix: beta", "chore(deps): bump"],
      pulls: [0, "[]"],
    });
    try {
      const out = stripAnsi(r.stdout);
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).toBe(0);
      expect(out).toContain("pre-flight: no blockers.");
      expect(out).not.toMatch(/skip ci/i);
      expect(out).not.toMatch(/not Conventional Commits/i);
      expect(out).not.toMatch(/open PR\(s\)/);
      expect(existsSync(join(r.work, ".flywheel.yml"))).toBe(true);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("PR list unreadable (pulls call fails) but REPO resolves ⇒ could-not-verify local-env warn; exits 0", () => {
    const r = runInitHist({
      commits: ["feat: real work"],
      pulls: [1, ""],
    });
    try {
      const out = stripAnsi(r.stdout);
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).toBe(0);
      expect(out).toContain("[local-env]");
      expect(out).toMatch(/could not verify open PRs/i);
      expect(existsSync(join(r.work, ".flywheel.yml"))).toBe(true);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// preflight_brownfield_managed_branches — config-derived enumeration
// (§spec:brownfield-managed-branches).
//
// The two branch-scoped detectors above share ONE managed-branch enumeration.
// These cases prove that enumeration takes its candidate set from the adopter's
// CHOSEN configuration — an existing .flywheel.yml, the picked --preset template,
// or the `main` default when neither exists — and never from a hardcoded
// develop/main/staging list. The gh stub logs every invocation to a file so a
// case can assert which branches were (and were NOT) probed and that each is
// probed once per run.
// ---------------------------------------------------------------------------

/** Like runInitBP, but: (1) logs every `gh` invocation's args to a file exposed
 * as `ghCalls`; (2) optionally writes a `.flywheel.yml` fixture into the work dir
 * BEFORE invoking init (the existing-config path); (3) lets the caller override
 * the init args (e.g. drop `--preset` to exercise the no-config default). */
function runInitCfg(
  apiCases: Array<[string, number, string]>,
  opts: { env?: Record<string, string>; args?: string[]; flywheelYml?: string } = {},
): RunResult & { ghCalls: string } {
  const work = mkdtempSync(join(tmpdir(), "flywheel-cfg-"));
  const binDir = join(work, "bin");
  mkdirSync(binDir);
  const ghLog = join(work, "gh-calls.log");
  const gh = join(binDir, "gh");
  const apiDispatch = apiCases
    .map(
      ([needle, code, out]) =>
        `  if [[ "$args" == *${JSON.stringify(needle)}* ]]; then ` +
        `printf '%s' ${JSON.stringify(out)}; exit ${code}; fi`,
    )
    .join("\n");
  writeFileSync(
    gh,
    `#!/usr/bin/env bash\n` +
      `printf '%s\\n' "$*" >> ${JSON.stringify(ghLog)}\n` +
      `if [[ "$1" == "auth" && "$2" == "status" ]]; then echo "  - Token scopes: 'repo', 'read:org'"; exit 0; fi\n` +
      `if [[ "$1" == "repo" && "$2" == "view" ]]; then echo "acme/widget"; exit 0; fi\n` +
      `if [[ "$1" == "variable" || "$1" == "secret" ]]; then echo ""; exit 0; fi\n` +
      `if [[ "$1" == "api" ]]; then\n` +
      `  shift\n` +
      `  args="$*"\n` +
      apiDispatch +
      `\n  echo "[]"; exit 0\n` +
      `fi\n` +
      `echo "stub gh: unhandled: $*" >&2; exit 1\n`,
  );
  chmodSync(gh, 0o755);
  const doctorStub = writeDoctorStub(binDir, { blocks: 0, warns: 0 });
  execFileSync("git", ["init", "-q"], { cwd: work });
  if (opts.flywheelYml !== undefined) {
    writeFileSync(join(work, ".flywheel.yml"), opts.flywheelYml);
  }
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
  const ghCalls = existsSync(ghLog) ? readFileSync(ghLog, "utf8") : "";
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", work, ghCalls };
}

// A single managed branch, declared via a valid one-stream config.
const oneBranchConfig = (branch: string) =>
  `flywheel:\n  streams:\n    - name: main-line\n      branches:\n        - name: ${branch}\n          release: production\n          auto_merge: [fix, chore, docs]\n`;

// A branch ruleset (PR-required) scoped to refs/heads/<branch>; `bypass` JSON is
// spliced into bypass_actors so a case can include / omit the Integration App.
const prRuleset = (id: number, branch: string, bypass: string) =>
  JSON.stringify({
    id,
    target: "branch",
    conditions: { ref_name: { include: [`refs/heads/${branch}`], exclude: [] } },
    rules: [{ type: "pull_request" }],
    bypass_actors: JSON.parse(bypass),
  });

// Init args without a preset, so the no-config default path engages.
const NO_PRESET_ARGS = ["--version", "v0-preflight-test", "--skip-secrets", "--skip-rulesets"];

describe("init.sh — config-derived managed-branch enumeration", () => {
  it("trunk-only config + ruleset omitting the App bypass ⇒ finding on 'trunk'; never probes develop/main/staging", () => {
    const r = runInitCfg(
      [
        ["repos/acme/widget/branches/trunk", 0, ""],
        ["repos/acme/widget/rulesets/1", 0, prRuleset(1, "trunk", "[]")],
        ["repos/acme/widget/rulesets", 0, JSON.stringify([{ id: 1, target: "branch" }])],
      ],
      { flywheelYml: oneBranchConfig("trunk") },
    );
    try {
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).not.toBe(0);
      expect(combined).toMatch(/pre-flight (failed|halted)/i);
      expect(combined).toContain("[instance]");
      expect(combined).toContain("trunk");
      expect(combined).toMatch(/bypass actor/i);
      // Probed the configured branch — and NOT the old hardcoded candidate set.
      expect(r.ghCalls).toMatch(/branches\/trunk$/m);
      expect(r.ghCalls).not.toMatch(/branches\/develop$/m);
      expect(r.ghCalls).not.toMatch(/branches\/staging$/m);
      expect(r.ghCalls).not.toMatch(/branches\/main$/m);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("existing .flywheel.yml declaring only 'release' ⇒ probed on 'release', never on develop/main/staging", () => {
    const r = runInitCfg(
      [
        ["repos/acme/widget/branches/release", 0, ""],
        ["repos/acme/widget/rulesets", 0, "[]"],
      ],
      { flywheelYml: oneBranchConfig("release"), args: NO_PRESET_ARGS },
    );
    try {
      const out = stripAnsi(r.stdout);
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).toBe(0);
      expect(out).toContain("pre-flight: no blockers.");
      // Existing config drives detection — release probed, hardcoded set absent.
      expect(r.ghCalls).toMatch(/branches\/release$/m);
      expect(r.ghCalls).not.toMatch(/branches\/develop$/m);
      expect(r.ghCalls).not.toMatch(/branches\/staging$/m);
      expect(r.ghCalls).not.toMatch(/branches\/main$/m);
      // An existing config is honored, never re-defaulted.
      expect(out).not.toMatch(/default.*main/i);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("no .flywheel.yml and no --preset ⇒ 'defaulted to main' notice; probes main; scaffolds config", () => {
    const r = runInitCfg(
      [
        ["repos/acme/widget/branches/main", 0, ""],
        ["repos/acme/widget/rulesets", 0, "[]"],
      ],
      { args: NO_PRESET_ARGS },
    );
    try {
      const out = stripAnsi(r.stdout);
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).toBe(0);
      expect(out).toMatch(/No \.flywheel\.yml/i);
      expect(out).toMatch(/default.*main/i);
      expect(r.ghCalls).toMatch(/branches\/main$/m);
      // The minimal config is scaffolded by init's normal greenfield write.
      expect(existsSync(join(r.work, ".flywheel.yml"))).toBe(true);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("three-stage preset ⇒ probes develop/staging/main once each; bypass-omitting ruleset on main blocks (standard adopter unchanged)", () => {
    const r = runInitCfg(
      [
        ["repos/acme/widget/branches/develop", 0, ""],
        ["repos/acme/widget/branches/staging", 0, ""],
        ["repos/acme/widget/branches/main", 0, ""],
        ["repos/acme/widget/rulesets/1", 0, prRuleset(1, "main", "[]")],
        ["repos/acme/widget/rulesets", 0, JSON.stringify([{ id: 1, target: "branch" }])],
      ],
      { args: ["--preset", "three-stage", ...NO_PRESET_ARGS] },
    );
    try {
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).not.toBe(0);
      expect(combined).toContain("[instance]");
      expect(combined).toContain("main");
      expect(combined).toMatch(/bypass actor/i);
      // All three configured branches are covered (the develop/main/staging
      // adopter sees exactly today's coverage)…
      expect(r.ghCalls).toMatch(/branches\/develop$/m);
      expect(r.ghCalls).toMatch(/branches\/staging$/m);
      expect(r.ghCalls).toMatch(/branches\/main$/m);
      // …and each branch's existence is probed exactly once (memoization holds:
      // both branch-scoped detectors reuse the one enumeration).
      expect((r.ghCalls.match(/branches\/develop$/gm) ?? []).length).toBe(1);
      expect((r.ghCalls.match(/branches\/staging$/gm) ?? []).length).toBe(1);
      expect((r.ghCalls.match(/branches\/main$/gm) ?? []).length).toBe(1);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("second run with an existing .flywheel.yml ('main') ⇒ reads config, probes main, no re-default notice (idempotent)", () => {
    const r = runInitCfg(
      [
        ["repos/acme/widget/branches/main", 0, ""],
        ["repos/acme/widget/rulesets", 0, "[]"],
      ],
      { flywheelYml: oneBranchConfig("main"), args: NO_PRESET_ARGS },
    );
    try {
      const out = stripAnsi(r.stdout);
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).toBe(0);
      expect(r.ghCalls).toMatch(/branches\/main$/m);
      // Reading a present config never re-defaults, so no "defaulted to main".
      expect(out).not.toMatch(/default.*main/i);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });
});
