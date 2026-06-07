import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// End-to-end exercise of scripts/publish-draft-release.sh — the final
// step of release-gate.yml. The script lists the repository's releases
// via the draft-visible LIST endpoint (GET /repos/{owner}/{repo}/releases),
// jq-selects the element whose .tag_name matches TAG_NAME, refuses if the
// target_commitish drifted from the SHA the gate ran e2e against, and on
// a match flips the release from draft to public via
// PATCH /repos/{owner}/{repo}/releases/{id}.
//
// Why the LIST endpoint, not the tags endpoint: the per-tag releases
// endpoint (/repos/.../releases/tags/{tag}) only returns *published*
// releases — it 404s on a draft. Because release-gate cuts the release
// as a draft on purpose (the draft window is what the gate runs e2e
// against), a tags-endpoint lookup 404'd on every gated release and
// silently stranded it as an unpublished draft (the v1.4.0–v1.6.0
// shape). The LIST endpoint is draft-visible, so it is the only lookup
// that can see what this script must publish.
//
// Loud-failure contract: a lookup that *errors* (gh api exits non-zero,
// or returns an unparseable body) is NOT "nothing to publish" — it is a
// hard failure (`::error::`, non-zero exit, no PATCH). Only an actual
// parseable array that contains no matching tag is the benign no-op.
// Modelling the error case faithfully matters: in production a missing
// lookup returns a NON-EMPTY error body on stdout alongside the
// non-zero exit, which is the exact shape that stranded releases — a
// test that stubs an empty body for the miss does not exercise it.
//
// This script gates whether a release reaches every adopter pinned to
// @v1 on their next CI run. Per the project's "no critical code is
// too small to test" rule, the logic that decides publish vs. refuse
// must have unit tests covering each branch — a bug here either lets
// a red SHA through (silent regression for adopters) or strands a
// green release as an unpublished draft (visible but blocks
// promotion). Both modes were the motivation for extracting the
// publish step into a script in the first place.
//
// gh is stubbed via PATH shadowing — the test sets argv expectations
// and canned JSON responses, then asserts on what arguments the
// script passed to the API.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = join(repoRoot, "scripts/publish-draft-release.sh");

interface GhStub {
  binDir: string;
  callsLog: string;
  cleanup: () => void;
}

/** PATH-shadowing `gh` stub. argv is recorded one record per call,
 * NUL-terminated so newlines inside an argument don't split the record;
 * within a record args are TAB-separated. Canned responses model the
 * draft-visible LIST endpoint: `releases-response.json` (the JSON ARRAY
 * of release objects returned for `gh api /repos/.../releases`) and
 * `releases-response.status` (the gh exit code for that list lookup,
 * used to simulate an API error). The PATCH call defaults to success and
 * no output; `patchExit` overrides its exit code to simulate a publish
 * API error. The script doesn't read the PATCH output. */
function setupGhStub(opts: {
  releasesResponseJson?: string;
  listLookupExit?: number;
  patchExit?: number;
}): GhStub {
  const binDir = mkdtempSync(join(tmpdir(), "flywheel-pdr-bin-"));
  const callsLog = join(binDir, "gh-calls.log");
  const releasesResponseFile = join(binDir, "releases-response.json");
  const listStatusFile = join(binDir, "releases-response.status");
  const patchStatusFile = join(binDir, "patch-response.status");
  writeFileSync(releasesResponseFile, opts.releasesResponseJson ?? "");
  writeFileSync(listStatusFile, String(opts.listLookupExit ?? 0));
  writeFileSync(patchStatusFile, String(opts.patchExit ?? 0));

  const stub = `#!/usr/bin/env bash
# Record argv to the calls log, one NUL-terminated record per call.
{
  printf '%s' "$1"
  for arg in "\${@:2}"; do
    printf '\\t%s' "$arg"
  done
  printf '\\0'
} >> "${callsLog}"

# gh api <path>             → return releases-response.json (the LIST
#                             endpoint's JSON array) with the list-status exit
# gh api --method PATCH ...   → no output, exit with the patch-status code
if [[ "$1" == "api" && "$2" == "--method" && "$3" == "PATCH" ]]; then
  exit "$(cat "${patchStatusFile}")"
fi
if [[ "$1" == "api" ]]; then
  cat "${releasesResponseFile}"
  exit "$(cat "${listStatusFile}")"
fi
exit 0
`;
  writeFileSync(join(binDir, "gh"), stub);
  chmodSync(join(binDir, "gh"), 0o755);
  // jq is also required by the script — assume it's on PATH in CI and
  // on most dev machines; on the rare missing-jq machine these tests
  // fail with a clear error rather than a silent skip.
  return {
    binDir,
    callsLog,
    cleanup: () => rmSync(binDir, { recursive: true, force: true }),
  };
}

/** Run the script with the given env. PATH is prepended with the stub
 * bin so `gh` resolves to the test stub before any real install. */
function runScript(opts: {
  binDir: string;
  env: Record<string, string>;
}): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("bash", [scriptPath], {
    env: {
      ...process.env,
      PATH: `${opts.binDir}:${process.env.PATH ?? ""}`,
      ...opts.env,
    },
    encoding: "utf8",
  });
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

