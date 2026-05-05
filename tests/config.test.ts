import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { loadConfig } from "../src/config.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "test-fixtures");
const fx = (name: string) => readFileSync(join(fixturesDir, name), "utf8");

describe("loadConfig", () => {
  it("parses the canonical valid example", () => {
    const result = loadConfig(fx("flywheel.valid.yml"));
    expect(result.errors).toEqual([]);
    expect(result.config).not.toBeNull();
    expect(result.config!.streams).toHaveLength(2);
    expect(result.config!.streams[0]!.name).toBe("main-line");
    expect(result.config!.streams[0]!.branches.map((b) => b.name)).toEqual([
      "develop",
      "staging",
      "main",
    ]);
    expect(result.config!.streams[0]!.branches[0]!.release).toBe("none");
    expect(result.config!.streams[0]!.branches[1]!.release).toBe("prerelease");
    expect(result.config!.streams[0]!.branches[1]!.suffix).toBe("rc");
    expect(result.config!.streams[0]!.branches[2]!.release).toBe("production");
    expect(result.config!.streams[0]!.branches[2]!.suffix).toBeUndefined();
    expect(result.config!.merge_strategy).toBe("squash");
  });

  it("flags branch in multiple streams (rule 1)", () => {
    const result = loadConfig(fx("flywheel.dup-branch.yml"));
    expect(result.config).toBeNull();
    expect(result.errors.some((e) => e.includes('branch "shared" appears in multiple streams'))).toBe(true);
  });

  it("flags multiple production branches in same stream (rule 2)", () => {
    const result = loadConfig(fx("flywheel.dup-prod-in-stream.yml"));
    expect(result.config).toBeNull();
    expect(
      result.errors.some((e) =>
        e.includes('stream "main-line": multiple production branches'),
      ),
    ).toBe(true);
  });

  it("flags multiple streams with terminal production branch as a hard error (rule 3, §Versioning correction)", () => {
    const result = loadConfig(fx("flywheel.dup-prod-across-streams.yml"));
    expect(result.config).toBeNull();
    expect(
      result.errors.some((e) => e.includes("multiple streams have a terminal production branch")),
    ).toBe(true);
  });

  it("flags duplicate suffix across prerelease branches", () => {
    const result = loadConfig(fx("flywheel.dup-prerelease.yml"));
    expect(result.config).toBeNull();
    expect(
      result.errors.some((e) => e.includes('suffix "dev" used by multiple prerelease branches')),
    ).toBe(true);
  });

  it("flags duplicate stream names", () => {
    const yamlText = `
flywheel:
  streams:
    - name: dup
      branches:
        - name: a
          release: production
          auto_merge: []
    - name: dup
      branches:
        - name: b
          release: production
          auto_merge: []
`;
    const result = loadConfig(yamlText);
    expect(result.config).toBeNull();
    expect(result.errors.some((e) => e.includes('duplicate stream name: "dup"'))).toBe(true);
  });

  it("flags unrecognized auto_merge entries (rule 4)", () => {
    const result = loadConfig(fx("flywheel.bad-type.yml"));
    expect(result.config).toBeNull();
    expect(result.errors.some((e) => e.includes('"flatfish" is not a recognized'))).toBe(true);
  });

  it("emits an info notice for single-branch streams (rule 5, not an error)", () => {
    const result = loadConfig(fx("flywheel.single-branch.yml"));
    expect(result.errors).toEqual([]);
    expect(result.config).not.toBeNull();
    expect(result.notices.some((n) => n.includes('stream "solo" has only one branch'))).toBe(true);
  });

  it("flags unknown keys (rule 6) — catches `auto-merge` typo", () => {
    const result = loadConfig(fx("flywheel.unknown-key.yml"));
    expect(result.config).toBeNull();
    expect(result.errors.some((e) => e.includes("auto-merge: unknown key"))).toBe(true);
  });

  it("collects multiple errors into a single result (no first-error-wins)", () => {
    const yamlText = `
flywheel:
  streams:
    - name: bad-stream
      branches:
        - name: only
          release: production
          auto_merge: [fix, totally-not-a-type, zzz]
`;
    const result = loadConfig(yamlText);
    expect(result.config).toBeNull();
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  it("parses release: none on a non-terminal branch", () => {
    const result = loadConfig(fx("flywheel.release-none.yml"));
    expect(result.errors).toEqual([]);
    expect(result.config).not.toBeNull();
    expect(result.config!.streams[0]!.branches[0]!.release).toBe("none");
    expect(result.config!.streams[0]!.branches[0]!.suffix).toBeUndefined();
  });

  it("flags terminal release: none (rule 4)", () => {
    const result = loadConfig(fx("flywheel.terminal-none.yml"));
    expect(result.config).toBeNull();
    expect(
      result.errors.some(
        (e) =>
          e.includes('stream "main-line"') &&
          e.includes('terminal branch "staging"') &&
          e.includes("release: none"),
      ),
    ).toBe(true);
  });

  it("rejects suffix when release is not prerelease", () => {
    const result = loadConfig(fx("flywheel.suffix-without-prerelease.yml"));
    expect(result.config).toBeNull();
    expect(
      result.errors.some((e) =>
        e.includes('only valid when release is "prerelease"'),
      ),
    ).toBe(true);
  });

  it("rejects release: prerelease without a suffix", () => {
    const result = loadConfig(fx("flywheel.prerelease-without-suffix.yml"));
    expect(result.config).toBeNull();
    expect(
      result.errors.some((e) =>
        e.includes('required when release is "prerelease"'),
      ),
    ).toBe(true);
  });

  it("rejects unknown release mode", () => {
    const yamlText = `
flywheel:
  streams:
    - name: only
      branches:
        - name: main
          release: somethingelse
          auto_merge: []
`;
    const result = loadConfig(yamlText);
    expect(result.config).toBeNull();
    expect(
      result.errors.some((e) => e.includes("must be one of none, prerelease, production")),
    ).toBe(true);
  });

  it("errors on completely missing top-level flywheel mapping", () => {
    const result = loadConfig("not-the-right-key:\n  streams: []\n");
    expect(result.config).toBeNull();
    expect(result.errors[0]).toContain("expected a top-level `flywheel:` mapping");
  });

  it("errors on malformed YAML", () => {
    const result = loadConfig("flywheel: [\n  not yaml\n");
    expect(result.config).toBeNull();
    expect(result.errors[0]).toContain("failed to parse YAML");
  });

  it("rejects merge_strategy: merge with descriptive error", () => {
    const yamlText = `
flywheel:
  streams:
    - name: only
      branches:
        - name: main
          release: production
          auto_merge: []
  merge_strategy: merge
`;
    const result = loadConfig(yamlText);
    expect(result.config).toBeNull();
    expect(result.errors.some((e) => e.includes('merge_strategy'))).toBe(true);
  });
});
