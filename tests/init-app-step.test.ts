import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Copy-regression guard for scripts/init.sh's interactive GitHub-App step.
//
// WS1 (#236) rewrote the App-step prompt so it explains the *need* before the
// *mechanism*: the exact permission set, the App's lifetime/permanence, and
// why an App and not a PAT. That wording is adopter-facing onboarding copy and
// must stay in lockstep with docs/adopter/setup.md §1.
//
// The prompt is gated on INTERACTIVE=1 AND reads from fd 3 (`read -u 3`), and
// the vitest harness can't reliably reach it at runtime (INTERACTIVE=0; the
// FLYWHEEL_ASSUME_INTERACTIVE hook flips INTERACTIVE but never opens fd 3).
// So this pins the interactive branch by SOURCE-SLICE: read init.sh as text
// and assert on the literal echo lines. No gh/doctor stub needed, no skipIf —
// these assertions never execute init.sh, so they always run.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const initSh = join(repoRoot, "scripts/init.sh");
const source = readFileSync(initSh, "utf8");

describe("init.sh GitHub-App step copy", () => {
  it("names the exact permission set (matches docs/adopter/setup.md §1)", () => {
    expect(source).toContain("Contents");
    expect(source).toContain("Pull requests");
    expect(source).toContain("Issues");
    expect(source).toContain("Checks");
    expect(source).toContain("Metadata");
    expect(source).toContain("(read/write)");
    expect(source).toContain("(read)");
  });

  it("explains the App's permanence and the rotate/revoke consequence", () => {
    expect(source).toContain("permanent dependency");
    expect(source).toContain("rotating its credential or revoking the App");
  });

  it("explains why an App and not a personal access token", () => {
    expect(source).toContain("Why an App and not a personal access token");
    expect(source).toContain("Integration-type bypass actor");
  });

  it("no longer leads with the bare installation-tokens phrasing", () => {
    expect(source).not.toContain(
      "Flywheel needs a GitHub App for installation tokens",
    );
  });

  it("still offers the three setup-path menu options", () => {
    expect(source).toContain("Create the App for me");
    expect(source).toContain("I have an App already");
    expect(source).toContain("Skip");
  });
});
