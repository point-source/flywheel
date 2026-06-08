import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The composite action is the entire adopter surface. The adopter pins
// `point-source/flywheel@<ref>` once and every flywheel file that runs
// comes from that ref: the JS dispatcher under core/, the bundled
// scripts/, and the semantic-release plugin set wired into action.yml.
//
// These assertions lock the surface guarantees in place so a refactor
// can't quietly reintroduce a second version surface (reusable workflows,
// runtime ref derivation, a separate scripts-path output, …). See SPEC
// §spec:action-version-lockstep.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function readFile(relPath: string): string {
  return readFileSync(join(repoRoot, relPath), "utf8");
}

describe("composite action surface (§spec:action-version-lockstep)", () => {
  it("root action.yml is a composite action with no scripts_dir output", () => {
    const content = readFile("action.yml");
    expect(content).toMatch(/runs:\s*\n\s*using:\s*composite/);
    // scripts_dir was the workaround for the reusable-workflow layer
    // not being able to name its own ref. The composite addresses
    // scripts via github.action_path, so the output is gone.
    expect(content).not.toMatch(/scripts_dir/);
  });

  it("root action.yml invokes the nested dispatcher via ./core and forwards its outputs", () => {
    const content = readFile("action.yml");
    expect(content).toMatch(/uses:\s*\.\/core/);
    expect(content).toMatch(/id:\s*core/);
    for (const name of ["token", "managed_branch", "back_merge_targets"]) {
      expect(content).toMatch(
        new RegExp(
          `\\n\\s{2}${name}:[\\s\\S]*?value:\\s*\\$\\{\\{\\s*steps\\.core\\.outputs\\.${name}\\s*\\}\\}`,
        ),
      );
    }
  });

  it("root action.yml invokes every release script through github.action_path", () => {
    const content = readFile("action.yml");
    // Find every `run:` line that ends in a .sh invocation. Each must
    // resolve the script through github.action_path so it runs out of
    // this action's own checkout — not the adopter's working tree,
    // which doesn't contain scripts/.
    const runShLines = content
      .split("\n")
      .filter((line) => /^\s*run:\s*.*\.sh\b/.test(line));
    expect(runShLines.length).toBeGreaterThan(0);
    for (const line of runShLines) {
      expect(line).toContain("github.action_path");
      expect(line).not.toMatch(/run:\s*bash\s+scripts\//);
    }
  });

  it("core/action.yml is the JS dispatcher (node24, dist/index.cjs) and declares the dispatcher outputs", () => {
    const content = readFile("core/action.yml");
    expect(content).toMatch(/runs:\s*\n\s*using:\s*node24/);
    expect(content).toMatch(/main:\s*dist\/index\.cjs/);
    for (const name of ["token", "managed_branch", "back_merge_targets"]) {
      expect(content).toMatch(new RegExp(`\\n\\s{2}${name}:\\s*\\n\\s{4}description:`));
    }
    expect(content).not.toMatch(/scripts_dir/);
  });
});

describe("adopter caller templates", () => {
  for (const name of ["pr", "push"] as const) {
    it(`scripts/templates/flywheel-${name}.yml invokes the composite with __FLYWHEEL_VERSION__ and no reusable-workflow plumbing`, () => {
      const content = readFile(`scripts/templates/flywheel-${name}.yml`);
      // Single, version-stamped `uses:` line — this is the surface
      // §spec:action-version-lockstep exists to deliver.
      expect(content).toMatch(/uses:\s*point-source\/flywheel@__FLYWHEEL_VERSION__/);
      expect(content).toMatch(/app-id:\s*\$\{\{\s*vars\.FLYWHEEL_GH_APP_ID\s*\}\}/);
      expect(content).toMatch(
        /app-private-key:\s*\$\{\{\s*secrets\.FLYWHEEL_GH_APP_PRIVATE_KEY\s*\}\}/,
      );
      // No reusable-workflow caller form: no `workflow_call` invocation,
      // no `flywheel-version` second-surface input, no
      // `point-source/flywheel/.github/workflows/...` ref.
      expect(content).not.toMatch(/point-source\/flywheel\/\.github\/workflows\//);
      expect(content).not.toMatch(/flywheel-version/);
    });
  }
});

describe("reusable workflow files are gone", () => {
  // The reusable workflows were retired with §road:composite-action-adoption —
  // they were the second version surface §spec:action-version-lockstep
  // exists to eliminate. Assert the files no longer exist so a revert
  // would fail loudly.
  for (const file of [".github/workflows/pr.yml", ".github/workflows/push.yml"]) {
    it(`${file} no longer exists`, () => {
      expect(existsSync(join(repoRoot, file))).toBe(false);
    });
  }
});

describe("dogfood workflows invoke the composite directly", () => {
  // Dogfood workflows pin `./` (the local action source on the runner)
  // so PRs exercise the composite under review on every event. Any drift
  // toward an external `uses:` ref would mean PRs no longer test the
  // SHA under review.
  for (const file of [
    ".github/workflows/flywheel-pr.yml",
    ".github/workflows/flywheel-push.yml",
  ]) {
    it(`${file} invokes the composite via ./ and not a reusable workflow`, () => {
      const content = readFile(file);
      expect(content).toMatch(/uses:\s*\.\//);
      expect(content).not.toMatch(/point-source\/flywheel\/\.github\/workflows\//);
      expect(content).not.toMatch(/scripts_dir/);
      // No external semantic-release / sanitize / back-merge steps in the
      // dogfood; the composite owns them now (it always did the adopter
      // path; the dogfood used to mirror the legacy reusable workflow's
      // external invocations).
      expect(content).not.toMatch(/run:\s*bash\s+scripts\//);
    });
  }
});
