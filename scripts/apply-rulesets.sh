#!/usr/bin/env bash
# apply-rulesets.sh — apply Flywheel branch + tag protection rulesets to a repo.
#
# Reads .flywheel.yml in the current directory, extracts every managed branch,
# and applies three rulesets via the GitHub Rulesets API:
#   1. Flywheel managed branches — block deletion / force-push of every
#      managed branch. NO bypass actors (not even the App), so GitHub's
#      delete_branch_on_merge cannot wipe a stream branch when the App
#      auto-merges a promotion or feature PR — see #81.
#   2. Flywheel managed branches — review — require PRs (and optionally
#      named status checks) to land on a managed branch. The App is on
#      this ruleset's bypass list so semantic-release can push the
#      chore(release) commit and back-merge directly without going
#      through a PR.
#   3. Flywheel tag namespace (v*) — block deletion / force-push of v* tags.
#      Optionally adds a GitHub App as a bypass actor so the bot can mint tags.
#
# Usage:
#   ./scripts/apply-rulesets.sh <owner/repo> [--config <path>] [--required-checks "quality,build"] [--release-required-checks "e2e"] [--app-id 12345]
#   # or piped, with no Flywheel checkout:
#   curl -fsSL https://raw.githubusercontent.com/point-source/flywheel/main/scripts/apply-rulesets.sh | bash -s -- <owner/repo> [flags]
#
# When not run from a checkout, the four ruleset templates are fetched from
# raw.githubusercontent.com at a single, deterministically chosen ref (default
# `main` — the ref the documented one-liner publishes from). Override FLYWHEEL_REF
# to pin a piped run to a tagged release, or FLYWHEEL_RULESETS_BASE to point at
# an arbitrary template source.
#
# --config defaults to ./.flywheel.yml. Use it to apply rulesets that match
# a config that hasn't been merged to the current working tree yet (e.g.
# point at a sibling worktree or a checked-out copy of develop's config).
#
# --required-checks defaults to "flywheel/conventional-commit". This check
# blocks PRs whose title/body/commits contain GitHub Actions skip-ci magic
# strings ([skip ci], [ci skip], [no ci], [skip actions], [actions skip],
# ***NO_CI***), which would otherwise silently suppress workflows on the
# merged commit and break semantic-release. Pass a custom comma list to
# extend, or pass "" to disable (not recommended).
#
# --release-required-checks defaults to "" (no release gate). When set,
# applies a fourth ruleset — "Flywheel release gate" — to every branch
# with `release: production` in .flywheel.yml, requiring the named
# status checks (CSV) to pass before merge. The App is in bypass on this
# ruleset too, so semantic-release's direct push of the release commit
# isn't blocked by the gate. Use this when you want expensive/long-
# running CI (e.g. an e2e suite) to gate the promotion PR into a
# production branch without slowing down day-to-day PRs into the
# prerelease channel. See #134 for the failure mode that motivated it.
#
# Dependencies: gh, jq, and python3. The two .flywheel.yml reads need PyYAML;
# when the invoking python3 can't import it (e.g. the stock macOS Xcode
# Command Line Tools python3, which does not ship PyYAML), the script
# provisions PyYAML into a disposable virtualenv for the run and removes it
# on exit — nothing is left installed on the adopter's machine. See #245.

set -euo pipefail

REPO=""
CONFIG_PATH=".flywheel.yml"
# Default to requiring the Flywheel conventional-commit check. Adopters
# can override with `--required-checks "..."` (or "" to disable, though
# disabling drops the skip-ci marker block, which is strongly discouraged).
REQUIRED_CHECKS="flywheel/conventional-commit"
# Empty default — no release gate. Adopters opt in by passing
# `--release-required-checks "<csv>"`; without the flag, behavior is
# identical to before this option existed.
RELEASE_REQUIRED_CHECKS=""
APP_ID="${APP_ID:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config) CONFIG_PATH="$2"; shift 2 ;;
    --required-checks) REQUIRED_CHECKS="$2"; shift 2 ;;
    --release-required-checks) RELEASE_REQUIRED_CHECKS="$2"; shift 2 ;;
    --app-id) APP_ID="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,32p' "$0"
      exit 0
      ;;
    *)
      if [[ -z "$REPO" ]]; then REPO="$1"; shift
      else echo "Unknown argument: $1" >&2; exit 2
      fi
      ;;
  esac
done

if [[ -z "$REPO" ]]; then
  echo "error: REPO argument required (owner/repo)" >&2
  exit 2
fi

