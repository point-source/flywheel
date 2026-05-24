import { afterEach, describe, expect, it } from "vitest";

import {
  SANDBOX_OWNER,
  SANDBOX_REPO,
  sandboxOctokit,
  hasSandboxToken,
} from "../../integration/helpers/sandbox-client.js";
import { createTestPR, uniqueBranch } from "../../integration/helpers/test-pr.js";
import { registerForTeardown, runTeardown } from "../../integration/helpers/teardown.js";
import { pollUntil } from "../helpers/poll-until.js";
import {
  getRepoFile,
  listTagsMatching,
  mergePR,
  pushCommit,
} from "../helpers/sandbox-e2e.js";
import { snapshotRunIds, waitForRunAfter } from "../helpers/run-baseline.js";
import { cleanupNewTags, snapshotTags, type TagBaseline } from "../helpers/tag-cleanup.js";

const E2E_DEVELOP = "e2e-develop";
// e2e-develop sits in the main-line stream whose terminal branch is
// release: production (e2e-main) — main-line is therefore the primary
// stream and its tags use the bare `v${version}` format (see
// chooseTagFormat in src/release-rc.ts). All dev tags this scenario
// produces match `v…-dev.N`; per-test cleanup diffs against a snapshot
// taken at the top of the test so we delete only tags this run produced.
const MAIN_LINE_TAG_PREFIX = "v";
const DEV_TAG_PATTERN = /^v(\d+)\.(\d+)\.(\d+)-dev\.(\d+)$/;

interface CreatedDraftRelease {
  tag: string;
  id: number;
}

