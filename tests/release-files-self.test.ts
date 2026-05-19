import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { generateReleaseRc } from "../src/release-rc.js";
import type { FlywheelConfig, ReleaseFileDeclarative, Stream } from "../src/types.js";

// Issue #166: the reusable workflows had a hardcoded `point-source/flywheel@v1`
// that didn't update when an adopter pinned an exact workflow tag for rollback,
// so the action SHA was always whatever the floating `@v1` pointed at.
// The fix declares both files in this repo's own .flywheel.yml `release_files`,
// so semantic-release's prepareCmd sed-bumps the line to the matching
// `@v${nextRelease.version}` during the chore(release) commit — making the tag
// content reproducible.
//
// This file guards that invariant end-to-end: the entries must remain in
// .flywheel.yml, must target the actual workflow paths, and the generated sed
// must correctly bump both the trunk form (`@v1`) and the post-release form
// (`@v1.2.3-dev.4`) to a literal `@v<exact>`.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const REUSABLE_WORKFLOWS = [
  ".github/workflows/pr.yml",
  ".github/workflows/push.yml",
];

const TEST_VERSION = "9.9.9-test.1";

function loadRepoConfig(): FlywheelConfig {
  const yamlText = readFileSync(join(repoRoot, ".flywheel.yml"), "utf8");
  const result = loadConfig(yamlText);
  expect(result.errors).toEqual([]);
  expect(result.config).not.toBeNull();
  return result.config!;
}

function findEntry(
  config: FlywheelConfig,
  path: string,
): ReleaseFileDeclarative {
  const entry = (config.release_files ?? []).find((e) => e.path === path);
  expect(entry, `release_files entry for ${path}`).toBeDefined();
  expect("pattern" in entry!, `${path} must use declarative form`).toBe(true);
  return entry as ReleaseFileDeclarative;
}

describe("release_files self-bump for reusable workflows (#166)", () => {
  it(".flywheel.yml declares declarative entries for both reusable workflows", () => {
    const config = loadRepoConfig();
    for (const path of REUSABLE_WORKFLOWS) {
      const entry = findEntry(config, path);
      expect(entry.pattern).toContain("point-source/flywheel@v");
      expect(entry.replacement).toBe("point-source/flywheel@v${version}");
    }
  });

  it("each reusable workflow contains a single action-ref line the pattern matches", () => {
    const config = loadRepoConfig();
    for (const path of REUSABLE_WORKFLOWS) {
      const entry = findEntry(config, path);
      const content = readFileSync(join(repoRoot, path), "utf8");
      const re = new RegExp(entry.pattern, "g");
      const matches = content.match(re) ?? [];
      // Exactly one ref — the action invocation. The reusable workflow shell
      // shouldn't gain a second `point-source/flywheel@v…` ref without a
      // corresponding release_files revisit.
      expect(matches, `unexpected match count in ${path}`).toHaveLength(1);
    }
  });

  it("generated prepareCmd contains shell-safe sed for both workflows, in order", () => {
    const config = loadRepoConfig();
    const stream: Stream =
      config.streams.find((s) =>
        s.branches.some((b) => b.release === "production"),
      ) ?? config.streams[0]!;
    const rc = generateReleaseRc(stream, config);
    const execEntry = rc.plugins.find(
      (p): p is [string, { prepareCmd: string }] =>
        Array.isArray(p) && p[0] === "@semantic-release/exec",
    );
    expect(execEntry).toBeDefined();
    const cmd = execEntry![1].prepareCmd;
    for (const path of REUSABLE_WORKFLOWS) {
      // Single-quoted shell-safe form per src/release-rc.ts.
      expect(cmd).toContain(`'${path}'`);
      expect(cmd).toContain(`rm '${path}.bak'`);
    }
    // The pattern itself is delimited by `|` and contains the action ref.
    expect(cmd).toContain("point-source/flywheel@v");
    // The replacement carries the Lodash placeholder for semantic-release to
    // expand at runtime — without it, the bump wouldn't be a real version.
    expect(cmd).toContain("@v${nextRelease.version}");
  });

  // End-to-end: actually execute the generated sed against fixture content
  // (mirroring how `@semantic-release/exec` will run it in CI). We swap the
  // Lodash token for a concrete version locally — production goes through
  // lodash.template — but the shell behavior, regex semantics, and escaping
  // are exercised verbatim.
  for (const [label, source] of [
    ["floating major (@v1) trunk source-of-truth", "      - uses: point-source/flywheel@v1\n"],
    [
      "post-release exact form (@v1.2.3-dev.4)",
      "      - uses: point-source/flywheel@v1.2.3-dev.4\n",
    ],
    [
      "post-release stable form (@v1.2.3)",
      "      - uses: point-source/flywheel@v1.2.3\n",
    ],
  ] as const) {
    it(`sed bumps ${label} to @v<exact>`, () => {
      const config = loadRepoConfig();
      const dir = mkdtempSync(join(tmpdir(), "flywheel-self-rf-"));
      // Build a fake config whose only release_files entry mirrors the
      // production entry but points at a temp file, so the sed under test is
      // exactly the production sed (same pattern, same replacement) running
      // against fixture content.
      const realEntry = findEntry(config, REUSABLE_WORKFLOWS[0]!);
      const file = join(dir, "fixture.yml");
      writeFileSync(file, source);
      const rc = generateReleaseRc(
        config.streams[0]!,
        {
          streams: config.streams,
          release_files: [
            { path: file, pattern: realEntry.pattern, replacement: realEntry.replacement },
          ],
        },
      );
      const execEntry = rc.plugins.find(
        (p): p is [string, { prepareCmd: string }] =>
          Array.isArray(p) && p[0] === "@semantic-release/exec",
      )!;
      // Substitute the Lodash placeholder with a concrete version — this is
      // what @semantic-release/exec does at runtime via lodash.template.
      const cmd = execEntry[1].prepareCmd.replace(
        /\$\{nextRelease\.version\}/g,
        TEST_VERSION,
      );
      execFileSync("sh", ["-c", cmd]);
      expect(readFileSync(file, "utf8")).toBe(
        `      - uses: point-source/flywheel@v${TEST_VERSION}\n`,
      );
    });
  }
});
