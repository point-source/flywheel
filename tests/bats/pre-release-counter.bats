#!/usr/bin/env bats

load helper.bash

setup() {
  TMP=$(mktemp -d)
  cd "$TMP"
  git init -q
  git config user.email test@example.com
  git config user.name test
  git commit --allow-empty -q -m "init"
}

teardown() {
  cd /
  rm -rf "$TMP"
}

@test "returns 1 when no matching tags exist" {
  run "$SCRIPTS_DIR/pre-release-counter.sh" 1.2.0 dev
  [ "$status" -eq 0 ]
  [ "$output" = "1" ]
}

@test "returns max+1 when dev tags exist" {
  git tag v1.2.0-dev.1
  git tag v1.2.0-dev.2
  git tag v1.2.0-dev.5
  run "$SCRIPTS_DIR/pre-release-counter.sh" 1.2.0 dev
  [ "$status" -eq 0 ]
  [ "$output" = "6" ]
}

@test "dev and rc counters are independent" {
  git tag v1.2.0-dev.3
  git tag v1.2.0-rc.1
  run "$SCRIPTS_DIR/pre-release-counter.sh" 1.2.0 rc
  [ "$status" -eq 0 ]
  [ "$output" = "2" ]
}

@test "counter resets per base version" {
  git tag v1.2.0-dev.7
  run "$SCRIPTS_DIR/pre-release-counter.sh" 1.3.0 dev
  [ "$status" -eq 0 ]
  [ "$output" = "1" ]
}

@test "ignores malformed tag suffixes" {
  git tag v1.2.0-dev.notanumber || true
  git tag v1.2.0-dev.2
  run "$SCRIPTS_DIR/pre-release-counter.sh" 1.2.0 dev
  [ "$status" -eq 0 ]
  [ "$output" = "3" ]
}
