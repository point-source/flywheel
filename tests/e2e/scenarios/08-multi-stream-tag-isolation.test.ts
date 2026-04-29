import { afterEach, describe, expect, it } from "vitest";

import { hasSandboxToken } from "../../integration/helpers/sandbox-client.js";
import { createTestPR, uniqueBranch } from "../../integration/helpers/test-pr.js";
import { registerForTeardown, runTeardown } from "../../integration/helpers/teardown.js";
import { pollUntil } from "../helpers/poll-until.js";
import { listTagsMatching, mergePR } from "../helpers/sandbox-e2e.js";
import { snapshotRunIds, waitForRunAfter } from "../helpers/run-baseline.js";
import { cleanupNewTags, snapshotTags, type TagBaseline } from "../helpers/tag-cleanup.js";

const E2E_CUSTOMER_ACME = "e2e-customer-acme";
const TAG_PREFIX = "customer-acme/";
const BARE_V_TAG_PREFIX = "v";

describe.skipIf(!hasSandboxToken)("e2e/08: customer-acme stream tags as customer-acme/v* (not bare v*)", () => {
  let acmeBaseline: TagBaseline;
  let bareBaseline: TagBaseline;

  afterEach(async () => {
    await cleanupNewTags(acmeBaseline);
    await runTeardown();
  });

  it("a fix merge to e2e-customer-acme creates a customer-acme/v* tag and no bare v* tag", async () => {
    acmeBaseline = await snapshotTags(TAG_PREFIX);
    bareBaseline = await snapshotTags(BARE_V_TAG_PREFIX);

    const baseline = await snapshotRunIds([E2E_CUSTOMER_ACME]);
    const baselinePush = baseline.get(E2E_CUSTOMER_ACME)!.push;

    const branch = uniqueBranch("e2e-acme-tag");
    const pr = await createTestPR({
      branch,
      base: E2E_CUSTOMER_ACME,
      title: "fix: e2e customer-acme tag isolation",
    });
    registerForTeardown({ branch, prNumber: pr.number });

    await mergePR(pr.number, "squash");

    await waitForRunAfter("flywheel-push.yml", E2E_CUSTOMER_ACME, baselinePush, {
      timeoutMs: 240_000,
    });

    const newAcmeTags = await pollUntil(
      async () => listTagsMatching(TAG_PREFIX),
      (tags) => tags.some((t) => !acmeBaseline.names.has(t.name)),
      {
        intervalMs: 5000,
        timeoutMs: 120_000,
        description: `new ${TAG_PREFIX}v* tag to appear`,
      },
    );

    const created = newAcmeTags.filter((t) => !acmeBaseline.names.has(t.name));
    expect(created.length).toBeGreaterThan(0);
    for (const t of created) {
      expect(t.name).toMatch(/^customer-acme\/v/);
    }

    // Negative: no bare v* tag for the same release.
    const bareNow = await listTagsMatching(BARE_V_TAG_PREFIX);
    const newBare = bareNow.filter(
      (t) => !bareBaseline.names.has(t.name) && !t.name.startsWith("customer-acme/"),
    );
    expect(newBare).toHaveLength(0);
  });
});
