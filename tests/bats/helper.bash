# Common helpers for bats tests.

REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
SCRIPTS_DIR="$REPO_ROOT/scripts"

# Build the NUL-delimited commit stream consumed by commit-parse.sh --stdin.
# Args: <sha> <subject> <body>  (repeated in triples)
make_commit_stream() {
  local sha subject body
  while (( $# >= 3 )); do
    sha=$1 subject=$2 body=$3
    printf '%s\x1f%s\x1e%s\x00' "$sha" "$subject" "$body"
    shift 3
  done
}
