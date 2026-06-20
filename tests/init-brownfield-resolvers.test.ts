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

// WS1 (#233-3) — the GUIDED RETAG resolver for colliding bare-semver version tags
// (SPEC.md §spec:brownfield-resolvers "Guided retag", docs/adopter/setup.md §0.1).
// brownfield_resolver_tag_shape_bare_semver re-derives the bare-semver tags from
// LIVE state, shows the exact `X → vX` list, and on an explicit yes CREATES and
// PUSHES the v-prefixed tags ALONGSIDE the originals (never deleting them).
//
// Coverage spans both ways a resolver is reachable:
//   * NON-INTERACTIVE (vitest spawn, INTERACTIVE forced 0): no resolver dispatch
//     at all → the bare-semver block hard-stops to §0 with ZERO mutation.
//   * INTERACTIVE (Python pty makes `[[ -t 0 ]]` true → INTERACTIVE=1, fd 3 wired):
//     drives brownfield_confirm's `read -u 3` for the confirm / decline branches.
//   * IDEMPOTENCY: after a successful retag the detector no longer re-flags the
//     bare tag (its v-twin now exists in the gathered set).

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const initSh = join(repoRoot, "scripts/init.sh");

const SCAFFOLD_ARGS = [
  "--preset",
  "minimal",
  "--version",
  "v0-resolver-test",
  "--skip-secrets",
  "--skip-rulesets",
];

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

/** A `gh` stub mirroring the resolution suite's: answers auth/repo-view + a default
 * `gh api … → []` so the remote-tag cross-check and other detectors stay quiet. */
const GH_STUB =
  `#!/usr/bin/env bash\n` +
  `if [[ "$1" == "auth" && "$2" == "status" ]]; then echo "  - Token scopes: 'repo', 'read:org'"; exit 0; fi\n` +
  `if [[ "$1" == "repo" && "$2" == "view" ]]; then echo "acme/widget"; exit 0; fi\n` +
  `if [[ "$1" == "variable" || "$1" == "secret" ]]; then echo ""; exit 0; fi\n` +
  `if [[ "$1" == "api" ]]; then echo "[]"; exit 0; fi\n` +
  `echo "stub gh: unhandled: $*" >&2; exit 1\n`;

/** Create a fresh git-init'd temp work dir with the gh + green doctor stubs on a
 * private bin/. When `withOrigin` is set, also create a LOCAL BARE remote and wire
 * it as `origin` so an in-test `git push origin v<tag>` succeeds. `tags` are real
 * git tags created BEFORE init so the detector classifies them. */
function makeWorkdir(opts: { tags?: string[]; withOrigin?: boolean } = {}): {
  work: string;
  binDir: string;
  doctorStub: string;
} {
  const work = mkdtempSync(join(tmpdir(), "flywheel-resolver-"));
  const binDir = join(work, "bin");
  mkdirSync(binDir);
  const gh = join(binDir, "gh");
  writeFileSync(gh, GH_STUB);
  chmodSync(gh, 0o755);
  const doctorStub = writeDoctorStub(binDir, { blocks: 0, warns: 0 });
  execFileSync("git", ["init", "-q"], { cwd: work });
  // A bare tag needs a commit to point at.
  if ((opts.tags ?? []).length > 0) {
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], {
      cwd: work,
      env: gitEnv,
    });
  }
  for (const tag of opts.tags ?? []) {
    execFileSync("git", ["tag", tag], { cwd: work, env: gitEnv });
  }
  if (opts.withOrigin) {
    const bare = join(work, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", bare], { cwd: work });
    execFileSync("git", ["remote", "add", "origin", bare], { cwd: work, env: gitEnv });
  }
  return { work, binDir, doctorStub };
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  work: string;
}

/** Run init.sh NON-interactively (input: "") from a fresh work dir with `tags`. */
function runInit(
  opts: { env?: Record<string, string>; tags?: string[]; withOrigin?: boolean } = {},
): RunResult {
  const { work, binDir, doctorStub } = makeWorkdir(opts);
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

/** Local git tags present in the work dir (mutation assertions). */
function localTags(work: string): string[] {
  const out = execFileSync("git", ["tag", "-l"], { cwd: work, encoding: "utf8" });
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** Tags present in the bare `origin` remote (push assertions). */
function originTags(work: string): string[] {
  const bare = join(work, "origin.git");
  const out = execFileSync("git", ["tag", "-l"], { cwd: bare, encoding: "utf8" });
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// A Python pty driver — init.sh's brownfield_confirm reads from fd 3, only opened
// when INTERACTIVE=1 (`[[ -t 0 ]]` true → `exec 3<&0`). Under a real pty stdin is a
// tty, so fd 3 is the pty and `read -u 3` works — exactly the curl|bash path. We
// fork a pty, exec `bash init.sh ...` with the stubs on PATH, feed newline-delimited
// answers, and capture the combined output + exit code.
// ---------------------------------------------------------------------------
const PTY_DRIVER = String.raw`
import json, os, pty, re, select, sys, time

cfg = json.loads(sys.argv[1])
env = dict(os.environ)
env["PATH"] = cfg["bin"] + ":" + env.get("PATH", "")
env["FLYWHEEL_TEST_HOOKS"] = "1"
env["FLYWHEEL_DOCTOR_OVERRIDE"] = cfg["doctor"]

answers = cfg["answers"].encode()
argv = ["bash", cfg["init"]] + cfg["args"]

pid, fd = pty.fork()
if pid == 0:
    os.chdir(cfg["cwd"])
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
  work: string;
}

/** Drive init.sh under a real pty with the given keystroke `answers`. Returns the
 * captured exit code + ANSI-stripped output AND the work dir (caller asserts tags,
 * then rmSync's it). */
function runInitPty(opts: {
  answers: string;
  tags?: string[];
  withOrigin?: boolean;
}): PtyResult {
  const { work, binDir, doctorStub } = makeWorkdir(opts);
  const cfg = JSON.stringify({
    bin: binDir,
    doctor: doctorStub,
    init: initSh,
    args: SCAFFOLD_ARGS,
    cwd: work,
    answers: opts.answers,
  });
  const r = spawnSync("python3", ["-c", PTY_DRIVER, cfg], {
    cwd: work,
    encoding: "utf8",
    timeout: 40000,
  });
  if (r.status !== 0 || !r.stdout) {
    rmSync(work, { recursive: true, force: true });
    throw new Error(
      `pty driver failed (status ${r.status}):\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
    );
  }
  const lines = r.stdout.trim().split("\n");
  const lastLine = lines[lines.length - 1] ?? "";
  const parsed = JSON.parse(lastLine) as { exit: number; out: string };
  return { exit: parsed.exit, out: stripAnsi(parsed.out), work };
}

