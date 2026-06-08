import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/integration/**", "tests/e2e/**", "node_modules/**", "dist/**", "core/dist/**"],
    // Several suites here exercise real `git`/`bash`/`gh`-stub processes
    // against tmpdir repos (back-merge, merge-driver, sanitize-release-
    // mentions, init). Vitest's default 5s timeout is enough in
    // isolation but flakes under parallel I/O contention on CI runners.
    // 15s is comfortable headroom; truly hung tests still fail.
    testTimeout: 15_000,
  },
});
