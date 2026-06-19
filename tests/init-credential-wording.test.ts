import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// WS1 reworded scripts/init.sh's credential prompts so both values are
// named as the Flywheel GitHub App's *shared* credentials, not a personal
// access token: FLYWHEEL_GH_APP_ID is the App's public numeric App ID
// (an Actions Variable) and FLYWHEEL_GH_APP_PRIVATE_KEY is its PEM private
// key (an Actions Secret).
//
// tests/init-rerun.test.ts pins the wording reachable at runtime — but the
// harness forces INTERACTIVE=0, so the interactive surfaces (the org scope
// prompt, the setup-path menu, and prompt_existing_app_credentials) never
// execute and can't be asserted on captured stdout. This file pins that
// wording by reading scripts/init.sh as text — mirroring the repo's
// content-pinning pattern (cf. tests/action-shape.test.ts, which pins
// template content rather than runtime behavior). Assertions key off
// stable substrings (the FLYWHEEL_GH_APP_ID / FLYWHEEL_GH_APP_PRIVATE_KEY
// names, the words "Variable"/"Secret", "visibility=all", "personal access
// token", "Settings → Secrets and variables → Actions") rather than whole
// lines, so trivial rewording elsewhere doesn't make the tests brittle.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const initSh = readFileSync(join(repoRoot, "scripts/init.sh"), "utf8");

// Carve the interactive scope-prompt block out of the script so assertions
// can't be satisfied by an identical-looking string elsewhere. The block
// runs only when the owner is an Organization and SCOPE is unresolved.
function sliceBetween(haystack: string, start: string, end: string): string {
  const i = haystack.indexOf(start);
  expect(i, `anchor not found: ${start}`).toBeGreaterThanOrEqual(0);
  const j = haystack.indexOf(end, i);
  expect(j, `end anchor not found: ${end}`).toBeGreaterThan(i);
  return haystack.slice(i, j);
}

describe("init.sh interactive scope-prompt credential wording", () => {
  const scopePrompt = sliceBetween(
    initSh,
    "Where should the Flywheel GitHub App's shared credentials live?",
    'read -r -u 3 -p "  Selection [1/2] (default 1): "',
  );

  it("frames the pair as the App's own identity, not a personal access token", () => {
    expect(scopePrompt).toContain("Flywheel GitHub App's shared credentials");
    expect(scopePrompt).toContain("App's own identity");
    expect(scopePrompt).toContain("not a personal access token");
  });

  it("names FLYWHEEL_GH_APP_ID as a Variable and FLYWHEEL_GH_APP_PRIVATE_KEY as a Secret", () => {
    expect(scopePrompt).toMatch(/FLYWHEEL_GH_APP_ID Variable/);
    expect(scopePrompt).toMatch(/FLYWHEEL_GH_APP_PRIVATE_KEY Secret/);
  });

  it("states what each scope writes — repo Variable+Secret vs org with visibility=all", () => {
    // Repo option: Variable + Secret on this repo.
    expect(scopePrompt).toContain("writes the Variable + Secret on this repo");
    // Org option: Variable + Secret on the org, shared across every repo,
    // via visibility=all.
    expect(scopePrompt).toContain("writes the Variable + Secret on the org");
    expect(scopePrompt).toContain("visibility=all");
    expect(scopePrompt).toContain("shared across every repo in the org");
  });
});

describe("init.sh interactive setup-path menu credential wording", () => {
  const setupMenu = sliceBetween(
    initSh,
    "Flywheel needs a GitHub App for installation tokens. Pick a setup path:",
    'read -r -u 3 -p "  Selection [1/2/3] (default 1): "',
  );

  it("labels the App ID as a Variable and the PEM private key as a Secret", () => {
    expect(setupMenu).toContain("App ID (Variable)");
    expect(setupMenu).toContain("PEM private key (Secret)");
  });
});

describe("init.sh prompt_existing_app_credentials credential wording", () => {
  // Isolate the function body so the assertions can't be satisfied by
  // matching strings elsewhere in the script.
  const fnBody = sliceBetween(
    initSh,
    "prompt_existing_app_credentials() {",
    "\nif [[ \"$SKIP_SECRETS\" -eq 1 ]]; then",
  );

  it("frames the credentials as the App's identity, not a personal access token", () => {
    expect(fnBody).toContain("Flywheel GitHub App's shared credentials");
    expect(fnBody).toContain("not a personal access token");
  });

  it("names the numeric App ID as the FLYWHEEL_GH_APP_ID Variable", () => {
    expect(fnBody).toMatch(/numeric App ID[\s\S]*FLYWHEEL_GH_APP_ID Variable/);
  });

  it("names the PEM private key as the FLYWHEEL_GH_APP_PRIVATE_KEY Secret", () => {
    expect(fnBody).toMatch(/PEM private key[\s\S]*FLYWHEEL_GH_APP_PRIVATE_KEY Secret/);
  });
});

