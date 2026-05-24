# flywheel — Requirements

<!-- Problem-space document. Each ## section carries a §req:slug suffix. -->
<!-- Run /symphonize:discover to populate through a structured interview. -->

## Problem statement §req:problem-statement

GitHub's **immutable releases** became generally available in October 2025.
When a repository or organization enables it, a release's git tag and
attached assets are frozen the instant the release is published — they can
no longer be added, modified, or deleted — and an attestation is generated
as a supply-chain record.

flywheel creates *and publishes* a GitHub Release in one atomic step: a push
to a release branch runs `semantic-release`, whose `@semantic-release/github`
plugin creates the tag and publishes the release together. The
`release: published` event that this fires is also what triggers an
adopter's *separate* build workflow. An adopter whose build attaches a
compiled artifact to the release therefore uploads it **after** the release
is already published — exactly the operation immutable releases reject. The
adopter's release pipeline breaks the moment they, or an org-wide security
policy, turn immutable releases on.

No adopter is blocked today — this is anticipatory. The feature is GA,
adoption is expected, and flywheel should be ready before an adopter enables
it and discovers their build can no longer attach its artifact. The only
workaround GitHub documents is **draft → attach → publish**: create the
release unpublished, attach assets while it is still a mutable draft, then
publish. flywheel's single-step publish leaves no window for that.

flywheel also cannot solve this by detection. Whether an adopter's build
attaches an artifact is decided in a build workflow that lives in the
adopter's repository and that flywheel never reads — flywheel runs as an
action and has no visibility into a sibling workflow. The behavior must be
*declared*, not inferred.

Separately, flywheel's own releases on `point-source/flywheel` should be
publishable as immutable releases, so flywheel dogfoods the supply-chain
guarantee it expects adopters to depend on.

## Success criteria §req:success-criteria

- An adopter with immutable releases enabled, who has opted in, and whose
  build attaches a release artifact, can complete a release end-to-end: the
  artifact is attached and the release is published as an immutable release,
  with no failed upload step.
- An adopter who has **not** opted in observes no change whatsoever —
  releases publish immediately, on the same event and timing as before.
- flywheel's own releases on `point-source/flywheel` publish successfully
  with immutable releases enabled on that repository.
- Multiple releases cut in quick succession, while earlier ones are still
  unpublished drafts, each receive the correct next version — concurrent
  unpublished drafts never corrupt version computation. (semantic-release
  derives the next version from git tags, not from release objects; the tag
  must still be created and pushed on every run even when the release object
  is left unpublished.)
- The behavior is selected by a single explicit setting visible in flywheel's
  configuration — never inferred from the presence of assets or from whether
  immutability is enabled.

## User stories §req:user-stories

- As an adopter under a security policy that mandates immutable releases, I
  want flywheel to create my releases unpublished so my build workflow can
  attach its compiled artifact and then publish, so my release pipeline keeps
  working after immutability is turned on.
- As an adopter who attaches no artifacts, I want releases to keep publishing
  immediately, so enabling immutability elsewhere never changes or slows my
  release.
- As an adopter, I want to turn this on with one explicit setting that is
  visible in my repository's flywheel configuration, so the release behavior
  is obvious to anyone reading the repo and not hidden behind detection logic.
- As an adopter whose build attaches an artifact, I want a clear handoff —
  flywheel creates the unpublished release, my build attaches the artifact
  and performs the publish — so ownership of each step is unambiguous.
- As an adopter merging several changes in quick succession, I want each
  release to compute the correct version even though earlier releases are
  still unpublished drafts, so a burst of merges never produces duplicate or
  skipped versions.
- As a flywheel maintainer, I want flywheel's own releases to be immutable,
  so flywheel demonstrates the supply-chain guarantee it offers adopters.

## Quality attributes §req:quality-attributes

- **Backward compatibility.** Adopters who do not opt in are entirely
  unaffected — same trigger event, same timing, same published-immediately
  behavior.
- **Statelessness preserved.** flywheel does not track or wait on a release
  after creating it unpublished. Creating the unpublished release is the end
  of flywheel's involvement; the adopter's build owns attaching the artifact
  and performing the publish.
- **Correctness under concurrency.** Version computation depends only on git
  tags, so overlapping unpublished draft releases are safe.
- **Supply-chain integrity.** A published immutable release must still carry
  the attestation GitHub generates; flywheel must do nothing that prevents it.
- **No new privilege.** Supporting this requires no additional GitHub App
  scopes or permissions beyond what flywheel already holds.

## Constraints §req:constraints

- The opt-in is **repo-wide**, mirroring GitHub's immutable-releases setting,
  which is itself a repository/organization-level setting — not per-stream or
  per-branch.
- flywheel cannot inspect an adopter's build workflow. Whether a build
  attaches an artifact is unknowable to flywheel and must be declared
  explicitly in flywheel's configuration, never detected or inferred.
- GitHub immutable releases freeze a release's tag and assets at publish
  time; any artifact must be attached while the release is still an
  unpublished draft.
- The `release: published` event does not fire for unpublished releases. An
  adopter's build that must attach an artifact triggers on release creation
  instead, and performs the publish itself as its final step.
- flywheel's release path runs on `semantic-release`; whatever delivers the
  unpublished-release behavior must work within that pipeline and must not
  disturb tag creation, on which version computation depends.

## Priorities §req:priorities

Required, in decreasing order of user impact:

1. The explicit repo-wide opt-in and the unpublished-release flow for
   adopters who attach release artifacts. This is the failure that breaks an
   adopter's pipeline the day they enable immutable releases.
2. No change for adopters who have not opted in.
3. Correct version computation when concurrent unpublished drafts coexist.
4. flywheel publishing its own releases as immutable. flywheel attaches no
   release assets, so this needs only the immediate-publish path confirmed
   immutable-safe plus the repository setting enabled — far smaller than the
   adopter-facing feature, but it is how flywheel dogfoods the guarantee.

**Nice-to-have:**

- Updated adopter documentation and scaffolded templates showing the
  release-creation trigger and the publish-as-final-step pattern for builds
  that attach artifacts.