for tool in gh jq python3; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "error: '$tool' is required but not installed." >&2
    case "$tool" in
      gh) echo "  install: https://cli.github.com/" >&2 ;;
      jq) echo "  install: brew install jq  /  apt-get install jq" >&2 ;;
      python3) echo "  python3 ships with macOS 12.3+ and most Linux distros." >&2 ;;
    esac
    exit 1
  }
done
# PyYAML resolver. The two .flywheel.yml reads below need PyYAML, but we
# refuse to tell adopters to permanently mutate their site-packages for a
# one-shot script. Resolve a python interpreter that can `import yaml` into
# PYYAML_PYTHON, provisioning an ephemeral venv only when the invoking
# python3 lacks it. The cleanup trap is registered BEFORE the mktemp so an
# interrupt mid-provision still removes the throwaway dir.
PYYAML_PYTHON="python3"
PYYAML_TMPDIR=""
cleanup_pyyaml() { [[ -n "$PYYAML_TMPDIR" ]] && rm -rf "$PYYAML_TMPDIR"; return 0; }
trap cleanup_pyyaml EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Tier 0 (fast path): if the invoking python3 already has PyYAML, use it as-is
# — no temp dir, no provisioning, no added latency. Only when the import fails
# do we fall through to Tier 1.
if ! python3 -c "import yaml" 2>/dev/null; then
  # Tier 1: provision PyYAML into a disposable, fully isolated venv.
  PYYAML_TMPDIR="$(mktemp -d)"
  echo "PyYAML not found in python3; provisioning it into a disposable virtualenv for this run..." >&2
  if ! python3 -m venv "$PYYAML_TMPDIR/venv" 2>/dev/null; then
    # Tier 2a: venv/ensurepip unavailable (some Debian/Ubuntu builds strip it).
    echo "error: python3 can't create a virtualenv (the venv/ensurepip module is missing)." >&2
    echo "  remedy: sudo apt-get install -y python3-venv, then re-run this script." >&2
    echo "  one-time manual fallback: python3 -m pip install --user pyyaml" >&2
    exit 1
  fi
  if ! "$PYYAML_TMPDIR/venv/bin/python" -m pip install --quiet --disable-pip-version-check pyyaml; then
    # Tier 2b: venv built but PyYAML couldn't be installed (no network /
    # package index unreachable).
    echo "error: failed to install PyYAML into the virtualenv (no network or the package index is unreachable)." >&2
    echo "  remedy: re-run this script with network access." >&2
    echo "  one-time manual fallback: python3 -m pip install --user pyyaml" >&2
    exit 1
  fi
  PYYAML_PYTHON="$PYYAML_TMPDIR/venv/bin/python"
fi

if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "error: config file not found: $CONFIG_PATH" >&2
  exit 1
fi

# Single source of the ref a piped run fetches templates from, so this script's
# logic and the ruleset shapes it applies never drift across versions. A
# tag-pinned piped invocation can set FLYWHEEL_REF to match its own ref.
FLYWHEEL_REF="${FLYWHEEL_REF:-main}"
RULESETS_BASE="${FLYWHEEL_RULESETS_BASE:-https://raw.githubusercontent.com/point-source/flywheel/${FLYWHEEL_REF}/scripts/rulesets}"
# When piped via `curl ... | bash`, BASH_SOURCE is unset and `set -u` would
# trip; default to empty and skip local-rulesets detection in that case.
SCRIPT_SRC="${BASH_SOURCE[0]:-}"
SCRIPT_DIR=""
if [[ -n "$SCRIPT_SRC" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SRC")" 2>/dev/null && pwd || true)"
fi

# Resolve where the ruleset templates live. From a checkout this is the
# bundled sibling dir (byte-for-byte the old behavior).
if [[ -n "$SCRIPT_DIR" && -d "$SCRIPT_DIR/rulesets" ]]; then
  RULESETS_DIR="$SCRIPT_DIR/rulesets"
else
  # Piped (no checkout on disk): fetch every ruleset template we'll need into
  # a temp dir BEFORE applying anything, so a failed fetch aborts before any
  # ruleset is created or any repo setting is flipped — never half-protected.
  RULESETS_DIR="$(mktemp -d)"
  # Remove the throwaway template dir on any exit — success, error under
  # `set -e`, or interrupt — so a piped run leaves nothing behind in $TMPDIR.
  trap 'rm -rf "$RULESETS_DIR"' EXIT INT TERM
  needed_rulesets=(managed-branches.json managed-branches-review.json tag-namespace.json)
  if [[ -n "$RELEASE_REQUIRED_CHECKS" ]]; then
    needed_rulesets+=(release-gate.json)
  fi
  for rs in "${needed_rulesets[@]}"; do
    if ! curl -fsSL "$RULESETS_BASE/$rs" -o "$RULESETS_DIR/$rs"; then
      echo "error: could not fetch ruleset template '$rs' from $RULESETS_BASE" >&2
      echo "  A piped run needs network access to fetch its templates; no rulesets were applied." >&2
      exit 1
    fi
  done
fi

branch_refs_json="$(CONFIG_PATH="$CONFIG_PATH" "$PYYAML_PYTHON" - <<'PYEOF'
import json, os, yaml
with open(os.environ['CONFIG_PATH']) as f:
    data = yaml.safe_load(f)
print(json.dumps([f'refs/heads/{b["name"]}' for s in data['flywheel']['streams'] for b in s['branches']]))
PYEOF
)"
branch_count="$(echo "$branch_refs_json" | jq 'length')"

