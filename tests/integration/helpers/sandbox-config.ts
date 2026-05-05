import type { FlywheelConfig } from "../../../src/types.js";

/**
 * Mirror of the .flywheel.yml committed to point-source/flywheel-sandbox.
 * Kept in TS form so integration tests don't depend on the sandbox repo's
 * working copy at test time. If the sandbox config changes, update this too.
 */
export const sandboxConfig: FlywheelConfig = {
  streams: [
    {
      name: "main-line",
      branches: [
        {
          name: "e2e-develop",
          release: "prerelease",
          suffix: "dev",
          auto_merge: ["fix", "fix!", "chore", "style", "test", "docs"],
        },
        {
          name: "e2e-staging",
          release: "prerelease",
          suffix: "rc",
          auto_merge: ["fix", "chore"],
        },
        { name: "e2e-main", release: "production", auto_merge: [] },
      ],
    },
    {
      name: "customer-acme",
      branches: [
        {
          name: "e2e-customer-acme",
          release: "prerelease",
          suffix: "acme",
          auto_merge: ["fix", "fix!", "chore"],
        },
      ],
    },
    {
      name: "integration",
      branches: [
        {
          name: "integration-test-base",
          release: "prerelease",
          suffix: "int",
          auto_merge: ["fix", "chore", "perf", "style", "test"],
        },
      ],
    },
  ],
  merge_strategy: "squash",
};
