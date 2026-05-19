import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

import { loadConfig } from "../src/config.js";

// Every full `.flywheel.yml` example shown to adopters — in `README.md`,
// `docs/**/*.md`, and the `scripts/templates/flywheel.*.yml` files that
// `init.sh` writes into new repos — is a recipe they copy verbatim. If the
// documented config doesn't validate, adopters can't get started (see #165:
// the "minimal viable" snippet in setup.md was missing `release:` and failed
// `loadConfig` on the first try). This test extracts those examples and runs
// them through the same parser the action uses at runtime, asserting they
// produce no errors.
//
// Partial snippets that illustrate a single section of the schema (e.g. a
// `release_files:` block on its own in spec.md / recipes.md) are intentionally
// excluded: they aren't intended to round-trip through `loadConfig`. The
// inclusion filter is "has a top-level `flywheel:` key AND a `streams:` child";
// see `isFullFlywheelConfig` below.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function findMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...findMarkdownFiles(full));
    else if (entry.endsWith(".md")) out.push(full);
  }
  return out;
}

function extractYamlBlocks(text: string): { line: number; body: string }[] {
  const lines = text.split("\n");
  const out: { line: number; body: string }[] = [];
  let open = -1;
  let buf: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]!;
    if (open === -1 && /^```yaml\s*$/.test(ln)) {
      open = i + 1;
      buf = [];
    } else if (open !== -1 && /^```\s*$/.test(ln)) {
      out.push({ line: open, body: buf.join("\n") });
      open = -1;
    } else if (open !== -1) {
      buf.push(ln);
    }
  }
  return out;
}

function isFullFlywheelConfig(body: string): boolean {
  return /^flywheel:\s*$/m.test(body) && /^\s+streams:\s*$/m.test(body);
}

const cases: { label: string; body: string }[] = [];

const markdownFiles = [
  join(repoRoot, "README.md"),
  ...findMarkdownFiles(join(repoRoot, "docs")),
];
for (const file of markdownFiles) {
  const text = readFileSync(file, "utf8");
  for (const block of extractYamlBlocks(text)) {
    if (isFullFlywheelConfig(block.body)) {
      cases.push({
        label: `${relative(repoRoot, file)}:${block.line}`,
        body: block.body,
      });
    }
  }
}

const templatesDir = join(repoRoot, "scripts", "templates");
for (const entry of readdirSync(templatesDir)) {
  if (/^flywheel\..+\.yml$/.test(entry)) {
    const full = join(templatesDir, entry);
    cases.push({
      label: relative(repoRoot, full),
      body: readFileSync(full, "utf8"),
    });
  }
}

describe("docs and template .flywheel.yml examples", () => {
  it("extractor found at least one example (regression guard on the extractor itself)", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases)("$label parses with no errors", ({ body }) => {
    const result = loadConfig(body);
    expect(result.errors).toEqual([]);
    expect(result.config).not.toBeNull();
  });
});
