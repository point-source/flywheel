import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// End-to-end exercise of scripts/register-merge-drivers.sh — the
// "Register Flywheel merge drivers" workflow step extracted from inline
// YAML in #133. The step is one typo away from a release-halt: if the
// driver string breaks no driver fires and every release back-merge
// hits the #112 CHANGELOG.md / release_files conflict. The string was
// already silently broken once (#119).
//
// These tests run the *actual* script in a throwaway git repo and
// assert against real `git config` state, the real .git/info/attributes
// it writes, and a real `git merge` that the registered drivers must
// resolve. The changelog driver's leaf command is swapped for a stub
// echo (the production form shells out to `npx conventional-changelog`,
// which needs the network); the release-file driver (`driver = true`,
// git's builtin) is exercised entirely unstubbed.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = join(repoRoot, "scripts", "register-merge-drivers.sh");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function runScript(cwd: string): void {
  execFileSync("bash", [scriptPath], { cwd, encoding: "utf8" });
}

// The release_files derivation shells out to `python3` + PyYAML, which
// CI's ubuntu-latest has preinstalled but a bare dev machine may not.
// Skip those cases rather than fail the suite — the script swallows the
// same absence at runtime (`2>/dev/null || true`).
function pythonYamlAvailable(): boolean {
  return (
    spawnSync("python3", ["-c", "import yaml"], { stdio: "ignore" }).status === 0
  );
}

// A repo with one CHANGELOG.md commit on `main`. Drivers are *not* yet
// registered — that's the script's job.
function setupRepo(): string {
  const work = mkdtempSync(join(tmpdir(), "flywheel-register-drivers-"));
  git(work, "init", "-q", "-b", "main");
  git(work, "config", "user.email", "test@test");
  git(work, "config", "user.name", "test");
  writeFileSync(join(work, "CHANGELOG.md"), "## [1.0.0]\n\nInitial.\n");
  git(work, "add", "CHANGELOG.md");
  git(work, "commit", "-q", "-m", "init");
  return work;
}

describe("register-merge-drivers.sh — git config", () => {
  it("registers both merge drivers with the working `> \"%A\"` redirect form", () => {
    const work = setupRepo();
    try {
      runScript(work);

      expect(git(work, "config", "--get", "merge.flywheel-changelog.name").trim()).toBe(
        "Flywheel CHANGELOG regenerator",
      );
      const changelogDriver = git(
        work,
        "config",
        "--get",
        "merge.flywheel-changelog.driver",
      ).trim();
      expect(changelogDriver).toBe(
        'npx --yes conventional-changelog-cli@5 -p angular -r 0 > "%A"',
      );
      // Regression guard for #119: the broken form nested a `bash -c`
      // inside git's own `sh -c` invocation and lost the `%A` target.
      expect(changelogDriver).not.toMatch(/bash -c/);
      expect(changelogDriver).not.toMatch(/\$1/);

      expect(
        git(work, "config", "--get", "merge.flywheel-release-file.name").trim(),
      ).toBe("Flywheel release-file (keep ours)");
      expect(
        git(work, "config", "--get", "merge.flywheel-release-file.driver").trim(),
      ).toBe("true");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe("register-merge-drivers.sh — .git/info/attributes", () => {
  it("maps CHANGELOG.md when there is no .flywheel.yml", () => {
    const work = setupRepo();
    try {
      runScript(work);
      const attributes = readFileSync(join(work, ".git/info/attributes"), "utf8");
      expect(attributes).toBe("CHANGELOG.md merge=flywheel-changelog\n");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it.skipIf(!pythonYamlAvailable())(
    "derives a release-file mapping per .flywheel.yml release_files entry",
    () => {
      const work = setupRepo();
      try {
        writeFileSync(
          join(work, ".flywheel.yml"),
          "flywheel:\n  release_files:\n    - path: VERSION\n    - path: pubspec.yaml\n",
        );
        runScript(work);
        const attributes = readFileSync(join(work, ".git/info/attributes"), "utf8");
        expect(attributes).toContain("CHANGELOG.md merge=flywheel-changelog");
        expect(attributes).toContain("VERSION merge=flywheel-release-file");
        expect(attributes).toContain("pubspec.yaml merge=flywheel-release-file");
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  );
});

describe("register-merge-drivers.sh — drivers fire on a real merge", () => {
  it("the registered flywheel-changelog driver auto-resolves a CHANGELOG.md conflict", () => {
    const work = setupRepo();
    try {
      // Real registration + real .git/info/attributes written by the
      // script. Only the leaf command is swapped for a network-free stub
      // (production shells out to `npx conventional-changelog`).
      runScript(work);
      git(
        work,
        "config",
        "merge.flywheel-changelog.driver",
        'echo MERGE-DRIVER-FIRED > "%A"',
      );

      // develop and main both rewrite the top CHANGELOG.md block — the
      // structural shape that defeats a plain three-way merge (#112).
      git(work, "checkout", "-q", "-b", "develop");
      writeFileSync(
        join(work, "CHANGELOG.md"),
        "## [1.0.1-dev.1]\n\nDev.\n\n## [1.0.0]\n\nInitial.\n",
      );
      git(work, "commit", "-q", "-am", "develop: dev.1");
      git(work, "checkout", "-q", "main");
      writeFileSync(
        join(work, "CHANGELOG.md"),
        "## [1.1.0]\n\nRelease.\n\n## [1.0.0]\n\nInitial.\n",
      );
      git(work, "commit", "-q", "-am", "main: release 1.1.0");

      git(work, "checkout", "-q", "-B", "_back_merge_tmp", "develop");
      git(work, "merge", "--no-ff", "-m", "back-merge main into develop", "main");

      expect(readFileSync(join(work, "CHANGELOG.md"), "utf8").trim()).toBe(
        "MERGE-DRIVER-FIRED",
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it.skipIf(!pythonYamlAvailable())(
    "the registered flywheel-release-file driver keeps ours on a release_files path",
    () => {
      const work = setupRepo();
      try {
        // VERSION is declared a release_file, so the script's attributes
        // derivation maps it to the `true` (keep-ours) driver. Nothing is
        // stubbed here — `true` is git's builtin.
        writeFileSync(join(work, ".flywheel.yml"), "flywheel:\n  release_files:\n    - path: VERSION\n");
        writeFileSync(join(work, "VERSION"), "1.0.0\n");
        git(work, "add", ".flywheel.yml", "VERSION");
        git(work, "commit", "-q", "-m", "add VERSION");
        runScript(work);

        git(work, "checkout", "-q", "-b", "develop");
        writeFileSync(join(work, "VERSION"), "1.0.1-dev.1\n");
        git(work, "commit", "-q", "-am", "develop: bump");
        git(work, "checkout", "-q", "main");
        writeFileSync(join(work, "VERSION"), "1.1.0\n");
        git(work, "commit", "-q", "-am", "main: release");

        git(work, "checkout", "-q", "-B", "_back_merge_tmp", "develop");
        git(work, "merge", "--no-ff", "-m", "back-merge main into develop", "main");

        // Driver `true` keeps the current branch's content (develop's).
        expect(readFileSync(join(work, "VERSION"), "utf8").trim()).toBe("1.0.1-dev.1");
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  );
});
