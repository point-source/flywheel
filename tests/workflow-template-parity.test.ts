import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Since #84, both the adopter-installed templates and this repo's dogfood
// callers are thin wrappers around reusable workflows under
// `.github/workflows/{pr,push}.yml` — the canonical inline shell lives
// there and there is only one copy. The two callers should differ on
// exactly two lines:
//   - the `uses:` line (template references the reusable workflow on a
//     pinned ref, dogfood references the same file via a local path)
//   - the `flywheel-ref:` line (template substitutes __FLYWHEEL_VERSION__,
//     dogfood passes ${{ github.sha }} so dogfood runs the action at the
//     PR's HEAD instead of the released floating major).
// Anything else diverging means the two callers are drifting in shape —
// catch it at PR time.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

interface Pair {
  template: string;
  dogfood: string;
  reusableName: "pr" | "push";
}

const PAIRS: Pair[] = [
  {
    template: "scripts/templates/flywheel-push.yml",
    dogfood: ".github/workflows/flywheel-push.yml",
    reusableName: "push",
  },
  {
    template: "scripts/templates/flywheel-pr.yml",
    dogfood: ".github/workflows/flywheel-pr.yml",
    reusableName: "pr",
  },
];

function readLines(relPath: string): string[] {
  return readFileSync(join(repoRoot, relPath), "utf8").split("\n");
}

describe("workflow template/dogfood parity", () => {
  for (const { template, dogfood, reusableName } of PAIRS) {
    it(`${template} ↔ ${dogfood}: only differ on uses + flywheel-ref`, () => {
      const t = readLines(template);
      const d = readLines(dogfood);

      expect(d.length).toBe(t.length);

      const diffs: Array<{ line: number; template: string; dogfood: string }> = [];
      for (let i = 0; i < t.length; i++) {
        if (t[i] !== d[i]) {
          diffs.push({ line: i + 1, template: t[i]!, dogfood: d[i]! });
        }
      }

      expect(diffs).toHaveLength(2);
      expect(diffs[0]).toMatchObject({
        template: `    uses: point-source/flywheel/.github/workflows/${reusableName}.yml@__FLYWHEEL_VERSION__`,
        dogfood: `    uses: ./.github/workflows/${reusableName}.yml`,
      });
      expect(diffs[1]).toMatchObject({
        template: "      flywheel-ref: __FLYWHEEL_VERSION__",
        dogfood: "      flywheel-ref: ${{ github.sha }}",
      });
    });
  }
});

describe("reusable workflow surface", () => {
  for (const name of ["pr", "push"] as const) {
    it(`.github/workflows/${name}.yml is a reusable workflow with the documented inputs/secrets`, () => {
      const content = readFileSync(
        join(repoRoot, ".github/workflows", `${name}.yml`),
        "utf8",
      );
      // Trigger.
      expect(content).toMatch(/^on:\s*\n\s*workflow_call:/m);
      // Inputs adopters set explicitly.
      expect(content).toMatch(/inputs:\s*\n[\s\S]*?app-id:/);
      expect(content).toMatch(/flywheel-ref:/);
      // Secret plumbing for the App private key.
      expect(content).toMatch(/secrets:\s*\n[\s\S]*?app-private-key:/);
      // Action ref uses the input override with a sane default. Adopters
      // never set it; sandbox/e2e tooling overrides for SHA-pinning.
      expect(content).toMatch(
        /uses:\s*point-source\/flywheel@\$\{\{\s*inputs\.flywheel-ref\s*\|\|\s*'v1'\s*\}\}/,
      );
    });
  }
});
