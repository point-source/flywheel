import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { loadConfig } from "../src/config.js";

// Both the TS loader (src/config.ts, runs in the action) and the Python
// linter (scripts/lint-flywheel-config.py, runs via doctor.sh) validate
// .flywheel.yml. They previously drifted — this test asserts every
// fixture lands on the same verdict (pass vs. fail) in both validators.
// Wording is allowed to differ; agreement is what matters.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixturesDir = join(repoRoot, "test-fixtures");
const linterPath = join(repoRoot, "scripts", "lint-flywheel-config.py");

function tsValid(yamlText: string): boolean {
  return loadConfig(yamlText).errors.length === 0;
}

function pythonValid(fixturePath: string): boolean {
  const out = execFileSync("python3", [linterPath, fixturePath], {
    encoding: "utf8",
  });
  return !out.split("\n").some((line) => line.startsWith("RESULT FAIL"));
}

describe("config validator parity (TS vs. Python)", () => {
  const fixtures = readdirSync(fixturesDir).filter((f) => f.endsWith(".yml"));

  for (const fixture of fixtures) {
    it(`${fixture}: TS and Python agree`, () => {
      const fixturePath = join(fixturesDir, fixture);
      const yamlText = readFileSync(fixturePath, "utf8");
      const tsOk = tsValid(yamlText);
      const pyOk = pythonValid(fixturePath);
      expect({ fixture, tsOk, pyOk }).toEqual({ fixture, tsOk: pyOk, pyOk });
    });
  }
});
