# shellcheck shell=bash
# findings.sh — shared pre-flight finding vocabulary for Flywheel tooling.
#
# A sourceable library (no shebang; defines functions only). It must NOT mutate
# the sourcing shell's options (no `set -uo pipefail`). Source it from
# scripts/doctor.sh and from init's pre-flight.
#
# Delivers SPEC.md §spec:preflight-classification.
#
# Every finding carries two INDEPENDENT, orthogonal labels:
#
#   bucket   — whose problem this is and WHEN it gets fixed. One of:
#                local-env  a condition on the adopter's own machine or account;
#                           they fix it themselves before setup can proceed.
#                instance   a one-time fix to THIS repository made during install.
#                config     an ongoing configuration setting that lives on past
#                           install.
#
#   severity — HOW BAD it is. One of:
#                block      halts setup / exit 1
#                warn       advisory
#                info       advisory
#
# The bucket and severity are chosen independently — any bucket may pair with
# any severity.
#
# API:
#   finding <bucket> <severity> <message>
#       Validate bucket/severity, emit one formatted line carrying the literal
#       bucket label (e.g. "[local-env]") and a severity glyph matching
#       doctor.sh's visual style. On invalid bucket/severity, print an error to
#       stderr and `return 1` (never exit). On a `block` severity, increment the
#       global FINDINGS_BLOCK_COUNT.
#
#   findings_exit_code
#       Print 1 if any block-severity finding has been emitted, else 0.
#
#   FINDINGS_BLOCK_COUNT
#       Global counter, initialized to 0 at source time.

# Number of block-severity findings emitted so far.
FINDINGS_BLOCK_COUNT=0

# finding <bucket> <severity> <message>
finding() {
  local bucket="$1"
  local severity="$2"
  local message="$3"

  case "$bucket" in
    local-env | instance | config) ;;
    *)
      printf "finding: invalid bucket '%s' (want local-env|instance|config)\n" "$bucket" >&2
      return 1
      ;;
  esac

  local glyph
  case "$severity" in
    block) glyph='\033[31m✗\033[0m' ;;
    warn) glyph='\033[33m!\033[0m' ;;
    info) glyph='\033[36mi\033[0m' ;;
    *)
      printf "finding: invalid severity '%s' (want block|warn|info)\n" "$severity" >&2
      return 1
      ;;
  esac

  if [[ "$severity" == "block" ]]; then
    FINDINGS_BLOCK_COUNT=$((FINDINGS_BLOCK_COUNT + 1))
  fi

  printf "  ${glyph} [%s] %s\n" "$bucket" "$message"
}

# findings_exit_code — print 1 if any block-severity finding was emitted, else 0.
findings_exit_code() {
  if [[ "$FINDINGS_BLOCK_COUNT" -gt 0 ]]; then
    printf '1\n'
  else
    printf '0\n'
  fi
}
