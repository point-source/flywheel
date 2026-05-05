import { describe, expect, it } from "vitest";

import { findSkipCiMarkers, sanitizeSkipCi } from "../src/skip-ci.js";

describe("findSkipCiMarkers", () => {
  it("returns empty when no markers present", () => {
    const hits = findSkipCiMarkers([
      { source: "title", text: "fix: clean title" },
      { source: "body", text: "All good here." },
    ]);
    expect(hits).toEqual([]);
  });

  it("ignores empty text", () => {
    const hits = findSkipCiMarkers([
      { source: "title", text: "" },
      { source: "body", text: "" },
    ]);
    expect(hits).toEqual([]);
  });

  it.each([
    ["[skip ci]", "[skip ci]"],
    ["[ci skip]", "[ci skip]"],
    ["[no ci]", "[no ci]"],
    ["[skip actions]", "[skip actions]"],
    ["[actions skip]", "[actions skip]"],
    ["***NO_CI***", "***NO_CI***"],
  ])("flags %s anywhere in the input", (marker, expectedMatch) => {
    const hits = findSkipCiMarkers([
      { source: "title", text: `chore(release): 1.0.0 ${marker}` },
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({ source: "title", marker: expectedMatch });
  });

  it("matches the bracketed variants case-insensitively", () => {
    const hits = findSkipCiMarkers([
      { source: "title", text: "fix: weird casing [Skip CI]" },
      { source: "body", text: "[CI SKIP] in body" },
    ]);
    expect(hits.map((h) => h.marker.toLowerCase())).toEqual(["[skip ci]", "[ci skip]"]);
  });

  it("aggregates multiple hits across sources", () => {
    const hits = findSkipCiMarkers([
      { source: "title", text: "chore(release): 1.0.0 [skip ci]" },
      { source: "body", text: "[no ci] notes" },
      { source: "commit", text: "fix: bug ***NO_CI***" },
    ]);
    expect(hits).toHaveLength(3);
    expect(hits.map((h) => h.source)).toEqual(["title", "body", "commit"]);
  });

  it("does not match unrelated bracketed text", () => {
    const hits = findSkipCiMarkers([
      { source: "title", text: "fix: [WIP] still working on this [skip ci-ish]" },
    ]);
    expect(hits).toEqual([]);
  });
});

describe("sanitizeSkipCi", () => {
  it("strips ` [skip ci]` from a chore release subject and trims trailing space", () => {
    expect(sanitizeSkipCi("chore(release): 1.0.0 [skip ci]")).toBe("chore(release): 1.0.0");
  });

  it("strips multiple variants", () => {
    expect(sanitizeSkipCi("foo [skip ci] bar [no ci] baz ***NO_CI*** end")).toBe("foo bar baz end");
  });

  it("returns clean strings unchanged (modulo trim)", () => {
    expect(sanitizeSkipCi("fix: simple")).toBe("fix: simple");
  });
});
