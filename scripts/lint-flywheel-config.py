#!/usr/bin/env python3
# lint-flywheel-config.py — deep-validate a .flywheel.yml.
#
# Reads the YAML file at argv[1] and emits a line-oriented report:
#   BRANCHES <space-separated branch names in declaration order>
#   RESULT OK   <message>
#   RESULT FAIL <message>
#   RESULT WARN <message>
#   RESULT NOTE <message>
#
# The wrapper (scripts/doctor.sh) parses these lines and routes each
# result to its own colored output / fail-count. Always exits 0 — the
# wrapper inspects RESULT FAIL lines to decide overall pass/fail. A
# nonzero exit only indicates the script itself crashed.
import re
import sys

import yaml

VALID_TYPES = {
    "feat", "fix", "chore", "refactor", "perf",
    "style", "test", "docs", "build", "ci", "revert",
}
VALID_AUTO_MERGE_KEYS = VALID_TYPES | {f"{t}!" for t in VALID_TYPES}
VALID_MERGE_STRATEGIES = {"squash", "merge", "rebase"}
SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$")


def emit(status, msg):
    print(f"RESULT {status} {msg}")


def main():
    if len(sys.argv) != 2:
        print("usage: lint-flywheel-config.py <path-to-.flywheel.yml>", file=sys.stderr)
        sys.exit(2)
    path = sys.argv[1]

    with open(path) as f:
        try:
            data = yaml.safe_load(f)
        except yaml.YAMLError as e:
            emit("FAIL", f".flywheel.yml does not parse as YAML: {e}")
            print("BRANCHES ")
            return

    if not isinstance(data, dict) or "flywheel" not in data:
        emit("FAIL", ".flywheel.yml missing top-level 'flywheel:' key")
        print("BRANCHES ")
        return

    root = data["flywheel"]
    streams = root.get("streams") or []
    if not streams:
        emit("FAIL", ".flywheel.yml has no streams[]")
        print("BRANCHES ")
        return

    all_branches = []
    branch_to_streams = {}
    prerelease_to_branches = {}
    stream_names = []

    for s_idx, s in enumerate(streams):
        sname = s.get("name") or f"<unnamed stream #{s_idx}>"
        stream_names.append(sname)
        sbranches = s.get("branches") or []
        if not sbranches:
            emit("FAIL", f"stream {sname!r} has no branches")
            continue
        for b_idx, b in enumerate(sbranches):
            bname = b.get("name")
            if not bname:
                emit("FAIL", f"stream {sname!r} branch #{b_idx} missing 'name'")
                continue
            all_branches.append(bname)
            branch_to_streams.setdefault(bname, []).append(sname)
            prerelease = b.get("prerelease")
            if prerelease:
                prerelease_to_branches.setdefault(prerelease, []).append((sname, bname))
            am = b.get("auto_merge", [])
            if not isinstance(am, list):
                emit("FAIL", f"branch {bname!r} auto_merge must be a list")
            else:
                for entry in am:
                    if entry not in VALID_AUTO_MERGE_KEYS:
                        emit("FAIL", f"branch {bname!r} auto_merge contains unrecognized type {entry!r}")
            if b_idx == len(sbranches) - 1 and len(sbranches) > 1:
                emit("NOTE", f"branch {bname!r} is the terminal branch of stream {sname!r} (releases on push, no auto-promotion)")

    seen = set()
    for n in stream_names:
        if n in seen:
            emit("FAIL", f"duplicate stream name: {n!r}")
        seen.add(n)

    for bname, slist in branch_to_streams.items():
        if len(slist) > 1:
            emit("FAIL", f"branch {bname!r} listed in multiple streams: {', '.join(slist)} — branches must belong to exactly one stream")

    for label, occurrences in prerelease_to_branches.items():
        if len(occurrences) > 1:
            spots = ", ".join(f"{s}/{b}" for s, b in occurrences)
            emit("FAIL", f"prerelease label {label!r} used by multiple branches ({spots}) — tags would collide")

    ms = root.get("merge_strategy")
    if ms is None:
        emit("WARN", "merge_strategy not set — explicit is safer")
    elif ms not in VALID_MERGE_STRATEGIES:
        emit("FAIL", f"merge_strategy {ms!r} invalid — must be one of {', '.join(sorted(VALID_MERGE_STRATEGIES))}")

    iv = root.get("initial_version")
    if iv is None:
        emit("WARN", "initial_version not set — Flywheel will default to 0.1.0")
    elif not isinstance(iv, str) or not SEMVER_RE.match(iv):
        emit("FAIL", f"initial_version {iv!r} is not valid semver (e.g. '0.1.0')")

    print("BRANCHES " + " ".join(all_branches))


if __name__ == "__main__":
    main()