// What this scenario guards. Once `release_as_draft: true` is in
// .flywheel.yml, semantic-release must create the GitHub Release as an
// unpublished draft instead of publishing it — that is the publish-
// time gap GitHub immutable releases requires for an adopter's build to
// attach assets before the tag and assets freeze. The single-release
// half of the test verifies the draft state. The two-release half
// verifies the load-bearing claim in SPEC §spec:immutable-release-support:
// semantic-release derives the next version from git *tags*, not from
// the draft/published state of the release object, so a second release
// cut while the first is still an unpublished draft computes the next
// version correctly. A regression that read release-object state
// instead of tags would either skip a version (treating the draft as
// "not yet released") or collide on the same tag — both observable here.
//
// Mutation of the shared sandbox `.flywheel.yml`. e2e-develop is the
// canonical prerelease branch other scenarios depend on; this scenario
// flips `release_as_draft` on for its own run and restores it in
// afterEach via a direct `pushCommit`. The vitest e2e config disables
// parallelism (`fileParallelism: false`, `sequence.concurrent: false`),
// so a single in-flight mutation cannot collide with another scenario.
// The restore push is one chore commit — it triggers flywheel-push.yml
// on e2e-develop but commit-analyzer treats `chore:` as non-bumping,
// so semantic-release skips and no spurious tag is produced.
describe.skipIf(!hasSandboxToken)(
  "e2e/11: release_as_draft creates an unpublished release and consecutive drafts compute correct versions",
  () => {
    let tagBaseline: TagBaseline;
    let originalConfig: string | null = null;
    const draftReleasesCreated: CreatedDraftRelease[] = [];

    afterEach(
      async () => {
        const octokit = sandboxOctokit();

        // Drafts don't share an object lifecycle with their tag — the
        // tag-cleanup pass below deletes tags but leaves orphan draft
        // releases behind. Sweep them explicitly here so they don't
        // accumulate across runs.
        for (const draft of draftReleasesCreated) {
          try {
            await octokit.rest.repos.deleteRelease({
              owner: SANDBOX_OWNER,
              repo: SANDBOX_REPO,
              release_id: draft.id,
            });
          } catch (err) {
            const status = (err as { status?: number } | undefined)?.status;
            if (status !== 404) {
              // best-effort cleanup; don't fail the suite on a 404 (already gone)
              // but surface anything else
              throw err;
            }
          }
        }
        draftReleasesCreated.length = 0;

        // Tags before branches/PRs — semantic-release tags are
        // independent of test branches and would otherwise outlive
        // the PR cleanup. Mirrors scenarios 08 and 10.
        if (tagBaseline) await cleanupNewTags(tagBaseline);

        // Restore `.flywheel.yml` on e2e-develop before subsequent
        // scenarios run. Direct pushCommit (not a PR cycle) so the
        // hook completes inside the vitest hookTimeout. A chore-typed
        // commit on a prerelease branch triggers flywheel-push.yml
        // but produces no release (commit-analyzer skip).
        if (originalConfig !== null) {
          await pushCommit(E2E_DEVELOP, {
            message: "chore(test): restore .flywheel.yml after e2e/11",
            files: [{ path: ".flywheel.yml", content: originalConfig }],
          });
        }
        originalConfig = null;

        await runTeardown();
      },
      300_000,
    );

    it(
      "release_as_draft: true yields an unpublished draft release; a second release while the first is still draft computes the next version correctly",
      async () => {
        tagBaseline = await snapshotTags(MAIN_LINE_TAG_PREFIX);

        const octokit = sandboxOctokit();
        originalConfig = await getRepoFile(E2E_DEVELOP, ".flywheel.yml");

        // Splice `release_as_draft: true` in under the e2e-develop branch
        // only — release_as_draft is per-branch (SPEC
        // §spec:immutable-release-support). The sandbox fixture lists
        // e2e-develop as the first branch of main-line; we inject
        // release_as_draft as a sibling of that branch's `name:` key,
        // leaving every other branch unchanged so the rest of the
        // suite continues to observe immediate-publish behavior.
        const draftConfig = originalConfig.replace(
          /(- name: e2e-develop\s*\n)/,
          "$1          release_as_draft: true\n",
        );
        expect(
          draftConfig,
          "patched .flywheel.yml must differ from the original — check the splice regex against the fixture",
        ).not.toBe(originalConfig);
        expect(draftConfig).toContain("release_as_draft: true");
        // Sanity: the top-level form would now be rejected by loadConfig,
        // so guard against an accidental top-level placement landing in
        // a re-recorded fixture.
        expect(draftConfig).not.toMatch(/^flywheel:\s*\n\s+release_as_draft:/m);

        const baseline = await snapshotRunIds([E2E_DEVELOP]);
        let baselinePush = baseline.get(E2E_DEVELOP)!.push;

        // PR1 — enable release_as_draft and ship a bumping commit
        // together. The PR carries one commit (.flywheel.yml change +
        // a marker file) titled `fix:` so semantic-release on the
        // squashed develop bumps the dev patch; the workflow checks
        // out develop at the squash and reads the new .flywheel.yml,
        // so release_as_draft is in effect for this release.
        const branch1 = uniqueBranch("e2e-draft-r1");
        const developHead = await octokit.rest.git.getRef({
          owner: SANDBOX_OWNER,
          repo: SANDBOX_REPO,
          ref: `heads/${E2E_DEVELOP}`,
        });
        await octokit.rest.git.createRef({
          owner: SANDBOX_OWNER,
          repo: SANDBOX_REPO,
          ref: `refs/heads/${branch1}`,
          sha: developHead.data.object.sha,
        });
        await pushCommit(branch1, {
          message: "fix: e2e draft release seed",
          files: [
            { path: ".flywheel.yml", content: draftConfig },
            {
              path: `tests/${branch1.replace(/[^a-z0-9]/gi, "-")}.txt`,
              content: `marker for ${branch1}\n`,
            },
          ],
        });
        const pr1 = await octokit.rest.pulls.create({
          owner: SANDBOX_OWNER,
          repo: SANDBOX_REPO,
          title: "fix: e2e draft release seed",
          body: "Enables release_as_draft and seeds the first draft release.",
          head: branch1,
          base: E2E_DEVELOP,
        });
        registerForTeardown({ branch: branch1, prNumber: pr1.data.number });
        await mergePR(pr1.data.number, "squash");

        await waitForRunAfter("flywheel-push.yml", E2E_DEVELOP, baselinePush, {
          timeoutMs: 300_000,
        });
        baselinePush = (await snapshotRunIds([E2E_DEVELOP])).get(E2E_DEVELOP)!.push;

        // The new dev tag must be present, and its release must be a draft.
        // semantic-release pushes the tag during its publish step; the
        // GitHub Release object is created moments later by
        // @semantic-release/github. Two short polls — one for the tag,
        // one for the release — absorb that ordering.
        const tagsAfter1 = await pollUntil(
          () => listTagsMatching(MAIN_LINE_TAG_PREFIX),
          (tags) =>
            tags.some(
              (t) => !tagBaseline.names.has(t.name) && DEV_TAG_PATTERN.test(t.name),
            ),
          {
            intervalMs: 5000,
            timeoutMs: 120_000,
            description: "first v…-dev.N tag to appear after release_as_draft seed merge",
          },
        );
        const newDevTags1 = tagsAfter1.filter(
          (t) => !tagBaseline.names.has(t.name) && DEV_TAG_PATTERN.test(t.name),
        );
        expect(newDevTags1).toHaveLength(1);
        const tag1 = newDevTags1[0]!.name;

        // Drafts are excluded from /releases/tags/<tag> — they can only
        // be found through the listReleases endpoint, where they appear
        // alongside published releases.
        const release1 = await pollUntil(
          async () => {
            const list = await octokit.rest.repos.listReleases({
              owner: SANDBOX_OWNER,
              repo: SANDBOX_REPO,
              per_page: 100,
            });
            return list.data.find((r) => r.tag_name === tag1) ?? null;
          },
          (r) => r !== null,
          {
            intervalMs: 5000,
            timeoutMs: 120_000,
            description: `GitHub Release object for ${tag1}`,
          },
        );
        expect(release1, `no GitHub Release found for tag ${tag1}`).not.toBeNull();
        expect(
          release1!.draft,
          `release_as_draft: true should yield draft=true on the GitHub Release for ${tag1}; got published — ` +
            "the .releaserc.json that flywheel-push.yml generated did not carry { draftRelease: true } for the github plugin",
        ).toBe(true);
        draftReleasesCreated.push({ tag: tag1, id: release1!.id });

        // PR2 — second fix while release1 is still an unpublished draft.
        // The next version must compute from the git *tag* sequence,
        // not from release-object state. createTestPR is sufficient here
        // because no .flywheel.yml change is needed; release_as_draft is
        // already set under the e2e-develop branch in the live config.
        const pr2 = await createTestPR({
          branch: uniqueBranch("e2e-draft-r2"),
          base: E2E_DEVELOP,
          title: "fix: e2e second draft release",
        });
        registerForTeardown({ branch: pr2.branch, prNumber: pr2.number });
        await mergePR(pr2.number, "squash");

        await waitForRunAfter("flywheel-push.yml", E2E_DEVELOP, baselinePush, {
          timeoutMs: 300_000,
        });

        const tagsAfter2 = await pollUntil(
          () => listTagsMatching(MAIN_LINE_TAG_PREFIX),
          (tags) =>
            tags.some(
              (t) =>
                !tagBaseline.names.has(t.name) &&
                DEV_TAG_PATTERN.test(t.name) &&
                t.name !== tag1,
            ),
          {
            intervalMs: 5000,
            timeoutMs: 120_000,
            description: `second v…-dev.N tag distinct from ${tag1}`,
          },
        );
        const newDevTags2 = tagsAfter2.filter(
          (t) =>
            !tagBaseline.names.has(t.name) &&
            DEV_TAG_PATTERN.test(t.name) &&
            t.name !== tag1,
        );
        expect(newDevTags2).toHaveLength(1);
        const tag2 = newDevTags2[0]!.name;

        // Monotonic-successor assertion. Both tags share the same dev
        // line under normal conditions (two consecutive fix-bumps =
        // same major.minor.patch, incrementing dev.N). If a parallel
        // change shifted the patch/minor between the two PRs, we still
        // accept any tag2 that is a strict successor of tag1 on the
        // dev channel — the load-bearing claim is "second release
        // computed *something* sequential while first was still a
        // draft," not "exactly +1 on dev.N."
        const m1 = tag1.match(DEV_TAG_PATTERN)!;
        const m2 = tag2.match(DEV_TAG_PATTERN)!;
        const [maj1, min1, pat1, dev1] = [m1[1], m1[2], m1[3], Number(m1[4])];
        const [maj2, min2, pat2, dev2] = [m2[1], m2[2], m2[3], Number(m2[4])];
        const sameLine = maj1 === maj2 && min1 === min2 && pat1 === pat2;
        if (sameLine) {
          expect(
            dev2,
            `consecutive dev releases on the same line should monotonically increment dev.N; got ${tag1} → ${tag2}`,
          ).toBeGreaterThan(dev1);
        } else {
          // Different version line — accept any tag2 that is not a
          // duplicate of tag1. The mere fact that semantic-release
          // produced a distinct, well-formed dev tag while tag1's
          // release was still draft is the proof we wanted: draft
          // state is invisible to version computation.
          expect(tag2).not.toBe(tag1);
        }

        // tag2's release must also be a draft (release_as_draft is still on).
        const release2 = await pollUntil(
          async () => {
            const list = await octokit.rest.repos.listReleases({
              owner: SANDBOX_OWNER,
              repo: SANDBOX_REPO,
              per_page: 100,
            });
            return list.data.find((r) => r.tag_name === tag2) ?? null;
          },
          (r) => r !== null,
          {
            intervalMs: 5000,
            timeoutMs: 120_000,
            description: `GitHub Release object for ${tag2}`,
          },
        );
        expect(release2!.draft).toBe(true);
        draftReleasesCreated.push({ tag: tag2, id: release2!.id });

        // Negative — release1 must still be a draft when release2 lands.
        // If a regression caused the second release run to publish the
        // first draft (e.g. by retrying the github plugin against an
        // existing release), this catches it.
        const release1After = await octokit.rest.repos.getRelease({
          owner: SANDBOX_OWNER,
          repo: SANDBOX_REPO,
          release_id: release1!.id,
        });
        expect(
          release1After.data.draft,
          `release for ${tag1} should remain an unpublished draft after the second release run; was published mid-test`,
        ).toBe(true);
      },
      900_000,
    );
  },
);
