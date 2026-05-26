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
// The two files differ on a known set of lines:
//   - the workflow trigger block (reusable: `on: workflow_call:` with
//     inputs/secrets; dogfood: `on: pull_request:` / `on: push:`)
//   - the action-invocation shape: the reusable checks the action source
//     out into `_flywheel/` at the caller-supplied `flywheel-version` ref
//     before invoking it as `./_flywheel`; the dogfood uses `./` directly
//     against the calling repo's checkout. See SPEC
//     §spec:action-version-lockstep and #183 for why the ref is a
//     caller-supplied input rather than runtime-resolved.
//
// Mismatch beyond that means the inline shell is drifting — catch it at
// PR time. PR #42 added @semantic-release/exec to the dogfood but not
// the template, breaking semantic-release on develop; this test is the
// same kind of guard at a different file pair.

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
      //   - Reusable checks the action source out into `_flywheel/` at
      //     the caller-supplied `flywheel-version` ref; dogfood uses `./`
      //     directly against the calling repo's checkout.
      //   - Reusable reads app-id/secret from workflow_call inputs;
      //     dogfood reads them directly from repo Vars/Secrets.
      //   - Reusable carries an explanatory comment on the action-source
      //     checkout that the dogfood doesn't need.
      const rNormalized = r
        // Strip the comment block explaining the action-source checkout.
        .replace(
          /^\s*# Check the Flywheel action source out[\s\S]*?§spec:action-version-lockstep\.\n/m,
          "",
        )
        // Strip the secondary checkout step that pulls the action into
        // _flywheel/ at the caller-supplied ref.
        .replace(
          /^\s*- uses: actions\/checkout@v6\n\s*with:\n\s*repository: point-source\/flywheel\n\s*ref: \$\{\{ inputs\.flywheel-version \}\}\n\s*path: _flywheel\n/m,
          "",
        )
        // Reusable invokes the local action via the secondary checkout path;
        // dogfood invokes it against the primary checkout.
        .replace(/uses:\s*\.\/_flywheel/g, "uses: ./")
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
      // The caller must pass `flywheel-version` so the reusable workflow
      // checks the action source out at the same ref the caller pinned
      // the workflow at. init.sh stamps __FLYWHEEL_VERSION__ in both
      // places from --version. See SPEC §spec:action-version-lockstep.
      expect(content).toMatch(/flywheel-version:\s*__FLYWHEEL_VERSION__/);
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
      // The action source ref is a caller-supplied `flywheel-version`
      // input — optional, defaulting to the floating major `v1` so
      // callers that omit it keep working. The reusable workflow checks
      // the action out at that ref; it does NOT derive its own ref from
      // `github.workflow_ref` (that holds the caller's ref, which is
      // absent from point-source/flywheel for non-default-branch
      // callers — #183). See SPEC §spec:action-version-lockstep.
      expect(content).toMatch(/flywheel-version:\s*\n[\s\S]*?required:\s*false/);
      expect(content).toMatch(/flywheel-version:[\s\S]*?default:\s*v1/);
      expect(content).not.toMatch(/GITHUB_WORKFLOW_REF/);
      expect(content).toMatch(/ref:\s*\$\{\{\s*inputs\.flywheel-version\s*\}\}/);
      expect(content).toMatch(/repository:\s*point-source\/flywheel/);
      expect(content).toMatch(/path:\s*_flywheel/);
      expect(content).toMatch(/uses:\s*\.\/_flywheel/);
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
  // action's output. These checks apply to the legacy v1 reusable
  // workflows and the dogfood workflows that still mirror them; the
  // v2 composite action invokes its scripts via `github.action_path`
  // directly (see "composite action shape" below) and is exercised
  // by the action-shape assertions.
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
});

describe("composite action shape (§spec:action-version-lockstep)", () => {
  // The root action.yml is a v2 composite action that checks the
  // adopter's repository out, invokes the dispatcher as a nested JS
  // action (`uses: ./core`), and — on push events — runs
  // semantic-release and the bundled release scripts. The composite
  // exists so the adopter's `@<ref>` pin governs every flywheel file
  // that runs (dispatcher, scripts/, semantic-release plugin set);
  // dropping `scripts_dir` is the visible signal of that lockstep
  // because the scripts are no longer addressed through a runtime
  // output but through `github.action_path`. See SPEC
  // §spec:action-version-lockstep.

  it("root action.yml is a composite action with no scripts_dir output", () => {
    const content = readFile("action.yml");
    expect(content).toMatch(/runs:\s*\n\s*using:\s*composite/);
    // scripts_dir was the workaround for the reusable-workflow layer
    // not being able to name its own ref. The composite addresses
    // scripts via github.action_path, so the output is gone.
    expect(content).not.toMatch(/^\s{2}scripts_dir:/m);
    expect(content).not.toMatch(/scripts_dir/);
  });

  it("root action.yml invokes the nested dispatcher via ./core and forwards its outputs", () => {
    const content = readFile("action.yml");
    // The dispatcher step must be addressed as `./core` (resolved
    // against this action's own checkout at the pinned ref) and
    // carry an `id:` so the composite can forward its outputs.
    expect(content).toMatch(/uses:\s*\.\/core/);
    expect(content).toMatch(/id:\s*core/);
    // Every output the legacy node24 action exposed must be forwarded
    // from the nested core action so callers see no surface change.
    for (const name of ["token", "managed_branch", "back_merge_targets"]) {
      expect(content).toMatch(
        new RegExp(`\\n\\s{2}${name}:[\\s\\S]*?value:\\s*\\$\\{\\{\\s*steps\\.core\\.outputs\\.${name}\\s*\\}\\}`),
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
      expect(line).not.toContain("scripts_dir");
      expect(line).not.toMatch(/run:\s*bash\s+scripts\//);
    }
  });

  it("core/action.yml is the JS dispatcher (node24, dist/index.cjs) and declares the dispatcher outputs", () => {
    const content = readFile("core/action.yml");
    expect(content).toMatch(/runs:\s*\n\s*using:\s*node24/);
    expect(content).toMatch(/main:\s*dist\/index\.cjs/);
    // The dispatcher emits these for the root composite to forward.
    for (const name of ["token", "managed_branch", "back_merge_targets"]) {
      expect(content).toMatch(new RegExp(`\\n\\s{2}${name}:\\s*\\n\\s{4}description:`));
    }
    // scripts_dir was dropped at the same time the composite landed —
    // the dispatcher no longer needs to point release steps at an
    // absolute path because the composite uses github.action_path.
    expect(content).not.toMatch(/scripts_dir/);
  });
});
