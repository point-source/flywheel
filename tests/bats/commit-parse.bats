#!/usr/bin/env bats

load helper.bash

# Run commit-parse.sh against a stream written to a temp file, since bash
# command substitution strips NUL bytes. Captures stdout in $output.
parse_from_triples() {
  local f
  f=$(mktemp)
  make_commit_stream "$@" > "$f"
  output=$("$SCRIPTS_DIR/commit-parse.sh" --stdin < "$f")
  status=$?
  rm -f "$f"
  return $status
}

@test "parses a plain feat commit" {
  parse_from_triples \
    "abc1234abc1234abc1234abc1234abc1234abc1234" \
    "feat(auth): add OAuth2 PKCE flow" \
    ""
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.[0].type == "feat"'
  echo "$output" | jq -e '.[0].scope == "auth"'
  echo "$output" | jq -e '.[0].description == "add OAuth2 PKCE flow"'
  echo "$output" | jq -e '.[0].breaking == false'
  echo "$output" | jq -e '.[0].valid == true'
}

@test "detects ! breaking suffix" {
  parse_from_triples \
    "bb22ccddbb22ccddbb22ccddbb22ccddbb22ccdd" \
    "refactor!: drop legacy session endpoint" \
    ""
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.[0].type == "refactor"'
  echo "$output" | jq -e '.[0].breaking == true'
}

@test "detects BREAKING CHANGE body footer" {
  parse_from_triples \
    "dd44eeffdd44eeffdd44eeffdd44eeffdd44eeff" \
    "feat: add dashboard widgets" \
    "BREAKING CHANGE: removes the /v1/widgets endpoint"
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.[0].breaking == true'
}

@test "marks non-conventional subjects as invalid" {
  parse_from_triples \
    "ee55ff00ee55ff00ee55ff00ee55ff00ee55ff00" \
    "notaconventionalsubject" \
    ""
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.[0].valid == false'
}

@test "parses multiple commits in order" {
  parse_from_triples \
    "1111111111111111111111111111111111111111" "feat: one"  "" \
    "2222222222222222222222222222222222222222" "fix: two"   "" \
    "3333333333333333333333333333333333333333" "chore: three" ""
  [ "$status" -eq 0 ]
  echo "$output" | jq -e 'length == 3'
  echo "$output" | jq -e '[.[].type] == ["feat","fix","chore"]'
}
