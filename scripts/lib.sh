#!/usr/bin/env bash
# Shared helpers sourced by other scripts. Intentionally small.

set -euo pipefail

log_info() { printf '[info] %s\n' "$*" >&2; }
log_warn() { printf '[warn] %s\n' "$*" >&2; }
log_err()  { printf '[err]  %s\n' "$*" >&2; }

die() {
  log_err "$*"
  exit 1
}

require_var() {
  local name=$1
  if [[ -z "${!name:-}" ]]; then
    die "required variable '$name' is unset or empty"
  fi
}

require_cmd() {
  local cmd=$1
  command -v "$cmd" >/dev/null 2>&1 || die "required command '$cmd' not found on PATH"
}

gha_set_output() {
  local name=$1
  local value=$2
  if [[ -z "${GITHUB_OUTPUT:-}" ]]; then
    printf '%s=%s\n' "$name" "$value"
    return
  fi
  if [[ "$value" == *$'\n'* ]]; then
    local delim
    delim="EOF_$(date +%s%N)"
    {
      printf '%s<<%s\n' "$name" "$delim"
      printf '%s\n' "$value"
      printf '%s\n' "$delim"
    } >> "$GITHUB_OUTPUT"
  else
    printf '%s=%s\n' "$name" "$value" >> "$GITHUB_OUTPUT"
  fi
}
