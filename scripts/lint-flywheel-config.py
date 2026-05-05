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
import sys

import yaml

VALID_TYPES = {
    "feat", "fix", "chore", "refactor", "perf",
    "style", "test", "docs", "build", "ci", "revert",
}
VALID_AUTO_MERGE_KEYS = VALID_TYPES | {f"{t}!" for t in VALID_TYPES}
VALID_MERGE_STRATEGIES = {"squash", "rebase"}
VALID_TOP_LEVEL_KEYS = {"streams", "merge_strategy"}
VALID_STREAM_KEYS = {"name", "branches"}
VALID_BRANCH_KEYS = {"name", "release", "suffix", "auto_merge"}
VALID_RELEASE_MODES = {"none", "prerelease", "production"}


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
    for k in root:
        if k not in VALID_TOP_LEVEL_KEYS:
            emit("FAIL", f"flywheel.{k}: unknown key — allowed: {', '.join(sorted(VALID_TOP_LEVEL_KEYS))}")
    streams = root.get("streams") or []
    if not streams:
        emit("FAIL", ".flywheel.yml has no streams[]")
        print("BRANCHES ")
        return

    all_branches = []
    branch_to_streams = {}
    suffix_to_branches = {}
    stream_names = []
    production_terminal_streams = []

    for s_idx, s in enumerate(streams):
        if isinstance(s, dict):
            for k in s:
                if k not in VALID_STREAM_KEYS:
                    emit("FAIL", f"stream #{s_idx}.{k}: unknown key — allowed: {', '.join(sorted(VALID_STREAM_KEYS))}")
        sname = s.get("name") or f"<unnamed stream #{s_idx}>"
        stream_names.append(sname)
        sbranches = s.get("branches") or []
        if not sbranches:
            emit("FAIL", f"stream {sname!r} has no branches")
            continue
        production_in_stream = []
        for b_idx, b in enumerate(sbranches):
            if isinstance(b, dict):
                for k in b:
                    if k not in VALID_BRANCH_KEYS:
                        emit("FAIL", f"stream {sname!r} branch #{b_idx}.{k}: unknown key — allowed: {', '.join(sorted(VALID_BRANCH_KEYS))} (did you mean 'auto_merge' instead of 'auto-merge'?)")
            bname = b.get("name")
            if not bname:
                emit("FAIL", f"stream {sname!r} branch #{b_idx} missing 'name'")
                continue
            all_branches.append(bname)
            branch_to_streams.setdefault(bname, []).append(sname)
            release = b.get("release")
            suffix = b.get("suffix")
            if release is None:
                emit("FAIL", f"branch {bname!r}: release is required — allowed: {', '.join(sorted(VALID_RELEASE_MODES))}")
            elif release not in VALID_RELEASE_MODES:
                emit("FAIL", f"branch {bname!r}: release {release!r} invalid — must be one of {', '.join(sorted(VALID_RELEASE_MODES))}")
            else:
                if release == "prerelease":
                    if suffix is None:
                        emit("FAIL", f"branch {bname!r}: suffix is required when release is 'prerelease'")
                    elif not isinstance(suffix, str) or not suffix:
                        emit("FAIL", f"branch {bname!r}: suffix must be a non-empty string identifier (e.g. 'dev')")
                    else:
                        suffix_to_branches.setdefault(suffix, []).append((sname, bname))
                else:
                    if suffix is not None:
                        emit("FAIL", f"branch {bname!r}: suffix is only valid when release is 'prerelease' (got release: {release!r})")
                    if release == "production":
                        production_in_stream.append(bname)
            am = b.get("auto_merge", [])
            if not isinstance(am, list):
                emit("FAIL", f"branch {bname!r} auto_merge must be a list")
            else:
                for entry in am:
                    if entry not in VALID_AUTO_MERGE_KEYS:
                        emit("FAIL", f"branch {bname!r} auto_merge contains unrecognized type {entry!r}")
            if b_idx == len(sbranches) - 1 and len(sbranches) > 1:
                emit("NOTE", f"branch {bname!r} is the terminal branch of stream {sname!r} (releases on push, no auto-promotion)")
        if len(production_in_stream) > 1:
            emit("FAIL", f"stream {sname!r}: multiple production branches ({', '.join(production_in_stream)}) — only the last branch in a stream should be the production release branch")
        terminal = sbranches[-1] if sbranches else None
        if terminal:
            terminal_release = terminal.get("release")
            if terminal_release == "production":
                production_terminal_streams.append(sname)
            elif terminal_release == "none":
                tname = terminal.get("name", "<unnamed>")
                emit("FAIL", f"stream {sname!r}: terminal branch {tname!r} has release: none — the terminal branch must be release: prerelease or release: production")

    if len(production_terminal_streams) > 1:
        emit("FAIL", f"multiple streams have a terminal production branch: {', '.join(production_terminal_streams)} — tag collision is unavoidable in a single repo, give all but one stream a prerelease terminal branch")

    seen = set()
    for n in stream_names:
        if n in seen:
            emit("FAIL", f"duplicate stream name: {n!r}")
        seen.add(n)

    for bname, slist in branch_to_streams.items():
        if len(slist) > 1:
            emit("FAIL", f"branch {bname!r} listed in multiple streams: {', '.join(slist)} — branches must belong to exactly one stream")

    for label, occurrences in suffix_to_branches.items():
        if len(occurrences) > 1:
            spots = ", ".join(f"{s}/{b}" for s, b in occurrences)
            emit("FAIL", f"suffix {label!r} used by multiple prerelease branches ({spots}) — tags would collide")

    ms = root.get("merge_strategy")
    if ms is None:
        emit("WARN", "merge_strategy not set — explicit is safer")
    elif ms not in VALID_MERGE_STRATEGIES:
        emit("FAIL", f"merge_strategy {ms!r} invalid — must be one of {', '.join(sorted(VALID_MERGE_STRATEGIES))}")

    print("BRANCHES " + " ".join(all_branches))


if __name__ == "__main__":
    main()
