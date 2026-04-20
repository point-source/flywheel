#!/usr/bin/env bats

load helper.bash

@test "feature mode: renders bump signal without version" {
  json='[{"sha":"abc1234abc1234","type":"feat","scope":"auth","description":"add OAuth2 PKCE flow","breaking":false,"valid":true},{"sha":"def5678def5678","type":"fix","scope":"","description":"handle token refresh race","breaking":false,"valid":true}]'
  run bash -c "echo '$json' | $SCRIPTS_DIR/pr-body.sh - --bump minor --target develop --checks 'passed'"
  [ "$status" -eq 0 ]
  echo "$output" | grep -q "## Changes"
  echo "$output" | grep -q "### feat"
  echo "$output" | grep -q "### fix"
  echo "$output" | grep -q "\\*\\*auth:\\*\\* add OAuth2 PKCE flow (abc1234)"
  echo "$output" | grep -q "\\*\\*Version bump:\\*\\* minor"
  echo "$output" | grep -q "\\*\\*Target:\\*\\* develop"
  echo "$output" | grep -q "\\*\\*Quality checks:\\*\\* passed"
  ! echo "$output" | grep -q "^\\*\\*Version:\\*\\*"
}

@test "promotion mode: shows version instead of bump" {
  json='[{"sha":"abc1234abc1234","type":"feat","scope":"","description":"thing","breaking":false,"valid":true}]'
  run bash -c "echo '$json' | $SCRIPTS_DIR/pr-body.sh - --bump minor --target main --version 1.3.0-rc.1 --mode promotion"
  [ "$status" -eq 0 ]
  echo "$output" | grep -q "\\*\\*Version:\\*\\* \`1.3.0-rc.1\`"
  ! echo "$output" | grep -q "\\*\\*Version bump:"
}

@test "marks breaking commits in the list" {
  json='[{"sha":"bb22ccddbb22ccdd","type":"refactor","scope":"","description":"drop legacy","breaking":true,"valid":true}]'
  run bash -c "echo '$json' | $SCRIPTS_DIR/pr-body.sh - --bump major --target develop"
  [ "$status" -eq 0 ]
  echo "$output" | grep -q "drop legacy (bb22ccd) \\*\\*BREAKING\\*\\*"
}

@test "handles empty commit set gracefully" {
  run bash -c "echo '[]' | $SCRIPTS_DIR/pr-body.sh - --bump none --target develop"
  [ "$status" -eq 0 ]
  echo "$output" | grep -q "_No conventional commits detected._"
}
