#!/usr/bin/env bats

load helper.bash

@test "breaking change -> major" {
  json='[{"type":"feat","breaking":true,"valid":true}]'
  run bash -c "echo '$json' | $SCRIPTS_DIR/version-bump.sh -"
  [ "$status" -eq 0 ]
  [ "$output" = "major" ]
}

@test "feat only -> minor" {
  json='[{"type":"feat","breaking":false,"valid":true},{"type":"chore","breaking":false,"valid":true}]'
  run bash -c "echo '$json' | $SCRIPTS_DIR/version-bump.sh -"
  [ "$status" -eq 0 ]
  [ "$output" = "minor" ]
}

@test "fix or perf -> patch" {
  json='[{"type":"fix","breaking":false,"valid":true}]'
  run bash -c "echo '$json' | $SCRIPTS_DIR/version-bump.sh -"
  [ "$status" -eq 0 ]
  [ "$output" = "patch" ]

  json='[{"type":"perf","breaking":false,"valid":true}]'
  run bash -c "echo '$json' | $SCRIPTS_DIR/version-bump.sh -"
  [ "$status" -eq 0 ]
  [ "$output" = "patch" ]
}

@test "chore/style/test/refactor/docs only -> none" {
  json='[{"type":"chore","breaking":false,"valid":true},{"type":"style","breaking":false,"valid":true},{"type":"refactor","breaking":false,"valid":true},{"type":"docs","breaking":false,"valid":true},{"type":"test","breaking":false,"valid":true}]'
  run bash -c "echo '$json' | $SCRIPTS_DIR/version-bump.sh -"
  [ "$status" -eq 0 ]
  [ "$output" = "none" ]
}

@test "breaking wins over feat wins over fix" {
  json='[{"type":"fix","breaking":false,"valid":true},{"type":"feat","breaking":false,"valid":true},{"type":"refactor","breaking":true,"valid":true}]'
  run bash -c "echo '$json' | $SCRIPTS_DIR/version-bump.sh -"
  [ "$status" -eq 0 ]
  [ "$output" = "major" ]
}
