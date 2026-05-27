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
// step of release-gate.yml. The script reads a release by tag from the
// GitHub API, refuses if the target_commitish drifted from the SHA the
// gate ran e2e against, and on a match flips the release from draft to
// public via PATCH /repos/{owner}/{repo}/releases/{id}.
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
 * within a record args are TAB-separated. Canned responses are written
 * to `tag-response.json` (returned for `gh api /repos/.../releases/tags/...`)
 * and `tag-response.status` (the gh exit code for the tags lookup, used
 * to simulate a 404). The PATCH call always succeeds — the script
 * doesn't read its output. */
function setupGhStub(opts: {
  tagResponseJson?: string;
  tagLookupExit?: number;
}): GhStub {
  const binDir = mkdtempSync(join(tmpdir(), "flywheel-pdr-bin-"));
  const callsLog = join(binDir, "gh-calls.log");
  const tagResponseFile = join(binDir, "tag-response.json");
  const tagStatusFile = join(binDir, "tag-response.status");
  writeFileSync(tagResponseFile, opts.tagResponseJson ?? "");
  writeFileSync(tagStatusFile, String(opts.tagLookupExit ?? 0));

  const stub = `#!/usr/bin/env bash
# Record argv to the calls log, one NUL-terminated record per call.
{
  printf '%s' "$1"
  for arg in "\${@:2}"; do
    printf '\\t%s' "$arg"
  done
  printf '\\0'
} >> "${callsLog}"

# gh api <path>            → return tag-response.json with tag-status exit
# gh api --method PATCH ...  → always success, no output
if [[ "$1" == "api" && "$2" == "--method" && "$3" == "PATCH" ]]; then
  exit 0
fi
if [[ "$1" == "api" ]]; then
  cat "${tagResponseFile}"
  exit "$(cat "${tagStatusFile}")"
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

describe("publish-draft-release.sh", () => {
  it("publishes a draft release whose target_commitish matches EXPECTED_SHA", () => {
    const tagJson = JSON.stringify({
      id: 12345,
      draft: true,
      target_commitish: "deadbeefcafef00d",
    });
    const stub = setupGhStub({ tagResponseJson: tagJson });
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
      // First call: lookup by tag.
      expect(calls[0]).toEqual([
        "api",
        "/repos/point-source/flywheel/releases/tags/v1.3.0",
      ]);
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

  it("is idempotent: a release that is already published is a no-op (exit 0, no PATCH)", () => {
    const tagJson = JSON.stringify({
      id: 99,
      draft: false,
      target_commitish: "anysha",
    });
    const stub = setupGhStub({ tagResponseJson: tagJson });
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
      expect(calls[0]![0]).toBe("api");
      expect(calls[0]).not.toContain("PATCH");
    } finally {
      stub.cleanup();
    }
  });

  it("refuses to publish when target_commitish drifts from EXPECTED_SHA", () => {
    const tagJson = JSON.stringify({
      id: 12345,
      draft: true,
      target_commitish: "actualsha",
    });
    const stub = setupGhStub({ tagResponseJson: tagJson });
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
    const tagJson = JSON.stringify({
      id: 7,
      draft: true,
      target_commitish: "anysha",
    });
    const stub = setupGhStub({ tagResponseJson: tagJson });
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
      expect(calls[1]).toContain("PATCH");
    } finally {
      stub.cleanup();
    }
  });

  it("handles a missing release for the tag (404) as a no-op", () => {
    const stub = setupGhStub({ tagResponseJson: "", tagLookupExit: 1 });
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