if [[ "$branch_count" -eq 0 ]]; then
  echo "error: no branches found in .flywheel.yml" >&2
  exit 1
fi

# Production-release branches — i.e. those with `release: production`
# in .flywheel.yml — are the target of the optional release-gate ruleset
# below. Computed unconditionally so the help/dry output can show what
# would be gated; only consumed when --release-required-checks is set.
release_branch_refs_json="$(CONFIG_PATH="$CONFIG_PATH" "$PYYAML_PYTHON" - <<'PYEOF'
import json, os, yaml
with open(os.environ['CONFIG_PATH']) as f:
    data = yaml.safe_load(f)
print(json.dumps([
    f'refs/heads/{b["name"]}'
    for s in data['flywheel']['streams']
    for b in s['branches']
    if b.get('release') == 'production'
]))
PYEOF
)"
release_branch_count="$(echo "$release_branch_refs_json" | jq 'length')"

# apply_ruleset: idempotent create-or-replace by ruleset name. Re-running
# this script after .flywheel.yml changes (e.g. adding a branch) must update
# the existing ruleset rather than stack a duplicate. PUT updates the
# ruleset in place — atomic, preserves the ruleset ID (and the
# https://github.com/.../rules/<id> URLs that reference it), and never
# leaves the repo briefly unprotected the way DELETE-then-POST would if
# the POST failed.
apply_ruleset() {
  local payload="$1"
  local name
  name="$(echo "$payload" | jq -r .name)"
  local existing_id
  existing_id="$(gh api "repos/$REPO/rulesets" --jq ".[] | select(.name == \"$name\") | .id" | head -n1)"
  if [[ -n "$existing_id" ]]; then
    echo "Updating existing '$name' ruleset (id $existing_id) in place..."
    echo "$payload" | gh api -X PUT "/repos/$REPO/rulesets/$existing_id" --input -
  else
    echo "$payload" | gh api -X POST "/repos/$REPO/rulesets" --input -
  fi
}

echo "Applying destruction-protection ruleset to $branch_count branch(es) in $REPO..."

# Destruction ruleset: deletion + non_fast_forward for every managed branch.
# No bypass entry — not even the App. The App's auto-merge flow can fire
# GitHub's delete_branch_on_merge against a stream branch (the PR head); a
# bypass entry here would let that deletion through. See #81.
destruction_payload="$(jq \
  --argjson branches "$branch_refs_json" \
  '.conditions.ref_name.include = $branches' \
  "$RULESETS_DIR/managed-branches.json")"

apply_ruleset "$destruction_payload"

# Enable delete_branch_on_merge now that the destruction ruleset is in place.
# Order matters: with auto-delete on but no deletion rule, a user-clicked merge
# of a promotion PR triggers GitHub's auto-delete under the user's identity and
# wipes the source stream branch (#94). Coupling the two here makes it
# impossible to flip the bit without the protecting ruleset.
if gh api -X PATCH "repos/$REPO" -f delete_branch_on_merge=true >/dev/null 2>&1; then
  echo "Enabled delete_branch_on_merge on $REPO (head branches auto-delete on PR merge; stream branches protected by the ruleset above)."
else
  echo "warning: could not enable delete_branch_on_merge on $REPO — set manually in Settings → General → Pull Requests, or check your gh permissions." >&2
fi

