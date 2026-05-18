import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// End-to-end exercise of scripts/release-major-tag.sh — the "Move
// floating major tag" step of release-major-tag.yml, extracted from
// inline YAML in #133. The step floats `vX` (or `<stream>/vX`) onto the
// release tag a `release: published` event just created. A slip in the
// tag-name regex silently strands every `@v1` consumer on the prior
// release, or floats the major onto a pre-release.
//
// Each case runs the actual script against a throwaway repo wired to a
// bare `origin`, then asserts what reached the remote.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = join(repoRoot, "scripts", "release-major-tag.sh");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

// A work repo with one commit, wired to a bare `origin`. `tagName` is
// created as a local tag pointing at HEAD — the release tag the float
// targets. The source tag is intentionally not pushed; the script is
// what should push the derived major tag.
function setupRepo(tagName: string): { work: string; remote: string; head: string } {
  const remote = mkdtempSync(join(tmpdir(), "flywheel-major-remote-"));
  git(remote, "init", "-q", "--bare", "-b", "main");
  const work = mkdtempSync(join(tmpdir(), "flywheel-major-work-"));
  git(work, "init", "-q", "-b", "main");
  git(work, "config", "user.email", "test@test");
  git(work, "config", "user.name", "test");
  writeFileSync(join(work, "file.txt"), "release\n");
  git(work, "add", "file.txt");
  git(work, "commit", "-q", "-m", "init");
  git(work, "remote", "add", "origin", remote);
  git(work, "push", "-q", "origin", "main");
  git(work, "tag", tagName);
  return { work, remote, head: git(work, "rev-parse", "HEAD").trim() };
}

function runScript(work: string, tagName: string): string {
  return execFileSync("bash", [scriptPath], {
    cwd: work,
    env: { ...process.env, TAG_NAME: tagName },
    encoding: "utf8",
  });
}

// Tag names present on the bare remote.
function remoteTags(remote: string): Set<string> {
  return new Set(
    git(remote, "tag", "--list")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
}

function cleanup(work: string, remote: string): void {
  rmSync(work, { recursive: true, force: true });
  rmSync(remote, { recursive: true, force: true });
}

describe("release-major-tag.sh — floats the major tag", () => {
  it("floats `vX` for a primary-stream vX.Y.Z release", () => {
    const { work, remote, head } = setupRepo("v1.2.3");
    try {
      const out = runScript(work, "v1.2.3");
      expect(out).toContain("Floating v1 → v1.2.3");
      expect(remoteTags(remote)).toContain("v1");
      // The floated tag points at the release tag's commit.
      expect(git(work, "rev-parse", "v1^{commit}").trim()).toBe(head);
    } finally {
      cleanup(work, remote);
    }
  });

  it("floats `<stream>/vX` for a scoped-stream tag", () => {
    const { work, remote, head } = setupRepo("customer-acme/v1.2.3");
    try {
      const out = runScript(work, "customer-acme/v1.2.3");
      expect(out).toContain("Floating customer-acme/v1 → customer-acme/v1.2.3");
      expect(remoteTags(remote)).toContain("customer-acme/v1");
      expect(git(work, "rev-parse", "customer-acme/v1^{commit}").trim()).toBe(head);
    } finally {
      cleanup(work, remote);
    }
  });

  it("derives a multi-digit major correctly", () => {
    const { work, remote } = setupRepo("v10.2.3");
    try {
      const out = runScript(work, "v10.2.3");
      expect(out).toContain("Floating v10 → v10.2.3");
      expect(remoteTags(remote)).toContain("v10");
    } finally {
      cleanup(work, remote);
    }
  });
});

describe("release-major-tag.sh — skips non-release tags", () => {
  it("skips a pre-release tag without floating the major", () => {
    const { work, remote } = setupRepo("v1.2.3-dev.1");
    try {
      const out = runScript(work, "v1.2.3-dev.1");
      expect(out).toContain("skipping major-tag float");
      // Nothing pushed — the -dev tag is not a stable release line.
      expect(remoteTags(remote).size).toBe(0);
    } finally {
      cleanup(work, remote);
    }
  });

  it("skips a malformed tag with no `v` prefix", () => {
    const { work, remote } = setupRepo("1.2.3");
    try {
      const out = runScript(work, "1.2.3");
      expect(out).toContain("skipping major-tag float");
      expect(remoteTags(remote).size).toBe(0);
    } finally {
      cleanup(work, remote);
    }
  });
});
