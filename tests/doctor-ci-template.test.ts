import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import yaml from "js-yaml";

// Locks the opt-in contract for the doctor-ci workflow template
// (`scripts/templates/doctor-ci.yml`). See SPEC §spec:doctor-ci-workflow.
//
// Two invariants this template MUST hold, encoded here so they can't regress:
//
//   A. OPT-IN GUARD. §spec:doctor-ci-workflow makes the workflow strictly
//      opt-in: a maintainer copies it by hand. `init.sh` must NEVER fetch,
//      write, or otherwise reference it — its workflow-install loop only
//      handles `flywheel-pr.yml` and `flywheel-push.yml`. Auto-installing
//      doctor-ci would burn CI minutes on a manual diagnostic and violate the
//      opt-in constraint, so we lock the absence of any `doctor-ci` mention
//      in init.sh.
//
//   B. TEMPLATE SHAPE. The shipped template must honor the contract:
//      workflow_dispatch-only (never a push/PR/schedule gate), read-only
//      permissions, runs doctor by fetching scripts/doctor.sh with no positional
//      owner/repo arg (so on-disk checks run against the checkout), wires the
//      App-token credential path (`--skip-credentials`), and references the
//      documented credential inputs and the mint/checkout actions.
//
// These are pure file-read / string / parse assertions: NO network, NO `gh`,
// NO sandbox installation calls. They run in the cheap unit suite and so are
// trivially within the sandbox CI budget (§req:sandbox-ci-budget /
// §spec:sandbox-test-budget).

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function readRepoFile(relPath: string): string {
  return readFileSync(join(repoRoot, relPath), "utf8");
}

const TEMPLATE_PATH = "scripts/templates/doctor-ci.yml";

describe("doctor-ci opt-in guard (init.sh)", () => {
  // §spec:doctor-ci-workflow — the workflow is opt-in; init.sh must not
  // auto-install it. The install loop (init.sh ~L847) iterates only
  // `flywheel-pr.yml flywheel-push.yml`. Any reference to doctor-ci here would
  // mean init started shipping it automatically. Grepping for the bare
  // `doctor-ci` stem (rather than `doctor-ci.yml`) also catches a `.yaml`
  // rename, and targets the contract — absence of the filename — not init's
  // internal loop shape, so it won't break on a benign refactor.
  it("init.sh never fetches, writes, or references doctor-ci", () => {
    expect(readRepoFile("scripts/init.sh")).not.toContain("doctor-ci");
  });
});

describe("doctor-ci template shape", () => {
  // Read + parse the template once; every assertion below works off these.
  const raw = readRepoFile(TEMPLATE_PATH);
  const doc = yaml.load(raw) as Record<string, unknown>;

  it("exists on disk and parses as valid YAML", () => {
    expect(existsSync(join(repoRoot, TEMPLATE_PATH))).toBe(true);
    expect(doc).toBeTypeOf("object");
  });

  it("triggers on workflow_dispatch ONLY (no push / pull_request / schedule)", () => {
    // Asserted on the raw text rather than the parsed object: YAML 1.1 coerces
    // the bare key `on:` to the boolean key `true`, so a parsed-key lookup is
    // awkward and quirk-prone. Trigger presence/absence is a line-level fact,
    // and these anchored regexes lock it directly and durably.
    expect(raw).toMatch(/^\s*workflow_dispatch:/m);
    expect(raw).not.toMatch(/^\s*push:/m);
    expect(raw).not.toMatch(/^\s*pull_request:/m);
    expect(raw).not.toMatch(/^\s*schedule:/m);
  });

  it("declares read-only top-level permissions (contents: read)", () => {
    expect((doc as { permissions?: Record<string, string> }).permissions).toEqual({
      contents: "read",
    });
  });

  it("runs doctor by fetching scripts/doctor.sh in curl|bash -s -- form with NO positional owner/repo arg", () => {
    // doctor is fetched (the adopter repo doesn't vendor scripts/doctor.sh) and
    // run via the curl|bash form, forwarding only $flags.
    expect(raw).toMatch(/curl[^\n]*doctor\.sh|DOCTOR_URL[^\n]*doctor\.sh/);
    expect(raw).toMatch(/bash -s --/);
    const runLine = raw.split("\n").find((l) => l.includes("bash -s --"));
    expect(runLine).toBeDefined();
    // Flags only: the invocation forwards $flags, never a literal owner/repo
    // positional (which would force doctor into remote-only mode and skip the
    // on-disk checks). Guard against a hardcoded repo slug as a doctor arg.
    expect(runLine).toContain("$flags");
    expect(runLine).not.toMatch(/point-source\/\S+/);
  });

  it("passes --skip-credentials somewhere (the App-token path)", () => {
    expect(raw).toContain("--skip-credentials");
  });

  it("references the credential inputs (App ID, App private key, optional admin PAT)", () => {
    expect(raw).toContain("FLYWHEEL_GH_APP_ID");
    expect(raw).toContain("FLYWHEEL_GH_APP_PRIVATE_KEY");
    expect(raw).toContain("FLYWHEEL_ADMIN_PAT");
  });

  it("uses create-github-app-token (App-token mint) and actions/checkout", () => {
    expect(raw).toMatch(/actions\/create-github-app-token/);
    expect(raw).toMatch(/actions\/checkout/);
  });
});
