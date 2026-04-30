import { describe, expect, it } from "vitest";

import {
  findMissingPermissions,
  formatMissingPermissionsError,
  REQUIRED_PERMISSIONS,
} from "../src/preflight.js";

const FULL_GRANTED: Record<string, string> = {
  contents: "write",
  pull_requests: "write",
  issues: "write",
  checks: "write",
  metadata: "read",
};

describe("findMissingPermissions", () => {
  it("returns empty when every required permission is granted at the right level", () => {
    expect(findMissingPermissions(FULL_GRANTED)).toEqual([]);
  });

  it("flags every required permission as missing when nothing is granted", () => {
    const missing = findMissingPermissions({});
    expect(missing).toHaveLength(REQUIRED_PERMISSIONS.length);
    for (const m of missing) expect(m.granted).toBe("none");
  });

  it("flags a write permission downgraded to read", () => {
    const missing = findMissingPermissions({ ...FULL_GRANTED, checks: "read" });
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({
      name: "checks",
      required: "write",
      granted: "read",
    });
  });

  it("does not flag metadata:read when only :read is granted (read level satisfies read requirement)", () => {
    const missing = findMissingPermissions(FULL_GRANTED);
    expect(missing.find((m) => m.name === "metadata")).toBeUndefined();
  });

  it("flags multiple gaps in one pass", () => {
    const missing = findMissingPermissions({
      contents: "write",
      pull_requests: "read",
      // issues missing
      checks: "read",
      metadata: "read",
    });
    expect(missing.map((m) => m.name).sort()).toEqual(["checks", "issues", "pull_requests"]);
  });

  it("treats unknown granted values as 'none' for write requirements", () => {
    const missing = findMissingPermissions({ ...FULL_GRANTED, checks: "weird" });
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ name: "checks", granted: "none" });
  });
});

describe("formatMissingPermissionsError", () => {
  it("includes every missing permission with required, granted, and reason", () => {
    const missing = findMissingPermissions({ ...FULL_GRANTED, checks: "read" });
    const text = formatMissingPermissionsError(missing, "flywheel-build-e2e", "point-source/flywheel-sandbox");
    expect(text).toContain("point-source/flywheel-sandbox");
    expect(text).toContain("checks: need write, granted read");
    expect(text).toContain("flywheel/conventional-commit"); // reason text
    expect(text).toContain("https://github.com/settings/apps/flywheel-build-e2e/permissions");
  });

  it("falls back to a generic instruction when appSlug is null", () => {
    const text = formatMissingPermissionsError(
      findMissingPermissions({}),
      null,
      "owner/repo",
    );
    expect(text).not.toContain("/apps//permissions");
    expect(text).toContain("Update the App's permissions in its settings page on GitHub.");
  });
});
