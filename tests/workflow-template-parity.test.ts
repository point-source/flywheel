import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Since #84, the canonical inline shell (semantic-release invocation,
// @-mention sanitizer, back-merge loop, conduct's bot-edit `if:` guard)
// lives in two places that must stay in lockstep:
//
//   - .github/workflows/{pr,push}.yml — the reusable workflow that
//     adopters call via `point-source/flywheel/.github/workflows/X.yml@v<major>`
//   - .github/workflows/flywheel-{pr,push}.yml — this repo's dogfood
//     workflow that exercises the action via `uses: ./` directly
//
// We deliberately keep the dogfood inline (rather than calling the
// reusable workflow) so the action is exercised in CI on every PR.
// Calling the reusable workflow from dogfood would force the action ref
// to be hardcoded — `${{ inputs.X }}` in `uses:` fails GitHub's
// static-validation pass on push events.
//
// The two files should differ on exactly two lines:
//   - the workflow trigger block (reusable: `on: workflow_call:` with
//     inputs/secrets; dogfood: `on: pull_request:` / `on: push:`)
//   - the action `uses:` line (reusable: `point-source/flywheel@v1`;
//     dogfood: `./`)
//
// Mismatch beyond those means the inline shell is drifting — catch it
// at PR time. PR #42 added @semantic-release/exec to the dogfood but
// not the template, breaking semantic-release on develop; this test is
// the same kind of guard at a different file pair.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

interface Pair {
  reusable: string;
  dogfood: string;
}

const PAIRS: Pair[] = [
  {
    reusable: ".github/workflows/push.yml",
    dogfood: ".github/workflows/flywheel-push.yml",
  },
  {
    reusable: ".github/workflows/pr.yml",
    dogfood: ".github/workflows/flywheel-pr.yml",
  },
];

function readFile(relPath: string): string {
  return readFileSync(join(repoRoot, relPath), "utf8");
}

