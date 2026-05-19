import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// End-to-end exercise of the flywheel-changelog custom merge driver: write
// .git/info/attributes + register merge.<name>.driver, induce the structural
// CHANGELOG.md conflict, run `git merge`, and assert the driver actually fired
// (no conflict, file contains the marker the stub wrote).
//
// The stub stands in for `npx --yes conventional-changelog-cli@5 …` from
// register-merge-drivers.sh / init.sh — same `> "%A"` redirect shape, no
// network. If git's
// custom-driver wiring breaks, this catches it without round-tripping through
// a real release. See #119 for the bug it regresses against (the prior
// `bash -c "... > \"$1\"" -- %A` form was silently broken: outer `sh -c`
// expanded `$1` to empty before the inner bash ever saw it).

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function setupRepo(): string {
  const work = mkdtempSync(join(tmpdir(), "flywheel-merge-driver-"));
  git(work, "init", "-q", "-b", "main");
  git(work, "config", "user.email", "test@test");
  git(work, "config", "user.name", "test");
  writeFileSync(join(work, "CHANGELOG.md"), "## [1.0.0]\n\nInitial.\n");
  git(work, "add", "CHANGELOG.md");
  git(work, "commit", "-q", "-m", "init");
  // Develop diverges with a prerelease block on top.
  git(work, "checkout", "-q", "-b", "develop");
  writeFileSync(
    join(work, "CHANGELOG.md"),
    "## [1.0.1-dev.1]\n\nDev.\n\n## [1.0.0]\n\nInitial.\n",
  );
  git(work, "commit", "-q", "-am", "develop: dev.1");
  // Main also diverges with a finalized release block on top — same lines as
  // develop's edit, in the structural shape that breaks plain three-way merge.
  git(work, "checkout", "-q", "main");
  writeFileSync(
    join(work, "CHANGELOG.md"),
    "## [1.1.0]\n\nRelease.\n\n## [1.0.0]\n\nInitial.\n",
  );
  git(work, "commit", "-q", "-am", "main: release 1.1.0");
  return work;
}

describe("flywheel-changelog merge driver", () => {
  it("auto-resolves CHANGELOG.md conflict during back-merge", () => {
    const work = setupRepo();
    try {
      // Register the driver shape used by register-merge-drivers.sh /
      // init.sh — same single-layer `> "%A"` redirect, but echoing a
      // marker instead of shelling out to npx.
      git(
        work,
        "config",
        "merge.flywheel-changelog.driver",
        'echo MERGE-DRIVER-FIRED > "%A"',
      );
      mkdirSync(join(work, ".git/info"), { recursive: true });
      writeFileSync(
        join(work, ".git/info/attributes"),
        "CHANGELOG.md merge=flywheel-changelog\n",
      );

      // Back-merge shape: from develop's HEAD, merge main with --no-ff.
      git(work, "checkout", "-q", "-B", "_back_merge_tmp", "develop");
      git(work, "merge", "--no-ff", "-m", "back-merge main into develop", "main");

      const result = readFileSync(join(work, "CHANGELOG.md"), "utf8");
      expect(result.trim()).toBe("MERGE-DRIVER-FIRED");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("regression: driver string in init.sh and register-merge-drivers.sh does not nest shells", () => {
    // The pre-#119 form `bash -c "... > \"$1\"" -- %A` was silently broken
    // because the outer shell git uses to invoke the driver expanded `$1`
    // (empty in its context) before the inner bash ran. Guard against the
    // pattern coming back. The workflow step that used to carry this string
    // inline was extracted to scripts/register-merge-drivers.sh in #133.
    const repoRoot = join(__dirname, "..");
    for (const path of [
      "scripts/init.sh",
      "scripts/register-merge-drivers.sh",
    ]) {
      const content = readFileSync(join(repoRoot, path), "utf8");
      expect(content, `${path} should not use the broken nested-shell form`).not.toMatch(
        /bash -c .*conventional-changelog-cli.*\\"\$1\\"/,
      );
      expect(content, `${path} should use the direct \`> "%A"\` redirect`).toMatch(
        /conventional-changelog-cli@\d+ -p angular -r 0 > "%A"/,
      );
    }
  });
});
