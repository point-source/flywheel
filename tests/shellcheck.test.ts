import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Static lint pass for every shell script in `scripts/`. Catches the class
// of bugs that bit the back-merge step repeatedly: unquoted variables,
// bad printf escaping (the kind that survives `bash -n` because it's
// inside `$(...)` command substitution), `[ -z $var ]` truthiness traps,
// SC2086 word-splitting, etc. Skipped if shellcheck isn't on PATH so
// developer machines without it don't fail the suite — CI installs it.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const scriptsDir = join(repoRoot, "scripts");

function shellcheckAvailable(): boolean {
  return spawnSync("shellcheck", ["--version"], { stdio: "ignore" }).status === 0;
}

// Recurse so subdirectories of scripts/ (e.g. scripts/lib/, home of the
// sourceable findings.sh vocabulary lib) are linted too — a top-level-only
// readdir let scripts/lib/*.sh escape coverage entirely. Returns paths
// relative to scriptsDir (e.g. "doctor.sh", "lib/findings.sh") so each
// script's location is visible in the test report.
function listShellScripts(dir: string = scriptsDir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listShellScripts(full));
    } else if (entry.name.endsWith(".sh")) {
      out.push(relative(scriptsDir, full));
    }
  }
  return out.sort();
}

describe.skipIf(!shellcheckAvailable())("shellcheck — every scripts/*.sh", () => {
  const scripts = listShellScripts();

  // One `it` per script so a single broken script fails just one test, not
  // the suite, and the script name appears verbatim in the test report.
  for (const name of scripts) {
    it(`scripts/${name} passes shellcheck`, () => {
      const r = spawnSync(
        "shellcheck",
        // -x follows sourced files; --severity=warning ignores style nits
        // (info/style) so we stop at real issues. Exclude SC2154 (unused
        // refs from sourced files we don't follow) at script level via
        // shellcheck directives if we ever need to; right now scripts/ is
        // self-contained per file.
        ["--severity=warning", join(scriptsDir, name)],
        { encoding: "utf8" },
      );
      expect(r.status, `\nshellcheck output:\n${r.stdout}${r.stderr}`).toBe(0);
    });
  }
});

describe("shellcheck — scripts directory itself", () => {
  it("at least one shell script exists in scripts/ (sanity check)", () => {
    expect(listShellScripts().length).toBeGreaterThan(0);
  });
});
