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

  it("has main as the only branch in the only stream and treats it as a single-branch (notice expected)", () => {
    const text = readFileSync(join(repoRoot, ".flywheel.yml"), "utf8");
    const result = loadConfig(text);
    expect(result.config!.streams).toHaveLength(1);
    expect(result.config!.streams[0]!.name).toBe("main-line");
    expect(result.config!.streams[0]!.branches).toHaveLength(1);
    expect(result.config!.streams[0]!.branches[0]!.name).toBe("main");
    // Single-branch stream → info notice (not an error).
    expect(result.notices.some((n) => n.includes("only one branch"))).toBe(true);
  });

  it("does not allow feat! in main's auto_merge (major bumps require human review)", () => {
    const text = readFileSync(join(repoRoot, ".flywheel.yml"), "utf8");
    const result = loadConfig(text);
    const main = result.config!.streams[0]!.branches[0]!;
    expect(main.auto_merge).not.toContain("feat!");
    expect(main.auto_merge).toContain("feat");
    expect(main.auto_merge).toContain("fix!");
  });
});
