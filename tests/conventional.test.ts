import { describe, expect, it } from "vitest";

import {
  computeIncrement,
  detectBreakingInBody,
  mostImpactfulType,
  parseTitle,
} from "../src/conventional.js";

describe("parseTitle", () => {
  it("parses a plain conventional commit", () => {
    const p = parseTitle("fix: handle token refresh race condition");
    expect(p).toEqual({
      type: "fix",
      scope: null,
      breaking: false,
      description: "handle token refresh race condition",
      raw: "fix: handle token refresh race condition",
    });
  });

  it("parses with scope", () => {
    const p = parseTitle("fix(auth): handle token refresh");
    expect(p?.type).toBe("fix");
    expect(p?.scope).toBe("auth");
    expect(p?.breaking).toBe(false);
  });

  it("parses with breaking !", () => {
    const p = parseTitle("feat!: drop support for API v1");
    expect(p?.type).toBe("feat");
    expect(p?.breaking).toBe(true);
  });

  it("parses scope + breaking", () => {
    const p = parseTitle("refactor(api)!: rename routes");
    expect(p?.type).toBe("refactor");
    expect(p?.scope).toBe("api");
    expect(p?.breaking).toBe(true);
  });

  it("rejects non-conventional titles", () => {
    expect(parseTitle("just a regular sentence")).toBeNull();
    expect(parseTitle("Fix: capitalised type is not allowed")).toBeNull();
    expect(parseTitle("nope: not a real type")).toBeNull();
    expect(parseTitle("fix:")).toBeNull();
    expect(parseTitle("fix:   ")).toBeNull();
  });

  it("accepts missing-space-after-colon as a typo to be normalized downstream", () => {
    const p = parseTitle("fix(auth):handle token refresh");
    expect(p).toEqual({
      type: "fix",
      scope: "auth",
      breaking: false,
      description: "handle token refresh",
      raw: "fix(auth):handle token refresh",
    });
  });
});

describe("detectBreakingInBody", () => {
  it("matches BREAKING CHANGE: at start of line", () => {
    expect(detectBreakingInBody("body line\n\nBREAKING CHANGE: drops X")).toBe(true);
  });
  it("matches at start of body", () => {
    expect(detectBreakingInBody("BREAKING CHANGE: starts here")).toBe(true);
  });
  it("accepts the BREAKING-CHANGE: hyphen variant", () => {
    expect(detectBreakingInBody("foo\n\nBREAKING-CHANGE: drops X")).toBe(true);
  });
  it("does not match when token is mid-line", () => {
    expect(detectBreakingInBody("note: this is NOT a BREAKING CHANGE: at all")).toBe(false);
  });
  it("does not match without content after the colon", () => {
    expect(detectBreakingInBody("BREAKING CHANGE:")).toBe(false);
    expect(detectBreakingInBody("BREAKING CHANGE: ")).toBe(false);
  });
  it("returns false for empty/null bodies", () => {
    expect(detectBreakingInBody(null)).toBe(false);
    expect(detectBreakingInBody(undefined)).toBe(false);
    expect(detectBreakingInBody("")).toBe(false);
  });
});

describe("computeIncrement", () => {
  it("major when title is breaking", () => {
    expect(computeIncrement(parseTitle("feat!: x")!)).toBe("major");
    expect(computeIncrement(parseTitle("chore!: x")!)).toBe("major");
  });
  it("major when body has BREAKING CHANGE footer (any non-breaking title)", () => {
    expect(computeIncrement(parseTitle("fix: x")!, true)).toBe("major");
    expect(computeIncrement(parseTitle("chore: x")!, true)).toBe("major");
  });
  it("minor for feat", () => {
    expect(computeIncrement(parseTitle("feat: x")!)).toBe("minor");
  });
  it("patch for fix and perf", () => {
    expect(computeIncrement(parseTitle("fix: x")!)).toBe("patch");
    expect(computeIncrement(parseTitle("perf: x")!)).toBe("patch");
  });
  it("none for chore/refactor/style/test/docs/build/ci/revert", () => {
    for (const t of ["chore", "refactor", "style", "test", "docs", "build", "ci", "revert"]) {
      expect(computeIncrement(parseTitle(`${t}: x`)!)).toBe("none");
    }
  });
});

describe("mostImpactfulType — precedence", () => {
  const order: ReadonlyArray<{ type: string; breaking: boolean }> = [
    { type: "feat", breaking: true },
    { type: "fix", breaking: true },
    { type: "chore", breaking: true },
    { type: "feat", breaking: false },
    { type: "fix", breaking: false },
    { type: "perf", breaking: false },
    { type: "refactor", breaking: false },
    { type: "chore", breaking: false },
    { type: "build", breaking: false },
  ];

  it.each(
    order.flatMap((higher, i) =>
      order.slice(i + 1).map((lower) => ({ higher, lower })),
    ),
  )("$higher.type${higher.breaking ? '!' : ''} beats $lower.type${lower.breaking ? '!' : ''}", ({ higher, lower }) => {
    const winner = mostImpactfulType([lower, higher]);
    expect(winner).toEqual(higher);
    const winnerSwapped = mostImpactfulType([higher, lower]);
    expect(winnerSwapped).toEqual(higher);
  });

  it("returns null on empty input", () => {
    expect(mostImpactfulType([])).toBeNull();
  });

  it("returns the only commit when given one", () => {
    expect(mostImpactfulType([{ type: "fix", breaking: false }])).toEqual({
      type: "fix",
      breaking: false,
    });
  });

  it("any other ! beats plain feat", () => {
    expect(mostImpactfulType([
      { type: "feat", breaking: false },
      { type: "chore", breaking: true },
    ])).toEqual({ type: "chore", breaking: true });
  });

  it("feat! and fix! tier ordering: feat! beats fix!", () => {
    expect(mostImpactfulType([
      { type: "fix", breaking: true },
      { type: "feat", breaking: true },
    ])).toEqual({ type: "feat", breaking: true });
  });
});
