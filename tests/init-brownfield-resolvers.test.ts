import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
