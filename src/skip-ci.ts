// GitHub Actions recognizes six magic strings in commit messages as
// workflow-suppression directives. When any of these appear anywhere in
// a commit message, GitHub silently skips every workflow that would have
// triggered for the push. The marker also propagates through default
// squash-merge commit bodies (which concatenate the squashed commits'
// messages) — so a single contaminated PR can suppress all workflows on
// the merge target, breaking semantic-release and back-merge.
//
// We detect these markers in PR titles, PR bodies, and every commit's
// title/body in the PR, and fail the conventional-commit check before
// the marker can reach the merge commit.
//
// Reference: https://docs.github.com/en/actions/managing-workflow-runs/skipping-workflow-runs

const SKIP_CI_PATTERNS: ReadonlyArray<RegExp> = [
  /\[skip ci\]/i,
  /\[ci skip\]/i,
  /\[no ci\]/i,
  /\[skip actions\]/i,
  /\[actions skip\]/i,
  /\*\*\*NO_CI\*\*\*/,
];

export interface SkipCiInput {
  source: string;
  text: string;
}

export interface SkipCiHit {
  source: string;
  marker: string;
}

export function findSkipCiMarkers(inputs: ReadonlyArray<SkipCiInput>): SkipCiHit[] {
  const hits: SkipCiHit[] = [];
  for (const input of inputs) {
    if (!input.text) continue;
    for (const pattern of SKIP_CI_PATTERNS) {
      const match = input.text.match(pattern);
      if (match) {
        hits.push({ source: input.source, marker: match[0] });
      }
    }
  }
  return hits;
}

// Defense-in-depth: strip skip-ci variants when echoing third-party commit
// titles into bot-generated PR bodies, so adopters with infected legacy
// commits don't see the markers re-emitted in promotion PR descriptions.
// Collapses any whitespace gap left by the removed marker.
export function sanitizeSkipCi(text: string): string {
  let out = text;
  for (const pattern of SKIP_CI_PATTERNS) {
    out = out.replace(new RegExp(pattern.source, pattern.flags + "g"), "");
  }
  return out.replace(/\s{2,}/g, " ").trim();
}
