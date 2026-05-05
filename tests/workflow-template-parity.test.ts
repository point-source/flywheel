import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// scripts/templates/flywheel-{push,pr}.yml are the workflow files init
// installs into adopter repos. .github/workflows/flywheel-{push,pr}.yml are
// the dogfood instances this repo runs against itself. They must stay in
// lockstep — the only legitimate diff is the `uses:` line, where the
// template references `point-source/flywheel@__FLYWHEEL_VERSION__` (init.sh
// substitutes the real version) and the dogfood uses `./` (local checkout).
//
// PR #42 added @semantic-release/exec to the template's npx -p list but not
// the dogfood's, breaking semantic-release on develop. This test catches
// that class of drift at PR time.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const PAIRS: Array<{ template: string; dogfood: string }> = [
  {
    template: "scripts/templates/flywheel-push.yml",
    dogfood: ".github/workflows/flywheel-push.yml",
  },
  {
    template: "scripts/templates/flywheel-pr.yml",
    dogfood: ".github/workflows/flywheel-pr.yml",
  },
];

const TEMPLATE_USES = "      - uses: point-source/flywheel@__FLYWHEEL_VERSION__";
const DOGFOOD_USES = "      - uses: ./";

function readLines(relPath: string): string[] {
  return readFileSync(join(repoRoot, relPath), "utf8").split("\n");
}

describe("workflow template/dogfood parity", () => {
  for (const { template, dogfood } of PAIRS) {
    it(`${template} ↔ ${dogfood}: only differ on uses: line`, () => {
      const t = readLines(template);
      const d = readLines(dogfood);

      expect(d.length).toBe(t.length);

      const diffs: Array<{ line: number; template: string; dogfood: string }> = [];
      for (let i = 0; i < t.length; i++) {
        if (t[i] !== d[i]) {
          diffs.push({ line: i + 1, template: t[i]!, dogfood: d[i]! });
        }
      }

      expect(diffs).toHaveLength(1);
      expect(diffs[0]).toMatchObject({
        template: TEMPLATE_USES,
        dogfood: DOGFOOD_USES,
      });
    });
  }
});
