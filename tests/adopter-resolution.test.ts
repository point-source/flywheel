import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import yaml from "js-yaml";

// An external adopter pins `point-source/flywheel@<ref>` once; GitHub fetches
// flywheel into the runner's action cache and runs the composite from there.
// A `uses: ./…` reference inside a composite resolves against GITHUB_WORKSPACE
// — the adopter's repository, which contains none of flywheel's code — so the
// v2.0.0 dispatcher written as `uses: ./core` failed for every adopter with
// `Can't find 'action.yml'… /core`. flywheel-shipped files must therefore be
// addressed via `${{ github.action_path }}`, the absolute path to the action's
// own checkout. These assertions encode that resolution rule so the bug class
// cannot reach a built release again, and they run in the cheap unit suite —
// no e2e sandbox load. See SPEC §spec:adopter-resolution-test and
// §spec:composite-self-reference.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function readFile(relPath: string): string {
  return readFileSync(join(repoRoot, relPath), "utf8");
}

type Step = {
  uses?: string;
  run?: string;
  id?: string;
  name?: string;
  env?: Record<string, string>;
};

function steps(relPath: string): Step[] {
  const doc = yaml.load(readFile(relPath)) as {
    runs?: { using?: string; steps?: Step[] };
  };
  return doc.runs?.steps ?? [];
}

// Every composite action manifest flywheel ships. Workflow files under
// .github/workflows/ are deliberately excluded: flywheel's own dogfood
// workflows consume the local action with `uses: ./` and `uses: ./classify`,
// which is correct there because the workspace *is* flywheel — the rule is
// about the action's own self-references, not how flywheel consumes itself.
const COMPOSITE_MANIFESTS = ["action.yml", "classify/action.yml"] as const;

// A run: line references one of flywheel's own shipped files when it names the
// bundled dispatcher or a release script. Such a reference must resolve
// through github.action_path, never the workspace.
const FLYWHEEL_FILE = /core\/dist\/index\.cjs|scripts\/[^\s"']+\.sh/;

describe("adopter resolution rule (§spec:composite-self-reference)", () => {
  for (const manifest of COMPOSITE_MANIFESTS) {
    describe(manifest, () => {
      it("is a composite action", () => {
        const doc = yaml.load(readFile(manifest)) as {
          runs?: { using?: string };
        };
        expect(doc.runs?.using).toBe("composite");
      });

      it("no step references flywheel's own code via `uses: ./…`", () => {
        for (const step of steps(manifest)) {
          if (step.uses) {
            expect(
              step.uses.startsWith("./"),
              `step "${step.name ?? step.id ?? step.uses}" uses a workspace-relative local action "${step.uses}"; flywheel code must be addressed via github.action_path`,
            ).toBe(false);
          }
        }
      });

      it("every flywheel-shipped file is addressed through github.action_path", () => {
        for (const step of steps(manifest)) {
          if (step.run && FLYWHEEL_FILE.test(step.run)) {
            expect(
              step.run,
              `step "${step.name ?? step.id ?? "<run>"}" references a flywheel file without github.action_path`,
            ).toContain("github.action_path");
          }
        }
      });
    });
  }

  it("the root composite never reintroduces the `uses: ./core` dispatcher", () => {
    expect(readFile("action.yml")).not.toMatch(/uses:\s*\.\/core\b/);
  });

  it("the root composite dispatches the bundled node entrypoint via github.action_path", () => {
    const dispatch = steps("action.yml").find((s) => s.id === "core");
    expect(dispatch, "no step with id: core in action.yml").toBeDefined();
    expect(dispatch?.run ?? "").toMatch(
      /node\s+["']?\$\{\{\s*github\.action_path\s*\}\}\/core\/dist\/index\.cjs/,
    );
  });

  it("the dispatcher forwards inputs as INPUT_* env so @actions/core getInput resolves them", () => {
    const dispatch = steps("action.yml").find((s) => s.id === "core");
    const env = dispatch?.env ?? {};
    expect(Object.keys(env)).toEqual(
      expect.arrayContaining([
        "INPUT_EVENT",
        "INPUT_APP-ID",
        "INPUT_APP-PRIVATE-KEY",
      ]),
    );
  });

  it("every release script step resolves through github.action_path (full release cycle)", () => {
    const shellSteps = steps("action.yml").filter(
      (s) => s.run && /scripts\/[^\s"']+\.sh/.test(s.run),
    );
    expect(shellSteps.length).toBeGreaterThan(0);
    for (const step of shellSteps) {
      expect(step.run).toContain("github.action_path");
    }
  });
});

describe("single-ref lockstep surface (§spec:action-version-lockstep)", () => {
  it("root action.yml is composite with no scripts_dir output", () => {
    const content = readFile("action.yml");
    expect(content).toMatch(/runs:\s*\n\s*using:\s*composite/);
    expect(content).not.toMatch(/scripts_dir/);
  });

  it("root action.yml forwards the dispatcher outputs from steps.core", () => {
    const content = readFile("action.yml");
    for (const name of ["token", "managed_branch", "back_merge_targets"]) {
      expect(content).toMatch(
        new RegExp(
          `\\n\\s{2}${name}:[\\s\\S]*?value:\\s*\\$\\{\\{\\s*steps\\.core\\.outputs\\.${name}\\s*\\}\\}`,
        ),
      );
    }
  });

  it("core/action.yml documents the node dispatcher (node24, dist/index.cjs)", () => {
    const content = readFile("core/action.yml");
    expect(content).toMatch(/runs:\s*\n\s*using:\s*node24/);
    expect(content).toMatch(/main:\s*dist\/index\.cjs/);
    expect(content).not.toMatch(/scripts_dir/);
  });

  for (const name of ["pr", "push"] as const) {
    it(`scripts/templates/flywheel-${name}.yml pins one version-stamped ref`, () => {
      const content = readFile(`scripts/templates/flywheel-${name}.yml`);
      expect(content).toMatch(
        /uses:\s*point-source\/flywheel@__FLYWHEEL_VERSION__/,
      );
      expect(content).not.toMatch(/point-source\/flywheel\/\.github\/workflows\//);
      expect(content).not.toMatch(/flywheel-version/);
    });
  }

  for (const file of [".github/workflows/pr.yml", ".github/workflows/push.yml"]) {
    it(`${file} (reusable workflow) no longer exists`, () => {
      expect(existsSync(join(repoRoot, file))).toBe(false);
    });
  }

  for (const file of [
    ".github/workflows/flywheel-pr.yml",
    ".github/workflows/flywheel-push.yml",
  ]) {
    it(`${file} dogfoods the composite via ./ (not a reusable workflow)`, () => {
      const content = readFile(file);
      expect(content).toMatch(/uses:\s*\.\//);
      expect(content).not.toMatch(/point-source\/flywheel\/\.github\/workflows\//);
    });
  }
});
