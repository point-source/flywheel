import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// End-to-end exercise of scripts/classify-commit.sh: feed it a fixture event
// payload via $GITHUB_EVENT_PATH and assert the derived_release_commit /
// promotion_pr lines it writes to $GITHUB_OUTPUT. The script backs the
// point-source/flywheel/classify composite action (classify/action.yml).
// See §spec:release-ci-budget.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = join(repoRoot, "scripts/classify-commit.sh");

interface Outputs {
  derived_release_commit: string;
  promotion_pr: string;
}

/** Run the script with a fixture payload and parse its $GITHUB_OUTPUT. */
function classify(eventName: string, payload: unknown): Outputs {
  const dir = mkdtempSync(join(tmpdir(), "flywheel-classify-"));
  try {
    const eventPath = join(dir, "event.json");
    const outputPath = join(dir, "github_output");
    writeFileSync(eventPath, JSON.stringify(payload));
    writeFileSync(outputPath, "");
    execFileSync("bash", [scriptPath], {
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: eventName,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: outputPath,
      },
      encoding: "utf8",
    });
    const out: Record<string, string> = {};
    for (const line of readFileSync(outputPath, "utf8").split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return {
      derived_release_commit: out.derived_release_commit ?? "",
      promotion_pr: out.promotion_pr ?? "",
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const pushCommit = (name: string, message: string) => ({
  head_commit: { author: { name }, message },
});
const mergeGroupCommit = (name: string, message: string) => ({
  merge_group: { head_commit: { author: { name }, message } },
});
const pr = (title: string) => ({ pull_request: { title } });

describe("classify-commit: derived_release_commit", () => {
  it("flags the chore(release) commit authored by semantic-release-bot", () => {
    // Multiline message mirrors the real commit (version + appended notes).
    const out = classify(
      "push",
      pushCommit("semantic-release-bot", "chore(release): 1.4.0\n\nrelease notes"),
    );
    expect(out.derived_release_commit).toBe("true");
    expect(out.promotion_pr).toBe("false");
  });

  it("flags the chore: back-merge merge commit authored by github-actions[bot]", () => {
    const out = classify(
      "push",
      pushCommit("github-actions[bot]", "chore: back-merge v1.4.0 from main into develop"),
    );
    expect(out.derived_release_commit).toBe("true");
  });

  it("flags a fast-forward back-merge whose upstream tip IS the release commit", () => {
    // When the back-merge fast-forwards, develop's push event carries the
    // chore(release) commit itself (semantic-release-bot) — not a separate
    // merge commit. This is the "tip is simultaneously release + back-merge"
    // case from §spec:release-ci-budget.
    const out = classify(
      "push",
      pushCommit("semantic-release-bot", "chore(release): 1.4.0"),
    );
    expect(out.derived_release_commit).toBe("true");
  });

  it("does not flag an ordinary human commit", () => {
    const out = classify("push", pushCommit("Jane Dev", "fix: a real bug"));
    expect(out.derived_release_commit).toBe("false");
    expect(out.promotion_pr).toBe("false");
  });

  it("does not flag a human commit that fakes the chore(release) prefix", () => {
    // Author guard: the prefix alone is not enough.
    const out = classify("push", pushCommit("Jane Dev", "chore(release): not really"));
    expect(out.derived_release_commit).toBe("false");
  });

  it("does not flag a human commit that fakes the back-merge prefix", () => {
    const out = classify(
      "push",
      pushCommit("Jane Dev", "chore: back-merge by hand"),
    );
    expect(out.derived_release_commit).toBe("false");
  });

  it("does not flag a release prefix from the wrong bot (strict pairing)", () => {
    // chore(release) is trusted only from semantic-release-bot, not
    // github-actions[bot] — each prefix is paired to its emitting identity.
    const out = classify(
      "push",
      pushCommit("github-actions[bot]", "chore(release): 1.4.0"),
    );
    expect(out.derived_release_commit).toBe("false");
  });

  it("flags a release commit arriving via merge_group", () => {
    const out = classify(
      "merge_group",
      mergeGroupCommit("semantic-release-bot", "chore(release): 1.4.0"),
    );
    expect(out.derived_release_commit).toBe("true");
  });

  it("does not flag an ordinary merge_group commit", () => {
    const out = classify("merge_group", mergeGroupCommit("Jane Dev", "feat: thing"));
    expect(out.derived_release_commit).toBe("false");
  });

  it("does not flag when the push payload has a null head_commit", () => {
    // Branch deletions and tag pushes carry no head_commit.
    const out = classify("push", { head_commit: null });
    expect(out.derived_release_commit).toBe("false");
    expect(out.promotion_pr).toBe("false");
  });
});

describe("classify-commit: promotion_pr", () => {
  it("flags the develop→main promotion PR by its ': promote ' title", () => {
    const out = classify("pull_request", pr("chore: promote develop to main"));
    expect(out.promotion_pr).toBe("true");
    // The promotion signal never sets derived_release_commit — a
    // pull_request payload carries no commit message.
    expect(out.derived_release_commit).toBe("false");
  });

  it("does not flag an ordinary pull request", () => {
    const out = classify("pull_request", pr("feat: add a new thing"));
    expect(out.promotion_pr).toBe("false");
    expect(out.derived_release_commit).toBe("false");
  });
});
