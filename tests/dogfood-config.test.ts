import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { loadConfig } from "../src/config.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("the repo's actual .flywheel.yml (dogfood config)", () => {
  it("loads cleanly with no errors", () => {
    const text = readFileSync(join(repoRoot, ".flywheel.yml"), "utf8");
    const result = loadConfig(text);
    expect(result.errors).toEqual([]);
    expect(result.config).not.toBeNull();
  });

  it("has develop → main as the stream branches (develop is the dev prerelease channel)", () => {
    const text = readFileSync(join(repoRoot, ".flywheel.yml"), "utf8");
    const result = loadConfig(text);
    expect(result.config!.streams).toHaveLength(1);
    expect(result.config!.streams[0]!.name).toBe("main-line");
    expect(result.config!.streams[0]!.branches.map((b) => b.name)).toEqual([
      "develop",
      "main",
    ]);
    expect(result.config!.streams[0]!.branches[0]!.release).toBe("prerelease");
    expect(result.config!.streams[0]!.branches[0]!.suffix).toBe("dev");
    expect(result.config!.streams[0]!.branches[1]!.release).toBe("production");
  });

  it("excludes all bumping types from main's auto_merge (release-gate budget)", () => {
    // Every bumping promotion to main triggers semantic-release, which fires
    // release-gate.yml and consumes one ~300–500-call e2e run against the
    // shared sandbox installation. Auto-merging bumping promotions makes
    // that cadence equal to develop-push cadence and undoes the budget
    // savings §spec:sandbox-test-budget was designed to capture. Non-bumping
    // promotions cost nothing because semantic-release computes no version
    // bump for them and no release fires — they stay listed. See
    // §spec:release-gate, "Promotion cadence".
    const text = readFileSync(join(repoRoot, ".flywheel.yml"), "utf8");
    const result = loadConfig(text);
    const main = result.config!.streams[0]!.branches.find((b) => b.name === "main")!;
    const bumping = ["feat", "feat!", "fix", "fix!", "perf"];
    for (const type of bumping) {
      expect(main.auto_merge).not.toContain(type);
    }
    const nonBumping = ["chore", "refactor", "style", "test", "docs", "ci", "build"];
    for (const type of nonBumping) {
      expect(main.auto_merge).toContain(type);
    }
  });

  it("sets release_as_draft: true on main (release gate; develop stays default)", () => {
    // The release gate (§spec:release-gate) holds production releases as
    // unpublished drafts until release-gate.yml runs the full e2e suite
    // against the tagged SHA and calls the Update Release API. The flag
    // here is what makes that handoff possible — semantic-release sees
    // draftRelease: true on main and creates the release object without
    // publishing it. Drift on this line silently disables the gate:
    // every promotion would immediately publish, and the floating @vN
    // tag would advance without an e2e check. develop must stay on the
    // default immediate-publish path so dev releases continue to fire
    // release: published events normally.
    const text = readFileSync(join(repoRoot, ".flywheel.yml"), "utf8");
    const result = loadConfig(text);
    const branches = result.config!.streams[0]!.branches;
    const develop = branches.find((b) => b.name === "develop")!;
    const main = branches.find((b) => b.name === "main")!;
    expect(main.release_as_draft).toBe(true);
    expect(develop.release_as_draft).toBeUndefined();
  });
});
