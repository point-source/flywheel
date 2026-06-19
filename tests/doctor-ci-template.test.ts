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
//      opt-in constraint, so we lock the absence of any `doctor-ci.yml` mention
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
  // `flywheel-pr.yml flywheel-push.yml`. Any reference to doctor-ci.yml here
  // would mean init started shipping it automatically.
  it("init.sh never fetches, writes, or references doctor-ci.yml", () => {
    const initSh = readRepoFile("scripts/init.sh");
    expect(initSh).not.toContain("doctor-ci.yml");
    expect(initSh).not.toContain("doctor-ci");
  });
});

describe("doctor-ci template shape", () => {
  it("exists on disk", () => {
    expect(existsSync(join(repoRoot, TEMPLATE_PATH))).toBe(true);
  });

  it("parses as valid YAML", () => {
    const raw = readRepoFile(TEMPLATE_PATH);
    expect(() => yaml.load(raw)).not.toThrow();
    expect(yaml.load(raw)).toBeTypeOf("object");
  });

  it("triggers on workflow_dispatch ONLY (no push / pull_request / schedule)", () => {
    const raw = readRepoFile(TEMPLATE_PATH);
    const doc = yaml.load(raw) as Record<string, unknown>;

    // YAML 1.1 coerces the bare key `on:` to the boolean key `true`. Resolve the
    // trigger block from either spelling so this assertion is robust to the quirk.
    const onBlock = (doc["on"] ?? (doc as Record<string, unknown>)[
      String(true)
    ] ?? (doc as Record<string, unknown>)["true"]) as
      | Record<string, unknown>
      | string
      | null
      | undefined;

    // The trigger must contain workflow_dispatch. Depending on how the empty
    // mapping under `workflow_dispatch:` parses, `onBlock` may be an object
    // keyed by the event names; assert workflow_dispatch is present.
    const onKeys =
      onBlock && typeof onBlock === "object"
        ? Object.keys(onBlock as Record<string, unknown>)
        : typeof onBlock === "string"
          ? [onBlock]
          : [];
    expect(onKeys).toContain("workflow_dispatch");
    expect(onKeys).not.toContain("push");
    expect(onKeys).not.toContain("pull_request");
    expect(onKeys).not.toContain("schedule");

    // Belt-and-suspenders on the raw text: forbid the gate triggers appearing as
    // trigger keys regardless of how YAML coerced the `on:` key.
    expect(raw).toMatch(/^\s*workflow_dispatch:/m);
    expect(raw).not.toMatch(/^\s*push:/m);
    expect(raw).not.toMatch(/^\s*pull_request:/m);
    expect(raw).not.toMatch(/^\s*schedule:/m);
  });

  it("declares read-only top-level permissions (contents: read)", () => {
    const doc = yaml.load(readRepoFile(TEMPLATE_PATH)) as {
      permissions?: Record<string, string>;
    };
    expect(doc.permissions).toBeDefined();
    expect(doc.permissions).toEqual({ contents: "read" });
  });

  it("invokes doctor by fetching scripts/doctor.sh", () => {
    const raw = readRepoFile(TEMPLATE_PATH);
    expect(raw).toContain("doctor.sh");
    // The curl|bash form is how doctor is fetched-and-run.
    expect(raw).toMatch(/curl[^\n]*doctor\.sh|DOCTOR_URL[^\n]*doctor\.sh/);
  });

  it("passes --skip-credentials somewhere (the App-token path)", () => {
    const raw = readRepoFile(TEMPLATE_PATH);
    expect(raw).toContain("--skip-credentials");
  });

  it("runs doctor in curl|bash -s -- form with NO positional owner/repo arg", () => {
    const raw = readRepoFile(TEMPLATE_PATH);
    // The doctor run uses the fetch-and-pipe form, passing only flags.
    expect(raw).toMatch(/bash -s --/);
    const runLine = raw
      .split("\n")
      .find((l) => l.includes("bash -s --"));
    expect(runLine).toBeDefined();
    // Flags only: the invocation forwards $flags, never a literal owner/repo
    // positional (which would force doctor into remote-only mode and skip the
    // on-disk checks). Guard against a hardcoded repo slug as a doctor arg.
    expect(runLine).toContain("$flags");
    expect(runLine).not.toMatch(/point-source\/\S+/);
  });

  it("references the credential inputs (App ID, App private key, optional admin PAT)", () => {
    const raw = readRepoFile(TEMPLATE_PATH);
    expect(raw).toContain("FLYWHEEL_GH_APP_ID");
    expect(raw).toContain("FLYWHEEL_GH_APP_PRIVATE_KEY");
    expect(raw).toContain("FLYWHEEL_ADMIN_PAT");
  });

  it("uses create-github-app-token (App-token mint) and actions/checkout", () => {
    const raw = readRepoFile(TEMPLATE_PATH);
    expect(raw).toMatch(/actions\/create-github-app-token/);
    expect(raw).toMatch(/actions\/checkout/);
  });
});