# Enable allow_auto_merge. The pr-flow conductor schedules GitHub native
# auto-merge for eligible PRs; native auto-merge waits for the required status
# checks configured above instead of merging immediately. With allow_auto_merge
# off (the default for new repos), enablePullRequestAutoMerge is refused and
# pr-flow can only fall back to a direct merge — which, for an App in the
# review ruleset's bypass_actors, skips those very checks (#147). Idempotent.
if gh api -X PATCH "repos/$REPO" -f allow_auto_merge=true >/dev/null 2>&1; then
  echo "Enabled allow_auto_merge on $REPO (native auto-merge can wait for required checks)."
else
  echo "warning: could not enable allow_auto_merge on $REPO — set manually in Settings → General → Pull Requests → Allow auto-merge, or check your gh permissions." >&2
fi

echo "Applying review ruleset to $branch_count branch(es) in $REPO..."

review_payload="$(jq \
  --argjson branches "$branch_refs_json" \
  '.conditions.ref_name.include = $branches' \
  "$RULESETS_DIR/managed-branches-review.json")"

if [[ -n "$REQUIRED_CHECKS" ]]; then
  checks_json="$(echo "$REQUIRED_CHECKS" | jq -R 'split(",") | map({context: .})')"
  review_payload="$(echo "$review_payload" | jq \
    --argjson checks "$checks_json" \
    '.rules += [{"type":"required_status_checks","parameters":{"required_status_checks":$checks,"strict_required_status_checks_policy":false}}]')"
fi

# Bypass goes on the review ruleset only. semantic-release pushes the
# chore(release) commit and the back-merge directly to develop/main; the
# pull_request rule on this ruleset would block those without bypass.
# The destruction ruleset above stays unbypassed.
if [[ -n "$APP_ID" ]]; then
  review_payload="$(echo "$review_payload" | jq \
    --arg app_id "$APP_ID" \
    '.bypass_actors = [{"actor_id": ($app_id | tonumber), "actor_type": "Integration", "bypass_mode": "always"}]')"
fi

apply_ruleset "$review_payload"

echo "Applying tag-namespace ruleset to $REPO..."

tag_payload="$(cat "$RULESETS_DIR/tag-namespace.json")"
if [[ -n "$APP_ID" ]]; then
  tag_payload="$(echo "$tag_payload" | jq \
    --arg app_id "$APP_ID" \
    '.bypass_actors = [{"actor_id": ($app_id | tonumber), "actor_type": "Integration", "bypass_mode": "always"}]')"
fi

apply_ruleset "$tag_payload"

# Optional release-gate ruleset: stacks on top of the review ruleset for
# the production-release branches only, requiring additional status
# checks (e.g. an e2e suite) before a promotion PR can merge. Stacking
# is additive in GitHub Rulesets — main ends up with the review
# ruleset's `flywheel/conventional-commit` *and* whatever's listed in
# --release-required-checks; the prerelease channel (develop) keeps
# only the review ruleset's gate, so day-to-day PRs aren't slowed down
# by the long-running release checks.
if [[ -n "$RELEASE_REQUIRED_CHECKS" ]]; then
  if [[ "$release_branch_count" -eq 0 ]]; then
    echo "warning: --release-required-checks set but no branches have 'release: production' in $CONFIG_PATH; skipping release-gate ruleset." >&2
  else
    echo "Applying release-gate ruleset to $release_branch_count production branch(es) in $REPO..."

    release_checks_json="$(echo "$RELEASE_REQUIRED_CHECKS" | jq -R 'split(",") | map({context: .})')"
    release_payload="$(jq \
      --argjson branches "$release_branch_refs_json" \
      --argjson checks "$release_checks_json" \
      '.conditions.ref_name.include = $branches
       | .rules += [{"type":"required_status_checks","parameters":{"required_status_checks":$checks,"strict_required_status_checks_policy":false}}]' \
      "$RULESETS_DIR/release-gate.json")"

    # App bypass on the release-gate ruleset too. semantic-release pushes
    # the chore(release) commit and tag directly to the production branch
    # (the @semantic-release/git plugin commit, the back-merge commit on
    # back-merge, etc.). Without bypass, required_status_checks would
    # block those direct pushes the same way it gates the promotion PR.
    # Native auto-merge — which is what waits for required checks on the
    # promotion PR — does *not* go through the bypass path, so the
    # promotion PR is still gated even with the App in bypass.
    if [[ -n "$APP_ID" ]]; then
      release_payload="$(echo "$release_payload" | jq \
        --arg app_id "$APP_ID" \
        '.bypass_actors = [{"actor_id": ($app_id | tonumber), "actor_type": "Integration", "bypass_mode": "always"}]')"
    fi

    apply_ruleset "$release_payload"
  fi
fi

echo "Done. Verify with: gh api repos/$REPO/rulesets"
