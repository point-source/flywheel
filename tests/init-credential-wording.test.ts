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
  // #236 (§spec:init-app-step) replaced the "...for installation tokens" framing
  // with need-before-mechanism copy, so the menu now anchors on "Pick a setup
  // path:". The Variable/Secret labels from §spec:init-credentials-prompt are
  // preserved on options 2/3.
  const setupMenu = sliceBetween(
    initSh,
    "Pick a setup path:",
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