// ===========================================================================
// NON-INTERACTIVE — bare-semver still hard-stops with ZERO mutation
// ===========================================================================
describe("guided retag resolver — non-interactive (no dispatch, zero mutation)", () => {
  it("bare-semver tag ⇒ exit != 0, routed to §0, NO v-prefixed tag created", () => {
    const r = runInit({ tags: ["3.4.2"] });
    try {
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).not.toBe(0);
      expect(combined).toContain("3.4.2");
      expect(combined).toMatch(/collide with Flywheel's v-prefixed scheme/);
      expect(combined).toContain("docs/adopter/setup.md §0");
      // Non-interactive never dispatches the resolver → zero mutation.
      const tags = localTags(r.work);
      expect(tags).toContain("3.4.2");
      expect(tags).not.toContain("v3.4.2");
      expect(existsSync(join(r.work, ".flywheel.yml"))).toBe(false);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// INTERACTIVE — confirm applies / decline leaves untouched (Python pty)
// ===========================================================================
describe("guided retag resolver — interactive (Python pty)", () => {
  it("confirm (y) ⇒ creates AND pushes v-prefixed tags, keeps originals", () => {
    const r = runInitPty({
      answers: "y\n",
      tags: ["3.4.2", "2.0.0"],
      withOrigin: true,
    });
    try {
      // The offer shows the exact X → vX lines and the non-destructive framing.
      expect(r.out).toContain("3.4.2 -> v3.4.2");
      expect(r.out).toContain("2.0.0 -> v2.0.0");
      expect(r.out).toMatch(/NON-DESTRUCTIVE/);
      expect(r.out).toContain("Create and push these v-prefixed tags?");

      // Locally: both v-twins created, originals still present (non-destructive).
      const local = localTags(r.work);
      expect(local).toContain("v3.4.2");
      expect(local).toContain("v2.0.0");
      expect(local).toContain("3.4.2");
      expect(local).toContain("2.0.0");

      // Pushed to origin: the v-twins reached the remote.
      const remote = originTags(r.work);
      expect(remote).toContain("v3.4.2");
      expect(remote).toContain("v2.0.0");
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("capitalized 'Yes' ⇒ treated as consent (case-insensitive confirm), retag applied", () => {
    const r = runInitPty({
      answers: "Yes\n",
      tags: ["3.4.2"],
      withOrigin: true,
    });
    try {
      expect(r.out).toContain("Create and push these v-prefixed tags?");
      const local = localTags(r.work);
      expect(local).toContain("v3.4.2");
      expect(local).toContain("3.4.2");
      expect(originTags(r.work)).toContain("v3.4.2");
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("decline (n) ⇒ no v* tags created, originals intact, manual pointer shown", () => {
    const r = runInitPty({
      answers: "n\n",
      tags: ["3.4.2", "2.0.0"],
      withOrigin: true,
    });
    try {
      expect(r.out).toContain("Create and push these v-prefixed tags?");
      // The dispatcher's declined pointer to the manual guide.
      expect(r.out).toContain("docs/adopter/setup.md §0");

      const local = localTags(r.work);
      expect(local).not.toContain("v3.4.2");
      expect(local).not.toContain("v2.0.0");
      expect(local).toContain("3.4.2");
      expect(local).toContain("2.0.0");
      // Nothing pushed either.
      expect(originTags(r.work)).not.toContain("v3.4.2");
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// IDEMPOTENCY — a post-retag repo no longer re-flags the bare tag
// ===========================================================================
describe("guided retag resolver — idempotency (detector skips resolved tags)", () => {
  it("repo containing BOTH 3.4.2 and v3.4.2 ⇒ bare-semver condition is gone", () => {
    // Simulate the state AFTER a successful retag: the bare tag AND its v-twin both
    // present. The detector must not re-flag 3.4.2. A clean run (no other blocker)
    // therefore reaches completion and exits 0, never naming the collision.
    const r = runInit({ tags: ["3.4.2", "v3.4.2"], env: { FLYWHEEL_ASSUME_INTERACTIVE: "1" } });
    try {
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).toBe(0);
      expect(combined).not.toMatch(/collide with Flywheel's v-prefixed scheme/);
      expect(combined).not.toContain("Brownfield conditions need your hand");
      expect(existsSync(join(r.work, ".flywheel.yml"))).toBe(true);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// WS2 (#233-3) — the PRIOR RELEASE-SYSTEM REMOVAL resolver
// (SPEC.md §spec:brownfield-resolvers "Prior release-system removal",
// docs/adopter/setup.md §0.2). The detector now recognizes the full set —
// release-please, a separate semantic-release, goreleaser, changesets, and a
// hand-rolled tagging workflow — and stashes each flagged path in
// RELEASE_CONFLICT_PATHS. brownfield_resolver_release_conflict makes ONE
// consolidated offer (a run-scoped guard collapses the per-file calls), lists the
// exact paths, and on yes removes them with `git rm` (recoverable from history).
// ===========================================================================

const GORELEASER_CONFIG = `project_name: widget
builds:
  - main: ./cmd/widget
`;

const CHANGESET_CONFIG = `{
  "changelog": "@changesets/cli/changelog",
  "commit": false,
  "access": "restricted"
}
`;

/** Make a git-init'd work dir, write each (path → contents) file, optionally commit
 * them so they are tracked (recoverable-from-history assertions), and return the
 * dir + stubs. Mirrors makeWorkdir's stub setup but for arbitrary files/dirs. */
function makeFileWorkdir(opts: {
  files: Record<string, string>;
  commit?: boolean;
}): { work: string; binDir: string; doctorStub: string } {
  const work = mkdtempSync(join(tmpdir(), "flywheel-relrm-"));
  const binDir = join(work, "bin");
  mkdirSync(binDir);
  const gh = join(binDir, "gh");
  writeFileSync(gh, GH_STUB);
  chmodSync(gh, 0o755);
  const doctorStub = writeDoctorStub(binDir, { blocks: 0, warns: 0 });
  execFileSync("git", ["init", "-q"], { cwd: work });
  for (const [rel, contents] of Object.entries(opts.files)) {
    const dest = join(work, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, contents);
  }
  if (opts.commit) {
    execFileSync("git", ["add", "-A"], { cwd: work, env: gitEnv });
    execFileSync("git", ["commit", "-q", "-m", "prior release system"], {
      cwd: work,
      env: gitEnv,
    });
  }
  return { work, binDir, doctorStub };
}

/** Run init.sh NON-interactively against a pre-built file work dir. */
function runInitFiles(opts: {
  files: Record<string, string>;
  commit?: boolean;
  env?: Record<string, string>;
}): RunResult {
  const { work, binDir, doctorStub } = makeFileWorkdir(opts);
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

/** Drive init.sh under a real pty against a pre-built file work dir (tracked
 * files committed) with the given keystroke `answers`. Returns exit + output + dir. */
function runInitFilesPty(opts: {
  answers: string;
  files: Record<string, string>;
  commit?: boolean;
}): PtyResult {
  const { work, binDir, doctorStub } = makeFileWorkdir(opts);
  const cfg = JSON.stringify({
    bin: binDir,
    doctor: doctorStub,
    init: initSh,
    args: SCAFFOLD_ARGS,
    cwd: work,
    answers: opts.answers,
  });
  const r = spawnSync("python3", ["-c", PTY_DRIVER, cfg], {
    cwd: work,
    encoding: "utf8",
    timeout: 40000,
  });
  if (r.status !== 0 || !r.stdout) {
    rmSync(work, { recursive: true, force: true });
    throw new Error(
      `pty driver failed (status ${r.status}):\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
    );
  }
  const lines = r.stdout.trim().split("\n");
  const lastLine = lines[lines.length - 1] ?? "";
  const parsed = JSON.parse(lastLine) as { exit: number; out: string };
  return { exit: parsed.exit, out: stripAnsi(parsed.out), work };
}

describe("release-system removal resolver", () => {
  // --- Detection extension: goreleaser / changesets are now recognized --------
  describe("non-interactive (no dispatch, zero mutation)", () => {
    it("goreleaser config ⇒ release conflict, hard-stop, file NOT removed", () => {
      const r = runInitFiles({ files: { ".goreleaser.yml": GORELEASER_CONFIG } });
      try {
        const combined = stripAnsi(r.stdout + r.stderr);
        expect(r.status, `combined:\n${combined}`).not.toBe(0);
        expect(combined).toContain("goreleaser");
        expect(combined).toContain(".goreleaser.yml");
        expect(combined).toContain("docs/adopter/setup.md §0");
        // Non-interactive never dispatches → zero mutation, no scaffold.
        expect(existsSync(join(r.work, ".goreleaser.yml"))).toBe(true);
        expect(existsSync(join(r.work, ".flywheel.yml"))).toBe(false);
      } finally {
        rmSync(r.work, { recursive: true, force: true });
      }
    });

    it("changesets dir (.changeset/config.json) ⇒ release conflict, hard-stop, dir NOT removed", () => {
      const r = runInitFiles({ files: { ".changeset/config.json": CHANGESET_CONFIG } });
      try {
        const combined = stripAnsi(r.stdout + r.stderr);
        expect(r.status, `combined:\n${combined}`).not.toBe(0);
        expect(combined).toContain("changesets");
        expect(combined).toContain(".changeset");
        expect(combined).toContain("docs/adopter/setup.md §0");
        expect(existsSync(join(r.work, ".changeset/config.json"))).toBe(true);
        expect(existsSync(join(r.work, ".flywheel.yml"))).toBe(false);
      } finally {
        rmSync(r.work, { recursive: true, force: true });
      }
    });
  });

  // --- Interactive confirm removes (Python pty) -------------------------------
  describe("interactive (Python pty)", () => {
    it("confirm (y) ⇒ removes the flagged files via git rm, lists exact paths, recoverable", () => {
      const r = runInitFilesPty({
        answers: "y\n",
        commit: true,
        files: {
          ".github/workflows/release.yml": RELEASE_PLEASE_PTY_WF,
          ".goreleaser.yml": GORELEASER_CONFIG,
        },
      });
      try {
        // ONE consolidated offer listing the exact paths.
        expect(r.out).toContain("Prior release-system removal");
        expect(r.out).toContain(".github/workflows/release.yml");
        expect(r.out).toContain(".goreleaser.yml");
        expect(r.out).toContain("Remove these prior release-system files?");
        expect(r.out).toMatch(/RECOVERABLE/);

        // Working tree: both flagged files removed.
        expect(existsSync(join(r.work, ".github/workflows/release.yml"))).toBe(false);
        expect(existsSync(join(r.work, ".goreleaser.yml"))).toBe(false);

        // Recoverable from history: still present at HEAD (git rm keeps history).
        const show = execFileSync(
          "git",
          ["show", "HEAD:.goreleaser.yml"],
          { cwd: r.work, encoding: "utf8" },
        );
        expect(show).toContain("project_name");
      } finally {
        rmSync(r.work, { recursive: true, force: true });
      }
    });

    it("decline (n) ⇒ files left intact, manual pointer shown", () => {
      const r = runInitFilesPty({
        answers: "n\n",
        commit: true,
        files: { ".goreleaser.yml": GORELEASER_CONFIG },
      });
      try {
        expect(r.out).toContain("Remove these prior release-system files?");
        expect(r.out).toContain("docs/adopter/setup.md §0");
        // Declined → file still present.
        expect(existsSync(join(r.work, ".goreleaser.yml"))).toBe(true);
      } finally {
        rmSync(r.work, { recursive: true, force: true });
      }
    });
  });

  // --- Idempotency: after removal + commit, a re-run flags nothing ------------
  describe("idempotency (detector flags nothing once files are gone)", () => {
    it("repo with NO prior release-system file ⇒ no release conflict, proceeds", () => {
      // Simulate the state AFTER a successful removal + commit: the file is gone, so
      // the detector flags nothing and a clean run reaches completion (exit 0).
      const r = runInitFiles({
        files: { ".github/workflows/ci.yml": "name: ci\non:\n  pull_request:\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n" },
        commit: true,
        env: { FLYWHEEL_ASSUME_INTERACTIVE: "1" },
      });
      try {
        const combined = stripAnsi(r.stdout + r.stderr);
        expect(r.status, `combined:\n${combined}`).toBe(0);
        expect(combined).not.toMatch(/races Flywheel's tag\/release creation/);
        expect(combined).not.toContain("Brownfield conditions need your hand");
        expect(existsSync(join(r.work, ".flywheel.yml"))).toBe(true);
      } finally {
        rmSync(r.work, { recursive: true, force: true });
      }
    });
  });
});

const RELEASE_PLEASE_PTY_WF = `name: release
on:
  push:
    branches: [main]
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: googleapis/release-please-action@v4
`;

// ===========================================================================
// WS3 (#233-3) — the APP BYPASS-ACTOR ADDITION resolver
// (SPEC.md §spec:brownfield-resolvers "App bypass-actor addition",
// docs/adopter/setup.md §0.3). The detector stashes the editable ruleset id(s) in
// BYPASS_RULESET_IDS (and classic-only branches in BYPASS_CLASSIC_BRANCHES);
// brownfield_resolver_branch_protection_bypass — held to the tightest safety
// contract since it changes WHO can bypass branch protection — gates on repo-admin
// FIRST (never escalates privilege), requires the App ID, shows the exact rule +
// the exact bypass entry, and on yes PUTs each ruleset back with ONLY the App added
// as an Integration bypass actor. Any PUT failure is reported as a limit and routes
// to manual (return 2); a signed-commit requirement is NOT auto-disabled.
//
// The gh stub here both ANSWERS the detector's reads (branch existence, rulesets
// list, ruleset detail) AND the resolver's `gh api -X PUT repos/.../rulesets/<id>`,
// recording every PUT (path + stdin body) to a log file the tests assert against.
// It also answers `gh variable get FLYWHEEL_GH_APP_ID` so PREFLIGHT_APP_ID_VALUE is
// populated (the resolver keys the bypass entry on it).
// ===========================================================================

const BYPASS_APP_ID = "123";

/** Build a branch ruleset detail covering refs/heads/main with a pull_request rule
 * and the given bypass_actors. The resolver PUTs a body derived from this. */
const bpRuleset = (id: number, bypass: unknown[] = []) =>
  JSON.stringify({
    id,
    name: `protect-main-${id}`,
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
    rules: [{ type: "pull_request" }, { type: "non_fast_forward" }],
    bypass_actors: bypass,
    // Read-only fields the resolver must STRIP before PUT.
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
    node_id: "RRS_abc",
    _links: { self: { href: "x" } },
    current_user_can_bypass: "always",
  });

/** A gh stub that:
 *  - answers auth/repo-view + `gh variable get FLYWHEEL_GH_APP_ID` (appId) + the
 *    `gh variable list` / `gh secret list` probes the credential detector makes,
 *  - dispatches `gh api …` over an ordered [needle, exit, stdout] case-ladder,
 *  - for `gh api -X PUT repos/.../rulesets/<id>` appends a line to $PUT_LOG of the
 *    form `PUT <path>\t<stdin-body>` and exits per `putExit` (0 ok / non-0 deny),
 *  - falls back to echoing `[]` exit 0 for any other `gh api`.
 * `putExit` makes the "absent admin scope" case fail the PUT with a perms error. */
function buildBypassGhStub(opts: {
  apiCases: Array<[string, number, string]>;
  appId?: string;
  putExit?: number;
}): string {
  const appId = opts.appId ?? "";
  const putExit = opts.putExit ?? 0;
  const apiDispatch = opts.apiCases
    .map(
      ([needle, code, out]) =>
        `    if [[ "$args" == *${JSON.stringify(needle)}* ]]; then ` +
        `printf '%s' ${JSON.stringify(out)}; exit ${code}; fi`,
    )
    .join("\n");
  return (
    `#!/usr/bin/env bash\n` +
    `if [[ "$1" == "auth" && "$2" == "status" ]]; then echo "  - Token scopes: 'repo', 'read:org'"; exit 0; fi\n` +
    `if [[ "$1" == "repo" && "$2" == "view" ]]; then echo "acme/widget"; exit 0; fi\n` +
    // Credential detector: list returns the App-ID var name, get returns the id.
    `if [[ "$1" == "variable" && "$2" == "list" ]]; then echo "FLYWHEEL_GH_APP_ID"; exit 0; fi\n` +
    `if [[ "$1" == "variable" && "$2" == "get" ]]; then echo ${JSON.stringify(appId)}; exit 0; fi\n` +
    `if [[ "$1" == "secret" ]]; then echo ""; exit 0; fi\n` +
    `if [[ "$1" == "variable" ]]; then echo ""; exit 0; fi\n` +
    `if [[ "$1" == "api" ]]; then\n` +
    `  shift\n` +
    `  args="$*"\n` +
    // Resolver's PUT: record path + stdin body, then succeed/deny per putExit.
    `  if [[ "$args" == *"-X PUT"*"rulesets/"* ]]; then\n` +
    `    path="$(printf '%s\\n' $args | grep -E '^repos/.*/rulesets/[0-9]+$' | head -n1)"\n` +
    // Compact the (pretty-printed) JSON body to ONE line so the test's line-based
    // PUT-log parser sees exactly one record per PUT.
    `    body="$(cat | jq -c .)"\n` +
    `    printf 'PUT %s\\t%s\\n' "$path" "$body" >> "$PUT_LOG"\n` +
    (putExit === 0
      ? `    exit 0\n`
      : `    echo "HTTP 403: must have admin rights" >&2; exit ${putExit}\n`) +
    `  fi\n` +
    apiDispatch +
    `\n  echo "[]"; exit 0\n` +
    `fi\n` +
    `echo "stub gh: unhandled: $*" >&2; exit 1\n`
  );
}

/** Make a work dir wired with the bypass gh stub (PUT log at $PUT_LOG) + green
 * doctor stub. Returns the dir, bin, doctor stub, and the PUT-log path. */
function makeBypassWorkdir(opts: {
  apiCases: Array<[string, number, string]>;
  appId?: string;
  putExit?: number;
}): { work: string; binDir: string; doctorStub: string; putLog: string } {
  const work = mkdtempSync(join(tmpdir(), "flywheel-bypass-"));
  const binDir = join(work, "bin");
  mkdirSync(binDir);
  const gh = join(binDir, "gh");
  writeFileSync(gh, buildBypassGhStub(opts));
  chmodSync(gh, 0o755);
  const doctorStub = writeDoctorStub(binDir, { blocks: 0, warns: 0 });
  execFileSync("git", ["init", "-q"], { cwd: work });
  const putLog = join(work, "put.log");
  writeFileSync(putLog, "");
  return { work, binDir, doctorStub, putLog };
}

/** Read the recorded PUT log lines (one per resolver PUT). */
function putLogLines(putLog: string): string[] {
  if (!existsSync(putLog)) return [];
  return readFileSync(putLog, "utf8").split("\n").filter(Boolean);
}

/** Run init NON-interactively against the bypass gh stub. */
function runInitBypass(opts: {
  apiCases: Array<[string, number, string]>;
  appId?: string;
  putExit?: number;
  env?: Record<string, string>;
}): RunResult & { putLog: string } {
  const { work, binDir, doctorStub, putLog } = makeBypassWorkdir(opts);
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
      PUT_LOG: putLog,
      ...(opts.env ?? {}),
    },
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    work,
    putLog,
  };
}

/** Drive init under a real pty against the bypass gh stub with `answers`. */
function runInitBypassPty(opts: {
  answers: string;
  apiCases: Array<[string, number, string]>;
  appId?: string;
  putExit?: number;
}): PtyResult & { putLog: string } {
  const { work, binDir, doctorStub, putLog } = makeBypassWorkdir(opts);
  const cfg = JSON.stringify({
    bin: binDir,
    doctor: doctorStub,
    init: initSh,
    args: SCAFFOLD_ARGS,
    cwd: work,
    answers: opts.answers,
    extraEnv: { PUT_LOG: putLog },
  });
  const r = spawnSync("python3", ["-c", PTY_DRIVER_ENV, cfg], {
    cwd: work,
    encoding: "utf8",
    timeout: 40000,
  });
  if (r.status !== 0 || !r.stdout) {
    rmSync(work, { recursive: true, force: true });
    throw new Error(
      `pty driver failed (status ${r.status}):\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
    );
  }
  const lines = r.stdout.trim().split("\n");
  const lastLine = lines[lines.length - 1] ?? "";
  const parsed = JSON.parse(lastLine) as { exit: number; out: string };
  return { exit: parsed.exit, out: stripAnsi(parsed.out), work, putLog };
}

// A pty driver variant that also threads cfg.extraEnv (e.g. PUT_LOG) into the
// child environment — the base PTY_DRIVER only wires the fixed test env vars.
const PTY_DRIVER_ENV = String.raw`
import json, os, pty, re, select, sys, time

cfg = json.loads(sys.argv[1])
env = dict(os.environ)
env["PATH"] = cfg["bin"] + ":" + env.get("PATH", "")
env["FLYWHEEL_TEST_HOOKS"] = "1"
env["FLYWHEEL_DOCTOR_OVERRIDE"] = cfg["doctor"]
for k, v in cfg.get("extraEnv", {}).items():
    env[k] = v

answers = cfg["answers"].encode()
argv = ["bash", cfg["init"]] + cfg["args"]

pid, fd = pty.fork()
if pid == 0:
    os.chdir(cfg["cwd"])
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

// The detector's per-branch reads: main exists; one branch ruleset (id 1) covers
// refs/heads/main with a pull_request + non_fast_forward rule and NO App bypass.
const BYPASS_CASES_NO_APP: Array<[string, number, string]> = [
  ["repos/acme/widget/branches/main/protection", 1, ""],
  ["repos/acme/widget/branches/main", 0, ""],
  ["repos/acme/widget/rulesets/1", 0, bpRuleset(1, [])],
  ["repos/acme/widget/rulesets", 0, JSON.stringify([{ id: 1, target: "branch" }])],
];

describe("App bypass-actor resolver", () => {
  // --- Interactive confirm adds the App (Python pty) --------------------------
  it("confirm (y) ⇒ PUTs the ruleset adding the exact Integration bypass entry; offer shows rule + entry", () => {
    const r = runInitBypassPty({
      answers: "y\n",
      apiCases: BYPASS_CASES_NO_APP,
      appId: BYPASS_APP_ID,
    });
    try {
      // The offer names the exact ruleset + blocking rule(s) + the exact entry.
      expect(r.out).toContain("protect-main-1");
      expect(r.out).toMatch(/pull request required/);
      expect(r.out).toMatch(/no force-push/);
      expect(r.out).toContain('"actor_id":123');
      expect(r.out).toContain('"actor_type":"Integration"');
      expect(r.out).toContain('"bypass_mode":"always"');
      expect(r.out).toMatch(/SCOPED/);
      expect(r.out).toMatch(/REVERSIBLE/);
      expect(r.out).toContain("Add the Flywheel App as a bypass actor");

      // Exactly one PUT to rulesets/1 whose body adds the App entry, and which has
      // stripped the read-only fields (no created_at / _links / node_id).
      const puts = putLogLines(r.putLog);
      expect(puts.length).toBe(1);
      expect(puts[0]).toContain("PUT repos/acme/widget/rulesets/1");
      const body = JSON.parse((puts[0] ?? "").split("\t")[1] ?? "{}");
      expect(body.bypass_actors).toContainEqual({
        actor_id: 123,
        actor_type: "Integration",
        bypass_mode: "always",
      });
      expect(body).not.toHaveProperty("created_at");
      expect(body).not.toHaveProperty("_links");
      expect(body).not.toHaveProperty("node_id");
      expect(body).not.toHaveProperty("id");
      // The original rules are preserved (not modified/removed).
      expect(body.rules).toContainEqual({ type: "pull_request" });
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  // --- Interactive decline leaves protection (Python pty) ---------------------
  it("decline (n) ⇒ NO ruleset PUT issued, manual pointer shown", () => {
    const r = runInitBypassPty({
      answers: "n\n",
      apiCases: BYPASS_CASES_NO_APP,
      appId: BYPASS_APP_ID,
    });
    try {
      expect(r.out).toContain("Add the Flywheel App as a bypass actor");
      // The dispatcher's declined pointer to the manual guide.
      expect(r.out).toContain("docs/adopter/setup.md §0");
      // No PUT recorded → protection untouched.
      expect(putLogLines(r.putLog)).toEqual([]);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  // --- Absent admin scope → report-limit-and-route (PUT fails 403) ------------
  it("ruleset PUT denied (no admin) ⇒ reports limit, routes to manual, hard-stops, NEVER escalates", () => {
    const r = runInitBypassPty({
      answers: "y\n",
      apiCases: BYPASS_CASES_NO_APP,
      appId: BYPASS_APP_ID,
      putExit: 1,
    });
    try {
      // Resolver attempted the PUT (recorded) but it was denied → report + route.
      expect(r.out).toMatch(/needs repo-admin|admin token/i);
      expect(r.out).toContain("docs/adopter/setup.md §0");
      // The block stays counted → the run hard-stops (exit != 0).
      expect(r.exit, `out:\n${r.out}`).not.toBe(0);
      // It never claimed success.
      expect(r.out).not.toMatch(/Added the Flywheel App .* as a bypass actor on ruleset/);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  // --- Unreadable rulesets ⇒ capability gate routes to manual, no PUT ----------
  it("rulesets unreadable (list 403) ⇒ resolver gate routes to manual, no PUT, hard-stops", () => {
    // The detector can't read the rulesets list → PREFLIGHT_RULESET_UNREADABLE=1.
    // But with no confirmed hazard there's no branch_protection_bypass block to
    // dispatch on, so this exercises the could-not-verify warn path (proceeds).
    // To reach the resolver's gate we need a confirmed block AND unreadable
    // rulesets — not expressible together. So this case asserts the detector's
    // could-not-verify warn instead (the gate's twin signal is covered by the
    // PUT-denied case above, which is the reachable admin-absent path).
    const r = runInitBypass({
      apiCases: [
        ["repos/acme/widget/branches/main/protection", 1, ""],
        ["repos/acme/widget/branches/main", 0, ""],
        ["repos/acme/widget/rulesets", 1, ""],
      ],
      appId: BYPASS_APP_ID,
      env: { FLYWHEEL_ASSUME_INTERACTIVE: "1" },
    });
    try {
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(combined).toMatch(/could not verify .* branch protection bypass/i);
      // Could-not-verify is a warn, not a block → no PUT, proceeds.
      expect(putLogLines(r.putLog)).toEqual([]);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  // --- App ID unknown ⇒ resolver cannot construct the entry, routes to manual --
  it("App ID not configured ⇒ resolver reports it, routes to manual, no PUT", () => {
    // appId omitted → PREFLIGHT_APP_ID_VALUE empty. The detector still flags the
    // hazard (greenfield fallback: blocking rule + no Integration bypass at all),
    // but the resolver can't build the entry without the id → report + route.
    const r = runInitBypassPty({
      answers: "y\n",
      apiCases: BYPASS_CASES_NO_APP,
      // no appId
    });
    try {
      expect(r.out).toMatch(/App ID is not known yet/i);
      expect(r.out).toContain("docs/adopter/setup.md §0");
      expect(putLogLines(r.putLog)).toEqual([]);
      expect(r.exit).not.toBe(0);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  // --- signed-commit still hard-stops (not auto-disabled) ----------------------
  it("ruleset requiring signed commits ⇒ signed_commit hard-stops to §0, NOT auto-disabled, no PUT", () => {
    const r = runInitBypass({
      apiCases: [
        ["repos/acme/widget/branches/main/protection", 1, ""],
        ["repos/acme/widget/branches/main", 0, ""],
        [
          "repos/acme/widget/rulesets/1",
          0,
          JSON.stringify({
            id: 1,
            name: "sign",
            target: "branch",
            enforcement: "active",
            conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
            rules: [{ type: "required_signatures" }],
            bypass_actors: [],
          }),
        ],
        ["repos/acme/widget/rulesets", 0, JSON.stringify([{ id: 1, target: "branch" }])],
      ],
      appId: BYPASS_APP_ID,
    });
    try {
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).not.toBe(0);
      expect(combined).toMatch(/signed commits\/tags/i);
      expect(combined).toContain("docs/adopter/setup.md §0");
      // No auto-disable of any rule → no PUT issued.
      expect(putLogLines(r.putLog)).toEqual([]);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  // --- Idempotency: ruleset already lists the App ⇒ no block emitted -----------
  it("ruleset ALREADY lists the App as Integration bypass ⇒ no branch_protection_bypass block, no PUT", () => {
    const r = runInitBypass({
      apiCases: [
        ["repos/acme/widget/branches/main/protection", 1, ""],
        ["repos/acme/widget/branches/main", 0, ""],
        [
          "repos/acme/widget/rulesets/1",
          0,
          bpRuleset(1, [{ actor_id: 123, actor_type: "Integration", bypass_mode: "always" }]),
        ],
        ["repos/acme/widget/rulesets", 0, JSON.stringify([{ id: 1, target: "branch" }])],
      ],
      appId: BYPASS_APP_ID,
      env: { FLYWHEEL_ASSUME_INTERACTIVE: "1" },
    });
    try {
      const combined = stripAnsi(r.stdout + r.stderr);
      expect(r.status, `combined:\n${combined}`).toBe(0);
      expect(combined).not.toMatch(/omits the Flywheel App as a bypass actor/);
      expect(putLogLines(r.putLog)).toEqual([]);
      expect(existsSync(join(r.work, ".flywheel.yml"))).toBe(true);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// WS4 (#233-3) — INTEGRATION SURFACE: completion-summary verification +
// "accept some, decline others" end-to-end (SPEC.md §spec:brownfield-resolvers,
// §spec:brownfield-resolution "accept some, decline others",
// §spec:setup-completion-summary, §spec:setup-exit-contract).
//
// These drive a resolver to COMPLETION (past the gate, through the scaffold, into
// the end-of-run completion summary) and assert the resolved/declined block
// outcomes surface in the shared bucket × severity vocabulary, with the right
// effect on the complete/incomplete verdict:
//   * a RESOLVED block folds in as a `configured` outcome and — being a completed
//     step, not an outstanding blocker — does NOT keep the verdict incomplete, so
//     the run reaches a `complete` verdict (exit 0).
//   * a DECLINED block folds in as a `deferred` outcome and, since it is an
//     UNRESOLVED block-severity finding the adopter deferred, KEEPS the verdict
//     incomplete (exit != 0) — but the run still reaches the summary (the gate
//     passed because the block was uncounted), it does not hard-stop at §0.
// ===========================================================================

/** Make a work dir wired with the resolver gh + green doctor stubs that holds BOTH
 * pre-existing version `tags` AND arbitrary `files` (committed so a `git rm` removal
 * stays recoverable), plus a local bare `origin` so a retag push succeeds. Used by
 * the multi-condition "accept some, decline others" PTY case. */
function makeMixedWorkdir(opts: {
  tags?: string[];
  files?: Record<string, string>;
}): { work: string; binDir: string; doctorStub: string } {
  const work = mkdtempSync(join(tmpdir(), "flywheel-mixed-"));
  const binDir = join(work, "bin");
  mkdirSync(binDir);
  const gh = join(binDir, "gh");
  writeFileSync(gh, GH_STUB);
  chmodSync(gh, 0o755);
  const doctorStub = writeDoctorStub(binDir, { blocks: 0, warns: 0 });
  execFileSync("git", ["init", "-q"], { cwd: work });
  for (const [rel, contents] of Object.entries(opts.files ?? {})) {
    const dest = join(work, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, contents);
  }
  // One commit (with the files) gives the tags something to point at AND tracks
  // the release-system file so `git rm` keeps it in history (RECOVERABLE).
  execFileSync("git", ["add", "-A"], { cwd: work, env: gitEnv });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], {
    cwd: work,
    env: gitEnv,
  });
  for (const tag of opts.tags ?? []) {
    execFileSync("git", ["tag", tag], { cwd: work, env: gitEnv });
  }
  const bare = join(work, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", bare], { cwd: work });
  execFileSync("git", ["remote", "add", "origin", bare], { cwd: work, env: gitEnv });
  return { work, binDir, doctorStub };
}

// A pty driver that feeds answers ONE AT A TIME, each after the child's output
// settles — needed when a single run presents TWO offers and the adopter answers
// them differently ("accept some, decline others"). The base PTY_DRIVER writes the
// whole answer string at once, which works for a single prompt but cannot target
// distinct prompts. Answers arrive as a comma-joined list; each is sent (with a
// trailing newline) once ~0.4s passes with no new output.
const PTY_DRIVER_SEQ = String.raw`
import json, os, pty, re, select, sys, time

cfg = json.loads(sys.argv[1])
env = dict(os.environ)
env["PATH"] = cfg["bin"] + ":" + env.get("PATH", "")
env["FLYWHEEL_TEST_HOOKS"] = "1"
env["FLYWHEEL_DOCTOR_OVERRIDE"] = cfg["doctor"]

parts = [a + "\n" for a in cfg["answers"].split(",")]
argv = ["bash", cfg["init"]] + cfg["args"]

pid, fd = pty.fork()
if pid == 0:
    os.chdir(cfg["cwd"])
    os.execvpe("bash", argv, env)

out = b""
idx = 0
last = time.time()
deadline = time.time() + 30
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
        last = time.time()
    if idx < len(parts) and time.time() - last > 0.4:
        os.write(fd, parts[idx].encode())
        idx += 1
        last = time.time()
try:
    os.close(fd)
except OSError:
    pass
_, status = os.waitpid(pid, 0)
code = os.waitstatus_to_exitcode(status)
text = re.sub(r"\x1b\[[0-9;]*m", "", out.decode("utf-8", "replace"))
print(json.dumps({"exit": code, "out": text}))
`;

/** Drive init under a real pty against a mixed (tags + files) work dir, feeding the
 * comma-separated `answers` one per prompt. Returns exit + ANSI-stripped output +
 * work dir (caller asserts mutations, then rmSync's it). */
function runInitMixedPty(opts: {
  answers: string;
  tags?: string[];
  files?: Record<string, string>;
}): PtyResult {
  const { work, binDir, doctorStub } = makeMixedWorkdir(opts);
  const cfg = JSON.stringify({
    bin: binDir,
    doctor: doctorStub,
    init: initSh,
    args: SCAFFOLD_ARGS,
    cwd: work,
    answers: opts.answers,
  });
  const r = spawnSync("python3", ["-c", PTY_DRIVER_SEQ, cfg], {
    cwd: work,
    encoding: "utf8",
    timeout: 45000,
  });
  if (r.status !== 0 || !r.stdout) {
    rmSync(work, { recursive: true, force: true });
    throw new Error(
      `pty driver failed (status ${r.status}):\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
    );
  }
  const lines = r.stdout.trim().split("\n");
  const lastLine = lines[lines.length - 1] ?? "";
  const parsed = JSON.parse(lastLine) as { exit: number; out: string };
  return { exit: parsed.exit, out: stripAnsi(parsed.out), work };
}

describe("brownfield resolution → completion summary", () => {
  it("resolved (retag y) ⇒ block folds in as configured, verdict complete, exit 0", () => {
    const r = runInitPty({
      answers: "y\n",
      tags: ["3.4.2"],
      withOrigin: true,
    });
    try {
      // The block reaches the summary in the shared vocab as a configured outcome…
      expect(r.out).toContain("Flywheel setup summary for");
      expect(r.out).toMatch(/brownfield: bare-semver tag\(s\) 3\.4\.2 .*— configured/);
      // …and a resolved block is a completed step, not an outstanding blocker, so
      // the run lands on a `complete` verdict (exit 0).
      expect(r.out).toContain("complete");
      expect(r.out).not.toContain("incomplete");
      expect(r.exit, `out:\n${r.out}`).toBe(0);
      // The retag actually happened (the summary reflects a real mutation).
      expect(localTags(r.work)).toContain("v3.4.2");
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });

  it("declined (retag n) ⇒ block folds in as deferred, keeps verdict incomplete, still reaches summary", () => {
    const r = runInitPty({
      answers: "n\n",
      tags: ["3.4.2"],
      withOrigin: true,
    });
    try {
      // The gate passed (block uncounted) so the run reaches the scaffold + summary
      // rather than hard-stopping at §0 — the summary section is printed.
      expect(r.out).toContain("Flywheel setup summary for");
      // A declined block folds in as a deferred outcome in the shared vocabulary.
      expect(r.out).toMatch(/brownfield: bare-semver tag\(s\) 3\.4\.2 .*— deferred/);
      // …but it is an UNRESOLVED block the adopter deferred → verdict stays incomplete.
      expect(r.out).toContain("incomplete");
      expect(r.exit, `out:\n${r.out}`).not.toBe(0);
      // Declined → nothing was retagged.
      expect(localTags(r.work)).not.toContain("v3.4.2");
      expect(localTags(r.work)).toContain("3.4.2");
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });
});

describe("brownfield resolution — accept some, decline others (single run)", () => {
  it("two blocks, accept retag + decline release removal ⇒ accepted applied, declined left, run continues, summary records both", () => {
    // Detection order: release_conflict is gathered BEFORE version_tag_shape
    // (preflight_run), so brownfield_resolve offers the release-removal first and
    // the retag second. Answer: n (decline removal), then y (accept retag).
    const r = runInitMixedPty({
      answers: "n,y",
      tags: ["3.4.2"],
      files: { ".goreleaser.yml": GORELEASER_CONFIG },
    });
    try {
      // Both offers were presented in the one run.
      expect(r.out).toContain("Remove these prior release-system files?");
      expect(r.out).toContain("Create and push these v-prefixed tags?");

      // The ACCEPTED retag was applied; the DECLINED release file was left untouched.
      expect(localTags(r.work)).toContain("v3.4.2");
      expect(existsSync(join(r.work, ".goreleaser.yml"))).toBe(true);

      // The run CONTINUED past the gate (both blocks uncounted) into the scaffold +
      // summary — it did not hard-stop at §0.
      expect(r.out).toContain("Flywheel setup summary for");
      expect(existsSync(join(r.work, ".flywheel.yml"))).toBe(true);

      // The summary records BOTH outcomes in the shared vocabulary: the retag as a
      // configured step, the declined removal as a deferred one.
      expect(r.out).toMatch(/brownfield: bare-semver tag\(s\) 3\.4\.2 .*— configured/);
      expect(r.out).toMatch(/brownfield: goreleaser detected in \.goreleaser\.yml.*— deferred/);

      // A deferred (declined) block keeps the verdict incomplete; the run still
      // completed end-to-end (reached the summary above).
      expect(r.out).toContain("incomplete");
      expect(r.exit, `out:\n${r.out}`).not.toBe(0);
    } finally {
      rmSync(r.work, { recursive: true, force: true });
    }
  });
});