// WS2 (#235-2) adds the "Detection state is surfaced, and only the gap is
// prompted" half of §spec:init-credentials-prompt. When the probe already
// found exactly one of the two values (App ID Variable OR private-key
// Secret), the interactive flow reports what's set + at which scope, names
// the gap, co-locates the missing value's scope with the present one, and
// prompts only for the gap via prompt_existing_app_credentials (the
// create/paste/skip menu is suppressed).
//
// This whole branch is interactive-only: it lives under the
// `else` arm reached only when INTERACTIVE=1. tests/init-rerun.test.ts runs
// init.sh with detached:true → no controlling tty → INTERACTIVE lands on 0,
// so the partial report strings / co-location / gap-only prompt are
// UNREACHABLE at runtime (exactly-one-present routes to the non-interactive
// manual-setup elif instead). As with the wording tests above, we pin this
// branch by reading scripts/init.sh as text and slicing the partial-state
// block, anchored on the `partial=1` / `partial" -eq 1` markers and the
// report strings so the assertions are specific to this branch and don't
// pass vacuously by matching look-alike text elsewhere.
describe("init.sh interactive partial-credential-state branch", () => {
  // Slice from the partial-state detection (`partial=0` setup) through the
  // end of the partial `if [[ "$partial" -eq 1 ]]` arm — i.e. up to the
  // `else` that opens the neither-present setup-path menu. This carves out
  // both the co-location default and the gap-only report+prompt, while
  // excluding the create/paste/skip menu so the suppression assertion is
  // meaningful.
  const partialBranch = sliceBetween(
    initSh,
    "partial=0",
    "Flywheel needs a GitHub App for installation tokens. Pick a setup path:",
  );

  it("reports the present App ID + scope and names the missing private key (App-ID-present case)", () => {
    expect(partialBranch).toContain(
      "FLYWHEEL_GH_APP_ID variable already set (${app_id_found_at}-level); the FLYWHEEL_GH_APP_PRIVATE_KEY secret is missing — prompting only for the private key, writing it at ${SCOPE}-level to co-locate with the App ID.",
    );
  });

  it("reports the present private key + scope and names the missing App ID (key-present case)", () => {
    expect(partialBranch).toContain(
      "FLYWHEEL_GH_APP_PRIVATE_KEY secret already set (${app_key_found_at}-level); the FLYWHEEL_GH_APP_ID variable is missing — prompting only for the App ID, writing it at ${SCOPE}-level to co-locate with the private key.",
    );
  });

  it("defaults the missing value's scope to the present value's found-at scope, gated on empty SCOPE", () => {
    // Co-location only fires when no explicit --scope was given.
    expect(partialBranch).toMatch(/if \[\[ -z "\$SCOPE" \]\]; then/);
    // App-ID-present → write the key at the App ID's scope.
    expect(partialBranch).toContain('SCOPE="$app_id_found_at"');
    // key-present → write the App ID at the key's scope.
    expect(partialBranch).toContain('SCOPE="$app_key_found_at"');
    // The default keys off has_app_id so the present value's scope wins.
    expect(partialBranch).toMatch(
      /if \[\[ "\$has_app_id" -eq 1 \]\]; then SCOPE="\$app_id_found_at"; else SCOPE="\$app_key_found_at"; fi/,
    );
  });

  it("prompts only for the gap via prompt_existing_app_credentials", () => {
    // The partial arm gathers the missing value through the existing
    // per-gap prompt helper, which guards each write on has_app_id==0 /
    // has_app_key==0. Match the bare invocation on its own line — a leading
    // anchor of newline + indentation immediately before the call name — so a
    // mere mention in a comment (e.g. "# ...prompt_existing_app_credentials
    // guards each write...") can't satisfy it. Deleting the real call now
    // fails this test.
    expect(partialBranch).toMatch(/\n[ \t]*prompt_existing_app_credentials[ \t]*\n/);
    // ...and it lives inside the `partial" -eq 1` arm, not the neither-present
    // branch (which the slice's end anchor already excludes).
    expect(partialBranch).toMatch(/partial" -eq 1/);
  });

  it("suppresses the create/paste/skip menu in the partial branch", () => {
    // The setup-path menu and the create-App-via-manifest path mint a NEW
    // App and write BOTH values, so they must not appear inside the partial
    // arm — they live only in the neither-present branch (excluded by the
    // slice's end anchor).
    expect(partialBranch).not.toContain("Pick a setup path:");
    expect(partialBranch).not.toContain("create_app_via_manifest");
    expect(partialBranch).not.toContain("Selection [1/2/3]");
  });
});
