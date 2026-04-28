import { describe, expect, it } from "vitest";

import { loadConfig } from "../../../src/config.js";
import { chooseTagFormat } from "../../../src/release-rc.js";
import { hasSandboxToken } from "../../integration/helpers/sandbox-client.js";
import { getRepoFile } from "../helpers/sandbox-e2e.js";

const E2E_MAIN = "e2e-main";

/**
 * Pragmatic deviation from the strategy doc's "semantic-release-dry-run"
 * scenario name: instead of spawning npx semantic-release (which requires a
 * git checkout, mutates state, and adds a 30s+ subprocess), this test loads
 * the live sandbox .flywheel.yml and exercises chooseTagFormat — the exact
 * function the action passes to semantic-release as tagFormat — for each
 * stream. If the live config drifts in a way that would produce colliding
 * or wrong-prefixed tags, this fails fast.
 */
describe.skipIf(!hasSandboxToken)("e2e/09: tag format derived from live sandbox config", () => {
  it("produces the expected tagFormat per stream", async () => {
    const yamlText = await getRepoFile(E2E_MAIN, ".flywheel.yml");
    const { config, errors } = loadConfig(yamlText);
    expect(errors).toEqual([]);
    expect(config).not.toBeNull();
    const streams = config!.streams;

    const mainLine = streams.find((s) => s.name === "main-line");
    const customerAcme = streams.find((s) => s.name === "customer-acme");
    const integration = streams.find((s) => s.name === "integration");
    expect(mainLine).toBeDefined();
    expect(customerAcme).toBeDefined();
    expect(integration).toBeDefined();

    expect(chooseTagFormat(mainLine!, streams)).toBe("v${version}");
    expect(chooseTagFormat(customerAcme!, streams)).toBe("customer-acme/v${version}");
    expect(chooseTagFormat(integration!, streams)).toBe("integration/v${version}");
  });
});
