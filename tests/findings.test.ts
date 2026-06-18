import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { stripAnsi } from "./helpers/ansi.js";

// Unit coverage for scripts/lib/findings.sh — the shared pre-flight finding
// vocabulary lib (SPEC.md §spec:preflight-classification). The lib is
// sourceable (no shebang, defines functions only); we exercise it by sourcing
// it inside a small bash harness and inspecting stdout / stderr / exit code.
//
// findings.sh emits one line per finding with a severity glyph and a literal
// `[<bucket>]` label, validates bucket ∈ {local-env,instance,config} and
// severity ∈ {block,warn,info}, increments FINDINGS_BLOCK_COUNT only on
// `block`, and exposes findings_exit_code (1 if any block, else 0). Invalid
// input prints to stderr and returns 1 (never exits, never counts).

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const libPath = join(repoRoot, "scripts/lib/findings.sh");

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Source findings.sh, then run the supplied bash snippet. The snippet sees
 * `finding`, `findings_exit_code`, and the FINDINGS_BLOCK_COUNT global. */
function runWithLib(snippet: string): RunResult {
  const script = `set -uo pipefail\n. "${libPath}"\n${snippet}\n`;
  const r = spawnSync("bash", ["-c", script], { encoding: "utf8" });
  return { exitCode: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}


describe("findings.sh — severity mappings", () => {
  it("block, warn, and info each render a distinct line with a distinct glyph", () => {
    const r = runWithLib(
      [
        'finding config block "blocked thing"',
        'finding config warn "warned thing"',
        'finding config info "noted thing"',
      ].join("\n"),
    );
    expect(r.exitCode, r.stderr).toBe(0);
    const lines = r.stdout.split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);

    // Raw output carries the per-severity color/glyph escapes; the three
    // glyphs are visually distinct (red ✗ / yellow ! / cyan i).
    expect(r.stdout).toContain("✗"); // ✗ block
    expect(r.stdout).toContain("!"); // warn
    expect(r.stdout).toMatch(/\x1b\[36mi\x1b\[0m/); // cyan i info

    // Plain text still distinguishes the messages.
    const plain = stripAnsi(r.stdout);
    expect(plain).toContain("blocked thing");
    expect(plain).toContain("warned thing");
    expect(plain).toContain("noted thing");
  });

  it("only `block` increments FINDINGS_BLOCK_COUNT / drives findings_exit_code to 1", () => {
    // warn + info alone → counter stays 0, exit code helper prints 0.
    const nonBlock = runWithLib(
      [
        'finding config warn "w"',
        'finding instance info "i"',
        'echo "COUNT=$FINDINGS_BLOCK_COUNT"',
        'echo "EXIT=$(findings_exit_code)"',
      ].join("\n"),
    );
    expect(nonBlock.exitCode, nonBlock.stderr).toBe(0);
    expect(stripAnsi(nonBlock.stdout)).toContain("COUNT=0");
    expect(stripAnsi(nonBlock.stdout)).toContain("EXIT=0");

    // A single block → counter goes to 1, exit code helper prints 1.
    const withBlock = runWithLib(
      [
        'finding config warn "w"',
        'finding local-env block "b"',
        'echo "COUNT=$FINDINGS_BLOCK_COUNT"',
        'echo "EXIT=$(findings_exit_code)"',
      ].join("\n"),
    );
    expect(withBlock.exitCode, withBlock.stderr).toBe(0);
    expect(stripAnsi(withBlock.stdout)).toContain("COUNT=1");
    expect(stripAnsi(withBlock.stdout)).toContain("EXIT=1");
  });
});

describe("findings.sh — canonical (bucket, severity) examples", () => {
  it("local-env block renders a [local-env] label", () => {
    const r = runWithLib('finding local-env block "gh not authenticated"');
    expect(r.exitCode, r.stderr).toBe(0);
    const plain = stripAnsi(r.stdout);
    expect(plain).toContain("[local-env]");
    expect(plain).toContain("gh not authenticated");
  });

  it("instance block renders an [instance] label", () => {
    const r = runWithLib('finding instance block "repo already runs release-please"');
    expect(r.exitCode, r.stderr).toBe(0);
    const plain = stripAnsi(r.stdout);
    expect(plain).toContain("[instance]");
    expect(plain).toContain("repo already runs release-please");
  });

  it("config warn renders a [config] label", () => {
    const r = runWithLib('finding config warn "allow_auto_merge disabled"');
    expect(r.exitCode, r.stderr).toBe(0);
    const plain = stripAnsi(r.stdout);
    expect(plain).toContain("[config]");
    expect(plain).toContain("allow_auto_merge disabled");
  });
});

describe("findings.sh — block counter / exit-code helper", () => {
  it("findings_exit_code prints 0 with zero blocks", () => {
    const r = runWithLib("findings_exit_code");
    expect(r.exitCode, r.stderr).toBe(0);
    expect(stripAnsi(r.stdout).trim()).toBe("0");
  });

  it("findings_exit_code prints 1 after one or more blocks", () => {
    const r = runWithLib(
      [
        'finding instance block "b1"',
        'finding config block "b2"',
        'echo "COUNT=$FINDINGS_BLOCK_COUNT"',
        "findings_exit_code",
      ].join("\n"),
    );
    expect(r.exitCode, r.stderr).toBe(0);
    const plain = stripAnsi(r.stdout);
    expect(plain).toContain("COUNT=2");
    // Last line is the helper's output.
    const lines = plain.split("\n").filter(Boolean);
    expect(lines[lines.length - 1]).toBe("1");
  });
});

describe("findings.sh — format_finding (summary formatter)", () => {
  it("renders the same `[<bucket>]` + glyph line as finding", () => {
    // format_finding and finding must produce byte-identical output for the
    // same (bucket, severity, message) — WS4 renders summary labels with the
    // exact pre-flight style.
    const r = runWithLib(
      [
        'finding config warn "shared message"',
        'format_finding config warn "shared message"',
      ].join("\n"),
    );
    expect(r.exitCode, r.stderr).toBe(0);
    const lines = r.stdout.split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(lines[1]);

    const plain = stripAnsi(r.stdout);
    expect(plain).toContain("[config]");
    expect(plain).toContain("shared message");
  });

  it("renders each severity with its distinct glyph", () => {
    const r = runWithLib(
      [
        'format_finding instance block "blocked"',
        'format_finding config warn "warned"',
        'format_finding local-env info "noted"',
      ].join("\n"),
    );
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain("✗");
    expect(r.stdout).toContain("!");
    expect(r.stdout).toMatch(/\x1b\[36mi\x1b\[0m/);

    const plain = stripAnsi(r.stdout);
    expect(plain).toContain("[instance]");
    expect(plain).toContain("[config]");
    expect(plain).toContain("[local-env]");
  });

  it("does NOT mutate FINDINGS_BLOCK_COUNT, even for block severity", () => {
    const r = runWithLib(
      [
        'format_finding config block "b1"',
        'format_finding instance block "b2"',
        'echo "COUNT=$FINDINGS_BLOCK_COUNT"',
        'echo "EXIT=$(findings_exit_code)"',
      ].join("\n"),
    );
    expect(r.exitCode, r.stderr).toBe(0);
    const plain = stripAnsi(r.stdout);
    expect(plain).toContain("COUNT=0");
    expect(plain).toContain("EXIT=0");
  });

  it("an invalid bucket returns non-zero and prints to stderr", () => {
    const r = runWithLib(
      [
        "format_finding bogus block x; rc=$?",
        'echo "RC=$rc"',
      ].join("\n"),
    );
    const plain = stripAnsi(r.stdout);
    expect(plain).toContain("RC=1");
    expect(r.stderr).toContain("invalid bucket");
    expect(r.stderr).toContain("bogus");
  });

  it("an invalid severity returns non-zero and prints to stderr", () => {
    const r = runWithLib(
      [
        "format_finding config bogus x; rc=$?",
        'echo "RC=$rc"',
      ].join("\n"),
    );
    const plain = stripAnsi(r.stdout);
    expect(plain).toContain("RC=1");
    expect(r.stderr).toContain("invalid severity");
    expect(r.stderr).toContain("bogus");
  });
});

describe("findings.sh — findings_validation_headline", () => {
  it("0 0 renders a green all-checks-pass headline", () => {
    const r = runWithLib("findings_validation_headline 0 0");
    expect(r.exitCode, r.stderr).toBe(0);
    const plain = stripAnsi(r.stdout);
    expect(plain).toContain("Setup validation: all checks pass");
    expect(plain).not.toContain("blocking");
    // Uses the green ✓ style other green lines use.
    expect(r.stdout).toMatch(/\x1b\[32m✓\x1b\[0m/);
  });

  it("2 1 renders a red headline naming 2 blocking and 1 warning", () => {
    const r = runWithLib("findings_validation_headline 2 1");
    expect(r.exitCode, r.stderr).toBe(0);
    const plain = stripAnsi(r.stdout);
    expect(plain).toContain("2 blocking finding(s)");
    expect(plain).toContain("1 warning(s)");
    // Leads with the block glyph (red ✗) when anything blocks.
    expect(r.stdout).toContain("✗");
  });

  it("0 3 renders a warn-style headline with no 'blocking' lead", () => {
    const r = runWithLib("findings_validation_headline 0 3");
    expect(r.exitCode, r.stderr).toBe(0);
    const plain = stripAnsi(r.stdout);
    expect(plain).toContain("0 blocking finding(s)");
    expect(plain).toContain("3 warning(s)");
    // Only warnings → leads with the amber warn glyph, not the block ✗.
    expect(r.stdout).toMatch(/\x1b\[33m!\x1b\[0m/);
    expect(r.stdout).not.toContain("✗");
  });

  it("invalid (non-integer) input returns non-zero and writes to stderr", () => {
    const r = runWithLib(
      [
        "findings_validation_headline x 0; rc=$?",
        'echo "RC=$rc"',
      ].join("\n"),
    );
    const plain = stripAnsi(r.stdout);
    expect(plain).toContain("RC=1");
    expect(r.stderr).toContain("invalid blocks");
  });

  it("a negative warns arg is rejected (returns non-zero, writes to stderr)", () => {
    const r = runWithLib(
      [
        "findings_validation_headline 0 -1; rc=$?",
        'echo "RC=$rc"',
      ].join("\n"),
    );
    const plain = stripAnsi(r.stdout);
    expect(plain).toContain("RC=1");
    expect(r.stderr).toContain("invalid warns");
  });

  it("does NOT mutate FINDINGS_BLOCK_COUNT (pure renderer)", () => {
    const r = runWithLib(
      [
        "findings_validation_headline 5 5",
        'echo "COUNT=$FINDINGS_BLOCK_COUNT"',
      ].join("\n"),
    );
    expect(r.exitCode, r.stderr).toBe(0);
    expect(stripAnsi(r.stdout)).toContain("COUNT=0");
  });
});

describe("findings.sh — invalid input rejected", () => {
  it("an invalid bucket returns non-zero, prints to stderr, and does not count", () => {
    const r = runWithLib(
      [
        "finding bogus block x; rc=$?",
        'echo "RC=$rc"',
        'echo "COUNT=$FINDINGS_BLOCK_COUNT"',
      ].join("\n"),
    );
    // The harness as a whole exits 0 (we capture finding's rc explicitly).
    const plain = stripAnsi(r.stdout);
    expect(plain).toContain("RC=1");
    expect(plain).toContain("COUNT=0"); // invalid input never increments
    expect(r.stderr).toContain("invalid bucket");
    expect(r.stderr).toContain("bogus");
  });

  it("an invalid severity returns non-zero, prints to stderr, and does not count", () => {
    const r = runWithLib(
      [
        "finding config bogus x; rc=$?",
        'echo "RC=$rc"',
        'echo "COUNT=$FINDINGS_BLOCK_COUNT"',
      ].join("\n"),
    );
    const plain = stripAnsi(r.stdout);
    expect(plain).toContain("RC=1");
    expect(plain).toContain("COUNT=0");
    expect(r.stderr).toContain("invalid severity");
    expect(r.stderr).toContain("bogus");
  });

  it("invalid input returns 1 but does NOT exit the sourcing shell", () => {
    // `return 1` (not `exit`) means a subsequent command still runs.
    const r = runWithLib(
      [
        "finding bogus block x || true",
        'echo "STILL-ALIVE"',
      ].join("\n"),
    );
    expect(r.exitCode, r.stderr).toBe(0);
    expect(stripAnsi(r.stdout)).toContain("STILL-ALIVE");
  });
});