// Strip the `on:` block, `name:` header, top-level standalone comments,
// and blank-line padding — those legitimately differ between a reusable
// workflow and a top-level dogfood workflow. Returns the rest as a
// normalized string starting at the first job-affecting key.
function stripHeader(content: string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let inOnBlock = false;
  let seenJobAffectingKey = false;
  const jobAffectingKey = (line: string) =>
    /^(jobs|concurrency|env|defaults|permissions):\s*$/.test(line);
  for (const line of lines) {
    if (line.startsWith("name:")) continue;
    if (line.startsWith("on:")) {
      inOnBlock = true;
      continue;
    }
    if (inOnBlock) {
      if (/^[a-zA-Z]/.test(line)) {
        inOnBlock = false;
      } else {
        continue;
      }
    }
    if (!seenJobAffectingKey) {
      // Skip top-level comments + blanks before the first
      // job-affecting key (`concurrency:`, `jobs:`, `env:`, etc.) —
      // these are file-level annotations that legitimately differ.
      if (/^\s*#/.test(line) || line.trim() === "") continue;
      if (jobAffectingKey(line)) seenJobAffectingKey = true;
    }
    out.push(line);
  }
  // Collapse any run of blank lines down to a single blank to absorb
  // formatting differences inside the body.
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

describe("reusable workflow / dogfood inline-shell parity", () => {
  for (const { reusable, dogfood } of PAIRS) {
    it(`${reusable} ↔ ${dogfood}: inline shell matches modulo the action ref + input plumbing`, () => {
      const r = stripHeader(readFile(reusable));
      const d = stripHeader(readFile(dogfood));

      // Normalize the legitimate differences between a reusable workflow
      // and a top-level dogfood workflow:
      //   - Reusable uses `point-source/flywheel@v1`; dogfood uses `./`
      //     (local checkout — exercises in-PR action code).
      //   - Reusable reads app-id/secret from workflow_call inputs;
      //     dogfood reads them directly from repo Vars/Secrets.
      //   - Reusable carries an explanatory comment on the action-ref
      //     pin that the dogfood doesn't need.
      const rNormalized = r
        .replace(/^\s*# Pinned to the same major[\s\S]*?override knob\.\n/m, "")
        .replace(/uses:\s*point-source\/flywheel@v1/g, "uses: ./")
        .replace(/\$\{\{\s*inputs\.app-id\s*\}\}/g, "${{ vars.FLYWHEEL_GH_APP_ID }}")
        .replace(
          /\$\{\{\s*secrets\.app-private-key\s*\}\}/g,
          "${{ secrets.FLYWHEEL_GH_APP_PRIVATE_KEY }}",
        );

      expect(d).toBe(rNormalized);
    });
  }
});

describe("adopter caller templates", () => {
  for (const name of ["pr", "push"] as const) {
    it(`scripts/templates/flywheel-${name}.yml calls the reusable workflow with __FLYWHEEL_VERSION__`, () => {
      const content = readFile(`scripts/templates/flywheel-${name}.yml`);
      expect(content).toMatch(
        new RegExp(
          `uses:\\s*point-source/flywheel/\\.github/workflows/${name}\\.yml@__FLYWHEEL_VERSION__`,
        ),
      );
      expect(content).toMatch(/app-id:\s*\$\{\{\s*vars\.FLYWHEEL_GH_APP_ID\s*\}\}/);
      expect(content).toMatch(
        /app-private-key:\s*\$\{\{\s*secrets\.FLYWHEEL_GH_APP_PRIVATE_KEY\s*\}\}/,
      );
    });
  }
});

describe("reusable workflow surface", () => {
  for (const name of ["pr", "push"] as const) {
    it(`.github/workflows/${name}.yml is a reusable workflow with the documented inputs/secrets`, () => {
      const content = readFile(`.github/workflows/${name}.yml`);
      expect(content).toMatch(/^on:\s*\n\s*workflow_call:/m);
      expect(content).toMatch(/inputs:\s*\n[\s\S]*?app-id:/);
      expect(content).toMatch(/secrets:\s*\n[\s\S]*?app-private-key:/);
      // Action ref pinned to the same major as the reusable workflow's
      // own @v<major> ref. Hardcoded — expressions in `uses:` referencing
      // inputs fail GitHub's static validator (see PR #111 commit msg).
      expect(content).toMatch(/uses:\s*point-source\/flywheel@v1/);
    });
  }
});

describe("reusable push workflow script invocation", () => {
  // #134: push.yml's release flow shells out to back-merge.sh and
  // sanitize-release-mentions.sh, but the working directory at that
  // point is the *adopter's* checkout (because the reusable workflow
  // ran `actions/checkout` against the caller). A bare `bash
  // scripts/<name>.sh` was therefore looking for files that exist only
  // in this repo and exited 127 on every adopter release — silently
  // breaking back-merge and stalling promotions. Both workflows must
  // now invoke the scripts through the action's `scripts_dir` output
  // (an absolute path to flywheel/scripts/ on the runner).
  //
  // Guard against the bare-relative form coming back. Match `.sh`
  // invocations and require each to be interpolated through the
  // action's output.
  for (const file of [".github/workflows/push.yml", ".github/workflows/flywheel-push.yml"]) {
    it(`${file} invokes every flywheel script through steps.flywheel.outputs.scripts_dir`, () => {
      const content = readFile(file);
      // Find every `run:` line that ends in a .sh invocation.
      const runShLines = content
        .split("\n")
        .filter((line) => /^\s*run:\s*.*\.sh\b/.test(line));
      expect(runShLines.length).toBeGreaterThan(0);
      for (const line of runShLines) {
        // Must reference the absolute path via the action output, never
        // a bare `bash scripts/<name>.sh` (which depends on the
        // caller's checkout layout).
        expect(line).toContain("steps.flywheel.outputs.scripts_dir");
        expect(line).not.toMatch(/run:\s*bash\s+scripts\//);
      }
    });
  }

  it("action.yml declares scripts_dir as an output so the workflow can consume it", () => {
    const content = readFile("action.yml");
    // The output block is YAML key `scripts_dir:` under `outputs:`.
    expect(content).toMatch(/outputs:[\s\S]*?\n\s{2}scripts_dir:\s*\n\s{4}description:/);
  });
});
