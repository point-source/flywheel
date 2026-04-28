import type { FlywheelConfig } from "../../../src/types.js";

/**
 * Mirror of the .flywheel.yml committed to flywheel-ci/flywheel-sandbox.
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
          prerelease: "dev",
          auto_merge: ["fix", "fix!", "chore", "style", "test", "docs"],
        },
        {
          name: "e2e-staging",
          prerelease: "rc",
          auto_merge: ["fix", "chore"],
        },
        { name: "e2e-main", auto_merge: [] },
      ],
    },
    {
      name: "customer-acme",
      branches: [
        {
          name: "e2e-customer-acme",
          prerelease: "acme",
          auto_merge: ["fix", "fix!", "chore"],
        },
      ],
    },
    {
      name: "integration",
      branches: [
        {
          name: "integration-test-base",
          auto_merge: ["fix", "chore", "perf", "style", "test"],
        },
      ],
    },
  ],
  merge_strategy: "squash",
  initial_version: "0.1.0",
};