/** Read the calls log and split into one array per call, each call's
 * args TAB-split. */
function readCalls(callsLog: string): string[][] {
  const raw = readFileSync(callsLog, "utf8");
  if (raw.length === 0) return [];
  return raw
    .split("\0")
    .filter((r) => r.length > 0)
    .map((r) => r.split("\t"));
}

const LIST_PATH = "/repos/point-source/flywheel/releases";

describe("publish-draft-release.sh", () => {
  it("publishes a draft release whose target_commitish matches EXPECTED_SHA", () => {
    // (a1) The draft-visible LIST lookup returns the draft → publish proceeds.
    const releasesJson = JSON.stringify([
      {
        id: 12345,
        tag_name: "v1.3.0",
        draft: true,
        target_commitish: "deadbeefcafef00d",
      },
    ]);
    const stub = setupGhStub({ releasesResponseJson: releasesJson });
    try {
      const r = runScript({
        binDir: stub.binDir,
        env: {
          GITHUB_TOKEN: "test-token",
          GITHUB_REPOSITORY: "point-source/flywheel",
          TAG_NAME: "v1.3.0",
          EXPECTED_SHA: "deadbeefcafef00d",
        },
      });
      expect(r.status, `\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`).toBe(0);
      expect(r.stdout).toContain("Publishing release id=12345");
      expect(r.stdout).toContain("Published.");

      const calls = readCalls(stub.callsLog);
      // First call: list the releases (draft-visible endpoint).
      expect(calls[0]).toEqual(["api", LIST_PATH]);
      // Second call: PATCH with draft=false on the resolved id.
      expect(calls[1]).toEqual([
        "api",
        "--method",
        "PATCH",
        "/repos/point-source/flywheel/releases/12345",
        "-F",
        "draft=false",
      ]);
    } finally {
      stub.cleanup();
    }
  });

  it("fails loudly when the lookup errors with a non-empty body (the v1.4.0–v1.6.0 stranding shape)", () => {
    // (a2) The stale tags-style miss AS IT REALLY HAPPENED: in production
    // the failing lookup did NOT return an empty body — it returned a
    // non-zero exit *together with* a non-empty error body on stdout
    // (e.g. GitHub's `{"message":"Not Found",...}`). The previous test
    // stubbed an EMPTY body for the miss, so the script's `[[ -z ... ]]`
    // guard swallowed it as "nothing to publish" and the bug went
    // unreproduced. A faithful stub must carry a NON-EMPTY body, which is
    // why this case asserts the loud-failure path rather than a no-op.
    const errorBody = JSON.stringify({
      message: "Not Found",
      documentation_url: "https://docs.github.com/rest",
    });
    const stub = setupGhStub({
      releasesResponseJson: errorBody,
      listLookupExit: 1,
    });
    try {
      const r = runScript({
        binDir: stub.binDir,
        env: {
          GITHUB_TOKEN: "test-token",
          GITHUB_REPOSITORY: "point-source/flywheel",
          TAG_NAME: "v1.6.0",
        },
      });
      expect(r.status).not.toBe(0);
      expect(r.stderr + r.stdout).toMatch(/::error::/);
      // Must NOT be misclassified as the benign "nothing to publish" no-op.
      expect(r.stderr + r.stdout).not.toMatch(/No release found for tag/);

      // The lookup happened; no PATCH was issued.
      const calls = readCalls(stub.callsLog);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual(["api", LIST_PATH]);
    } finally {
      stub.cleanup();
    }
  });

  it("is idempotent: a release that is already published is a no-op (exit 0, no PATCH)", () => {
    // (b) The selected release has draft:false → idempotent no-op.
    const releasesJson = JSON.stringify([
      {
        id: 99,
        tag_name: "v1.3.0",
        draft: false,
        target_commitish: "anysha",
      },
    ]);
    const stub = setupGhStub({ releasesResponseJson: releasesJson });
    try {
      const r = runScript({
        binDir: stub.binDir,
        env: {
          GITHUB_TOKEN: "test-token",
          GITHUB_REPOSITORY: "point-source/flywheel",
          TAG_NAME: "v1.3.0",
        },
      });
      expect(r.status, `\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`).toBe(0);
      expect(r.stdout).toContain("already published");

      const calls = readCalls(stub.callsLog);
      // Only the lookup happened — no PATCH.
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual(["api", LIST_PATH]);
      expect(calls[0]).not.toContain("PATCH");
    } finally {
      stub.cleanup();
    }
  });

  it("treats a genuine absence of any release for the tag as a benign no-op", () => {
    // (c) The list parses fine but contains no element matching the tag —
    // this is the only real "nothing to publish" case. Distinct from a2:
    // here the lookup *succeeded* and simply found nothing.
    const releasesJson = JSON.stringify([
      {
        id: 5,
        tag_name: "v1.2.0",
        draft: false,
        target_commitish: "othersha",
      },
    ]);
    const stub = setupGhStub({ releasesResponseJson: releasesJson });
    try {
      const r = runScript({
        binDir: stub.binDir,
        env: {
          GITHUB_TOKEN: "test-token",
          GITHUB_REPOSITORY: "point-source/flywheel",
          TAG_NAME: "v9.9.9",
        },
      });
      expect(r.status, `\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`).toBe(0);
      expect(r.stdout).toContain("No release found for tag");

      const calls = readCalls(stub.callsLog);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual(["api", LIST_PATH]);
    } finally {
      stub.cleanup();
    }
  });

  it("refuses to publish when target_commitish drifts from EXPECTED_SHA", () => {
    // (d) The matching draft's target_commitish != EXPECTED_SHA → loud refusal.
    const releasesJson = JSON.stringify([
      {
        id: 12345,
        tag_name: "v1.3.0",
        draft: true,
        target_commitish: "actualsha",
      },
    ]);
    const stub = setupGhStub({ releasesResponseJson: releasesJson });
    try {
      const r = runScript({
        binDir: stub.binDir,
        env: {
          GITHUB_TOKEN: "test-token",
          GITHUB_REPOSITORY: "point-source/flywheel",
          TAG_NAME: "v1.3.0",
          EXPECTED_SHA: "differentsha",
        },
      });
      expect(r.status).not.toBe(0);
      expect(r.stderr + r.stdout).toMatch(/does not match expected SHA/);

      // Lookup happened; PATCH did not.
      const calls = readCalls(stub.callsLog);
      expect(calls).toHaveLength(1);
      expect(calls[0]).not.toContain("PATCH");
    } finally {
      stub.cleanup();
    }
  });

  it("publishes without SHA verification when EXPECTED_SHA is unset", () => {
    const releasesJson = JSON.stringify([
      {
        id: 7,
        tag_name: "v1.3.0",
        draft: true,
        target_commitish: "anysha",
      },
    ]);
    const stub = setupGhStub({ releasesResponseJson: releasesJson });
    try {
      const r = runScript({
        binDir: stub.binDir,
        env: {
          GITHUB_TOKEN: "test-token",
          GITHUB_REPOSITORY: "point-source/flywheel",
          TAG_NAME: "v1.3.0",
        },
      });
      expect(r.status, `\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`).toBe(0);
      const calls = readCalls(stub.callsLog);
      // Lookup + PATCH.
      expect(calls).toHaveLength(2);
      expect(calls[0]).toEqual(["api", LIST_PATH]);
      expect(calls[1]).toContain("PATCH");
    } finally {
      stub.cleanup();
    }
  });

  it("fails loudly when the publish PATCH call errors", () => {
    // (f) The draft is found and publishable, but the PATCH (draft=false)
    // call itself errors. Like the lookup failures, a publish error is
    // loud: a maintainer reading CI must be able to tell the green release
    // did not reach adopters, rather than the run exiting on a bare
    // non-zero with no signposted reason.
    const releasesJson = JSON.stringify([
      {
        id: 4242,
        tag_name: "v1.3.0",
        draft: true,
        target_commitish: "anysha",
      },
    ]);
    const stub = setupGhStub({ releasesResponseJson: releasesJson, patchExit: 1 });
    try {
      const r = runScript({
        binDir: stub.binDir,
        env: {
          GITHUB_TOKEN: "test-token",
          GITHUB_REPOSITORY: "point-source/flywheel",
          TAG_NAME: "v1.3.0",
        },
      });
      expect(r.status).not.toBe(0);
      expect(r.stderr + r.stdout).toMatch(/::error::/);
      expect(r.stdout).not.toContain("Published.");

      // The PATCH was attempted (lookup + PATCH), but the script did not
      // claim success.
      const calls = readCalls(stub.callsLog);
      expect(calls).toHaveLength(2);
      expect(calls[1]).toContain("PATCH");
    } finally {
      stub.cleanup();
    }
  });

  it("fails loudly when the lookup body is not a parseable JSON array", () => {
    // (e) The list lookup succeeded (exit 0) but returned non-array
    // garbage — the script cannot trust it and must fail loudly rather
    // than silently treat it as "nothing to publish".
    const stub = setupGhStub({
      releasesResponseJson: "not json",
      listLookupExit: 0,
    });
    try {
      const r = runScript({
        binDir: stub.binDir,
        env: {
          GITHUB_TOKEN: "test-token",
          GITHUB_REPOSITORY: "point-source/flywheel",
          TAG_NAME: "v1.3.0",
        },
      });
      expect(r.status).not.toBe(0);
      expect(r.stderr + r.stdout).toMatch(/::error::/);

      const calls = readCalls(stub.callsLog);
      expect(calls).toHaveLength(1);
      expect(calls[0]).not.toContain("PATCH");
    } finally {
      stub.cleanup();
    }
  });

  it("fails fast when required env vars are missing", () => {
    const stub = setupGhStub({});
    try {
      const r = runScript({
        binDir: stub.binDir,
        env: {
          // GITHUB_TOKEN intentionally absent.
          GITHUB_REPOSITORY: "point-source/flywheel",
          TAG_NAME: "v1.3.0",
        },
      });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/GITHUB_TOKEN/);
    } finally {
      stub.cleanup();
    }
  });
});
