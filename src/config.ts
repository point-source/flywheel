import yaml from "js-yaml";

import type { Branch, FlywheelConfig, Stream } from "./types.js";
import { ALLOWED_AUTO_MERGE_ENTRIES } from "./conventional.js";

const TOP_LEVEL_KEYS = new Set([
  "streams",
  "merge_strategy",
  "initial_version",
]);

const BRANCH_KEYS = new Set(["name", "prerelease", "auto_merge"]);
const STREAM_KEYS = new Set(["name", "branches"]);
const MERGE_STRATEGIES = new Set(["squash", "rebase"]);

export interface ConfigLoadResult {
  config: FlywheelConfig | null;
  errors: string[];
  warnings: string[];
  notices: string[];
}

export function loadConfig(yamlText: string): ConfigLoadResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const notices: string[] = [];

  let raw: unknown;
  try {
    raw = yaml.load(yamlText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      config: null,
      errors: [`.flywheel.yml: failed to parse YAML — ${msg}`],
      warnings,
      notices,
    };
  }

  if (!isObject(raw) || !isObject(raw.flywheel)) {
    errors.push(".flywheel.yml: expected a top-level `flywheel:` mapping.");
    return { config: null, errors, warnings, notices };
  }

  const root = raw.flywheel as Record<string, unknown>;

  for (const key of Object.keys(root)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      errors.push(
        `flywheel.${key}: unknown key. Allowed keys: ${[...TOP_LEVEL_KEYS].sort().join(", ")}.`,
      );
    }
  }

  const streams = parseStreams(root.streams, errors);
  const mergeStrategy = parseMergeStrategy(root.merge_strategy, errors);
  const initialVersion = parseInitialVersion(root.initial_version, errors);

  if (streams && streams.length > 0) {
    validateStreams(streams, errors, notices);
  }

  if (errors.length > 0) {
    return { config: null, errors, warnings, notices };
  }

  return {
    config: {
      streams: streams!,
      merge_strategy: mergeStrategy,
      initial_version: initialVersion,
    },
    errors,
    warnings,
    notices,
  };
}

function parseStreams(value: unknown, errors: string[]): Stream[] | null {
  if (value === undefined) {
    errors.push("flywheel.streams: required (must be a non-empty list).");
    return null;
  }
  if (!Array.isArray(value) || value.length === 0) {
    errors.push("flywheel.streams: must be a non-empty list of stream objects.");
    return null;
  }

  const streams: Stream[] = [];
  value.forEach((item, idx) => {
    const stream = parseStream(item, idx, errors);
    if (stream) streams.push(stream);
  });
  return streams;
}

function parseStream(value: unknown, idx: number, errors: string[]): Stream | null {
  const path = `flywheel.streams[${idx}]`;
  if (!isObject(value)) {
    errors.push(`${path}: must be an object with name + branches.`);
    return null;
  }
  for (const key of Object.keys(value)) {
    if (!STREAM_KEYS.has(key)) {
      errors.push(
        `${path}.${key}: unknown key. Allowed: ${[...STREAM_KEYS].sort().join(", ")}.`,
      );
    }
  }
  const name = value.name;
  if (typeof name !== "string" || name.length === 0) {
    errors.push(`${path}.name: required string.`);
    return null;
  }
  const rawBranches = value.branches;
  if (!Array.isArray(rawBranches) || rawBranches.length === 0) {
    errors.push(`${path}.branches: must be a non-empty list.`);
    return null;
  }
  const branches: Branch[] = [];
  rawBranches.forEach((b, bIdx) => {
    const branch = parseBranch(b, `${path}.branches[${bIdx}]`, errors);
    if (branch) branches.push(branch);
  });
  if (branches.length === 0) return null;
  return { name, branches };
}

function parseBranch(value: unknown, path: string, errors: string[]): Branch | null {
  if (!isObject(value)) {
    errors.push(`${path}: must be an object with name + auto_merge.`);
    return null;
  }
  for (const key of Object.keys(value)) {
    if (!BRANCH_KEYS.has(key)) {
      errors.push(
        `${path}.${key}: unknown key. Allowed: ${[...BRANCH_KEYS].sort().join(", ")}. ` +
          "(Did you mean `auto_merge` instead of `auto-merge`?)",
      );
    }
  }
  const name = value.name;
  if (typeof name !== "string" || name.length === 0) {
    errors.push(`${path}.name: required string.`);
    return null;
  }

  let prerelease: string | false | undefined;
  if (value.prerelease === undefined || value.prerelease === false) {
    prerelease = false;
  } else if (typeof value.prerelease === "string" && value.prerelease.length > 0) {
    prerelease = value.prerelease;
  } else if (value.prerelease === true) {
    errors.push(
      `${path}.prerelease: must be a non-empty string identifier (e.g. "dev"), false, or absent.`,
    );
    prerelease = false;
  } else {
    errors.push(
      `${path}.prerelease: must be a non-empty string identifier (e.g. "dev"), false, or absent.`,
    );
    prerelease = false;
  }

  const autoMergeRaw = value.auto_merge;
  if (!Array.isArray(autoMergeRaw)) {
    errors.push(
      `${path}.auto_merge: required list (use [] to require human review for all PRs).`,
    );
    return null;
  }
  const autoMerge: string[] = [];
  autoMergeRaw.forEach((entry, eIdx) => {
    if (typeof entry !== "string") {
      errors.push(`${path}.auto_merge[${eIdx}]: must be a string.`);
      return;
    }
    if (!ALLOWED_AUTO_MERGE_ENTRIES.has(entry)) {
      errors.push(
        `${path}.auto_merge[${eIdx}]: "${entry}" is not a recognized conventional commit type. ` +
          "Allowed: feat, fix, chore, refactor, perf, style, test, docs, build, ci, revert (each optionally with `!`).",
      );
      return;
    }
    autoMerge.push(entry);
  });

  return { name, ...(prerelease === false ? {} : { prerelease }), auto_merge: autoMerge };
}

function parseMergeStrategy(value: unknown, errors: string[]) {
  if (value === undefined) return "squash" as const;
  if (typeof value !== "string" || !MERGE_STRATEGIES.has(value)) {
    errors.push(
      `flywheel.merge_strategy: must be "squash" or "rebase" (got ${JSON.stringify(value)}).`,
    );
    return "squash" as const;
  }
  return value as "squash" | "rebase";
}

function parseInitialVersion(value: unknown, errors: string[]): string {
  if (value === undefined) return "0.1.0";
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value)) {
    errors.push(
      `flywheel.initial_version: must be a semver string like "0.1.0" (got ${JSON.stringify(value)}).`,
    );
    return "0.1.0";
  }
  return value;
}

function validateStreams(
  streams: Stream[],
  errors: string[],
  notices: string[],
): void {
  // Rule 0: duplicate stream name.
  const streamNameCounts = new Map<string, number>();
  for (const s of streams) {
    streamNameCounts.set(s.name, (streamNameCounts.get(s.name) ?? 0) + 1);
  }
  for (const [name, count] of streamNameCounts) {
    if (count > 1) {
      errors.push(`duplicate stream name: "${name}".`);
    }
  }

  // Rule 1: branch in >1 stream.
  const branchOwners = new Map<string, string[]>();
  for (const s of streams) {
    for (const b of s.branches) {
      const owners = branchOwners.get(b.name) ?? [];
      owners.push(s.name);
      branchOwners.set(b.name, owners);
    }
  }
  for (const [branch, owners] of branchOwners) {
    if (owners.length > 1) {
      errors.push(
        `branch "${branch}" appears in multiple streams (${owners.join(", ")}). ` +
          "Each branch may belong to exactly one stream.",
      );
    }
  }

  // Rule 1b: same prerelease label used by >1 branch — tags would collide.
  const prereleaseOwners = new Map<string, string[]>();
  for (const s of streams) {
    for (const b of s.branches) {
      if (typeof b.prerelease === "string") {
        const spots = prereleaseOwners.get(b.prerelease) ?? [];
        spots.push(`${s.name}/${b.name}`);
        prereleaseOwners.set(b.prerelease, spots);
      }
    }
  }
  for (const [label, spots] of prereleaseOwners) {
    if (spots.length > 1) {
      errors.push(
        `prerelease label "${label}" used by multiple branches (${spots.join(", ")}) — tags would collide.`,
      );
    }
  }

  // Rule 2: >1 branch with prerelease: false in same stream.
  for (const s of streams) {
    const productionBranches = s.branches.filter(
      (b) => b.prerelease === false || b.prerelease === undefined,
    );
    if (productionBranches.length > 1) {
      errors.push(
        `stream "${s.name}": multiple branches without a prerelease identifier ` +
          `(${productionBranches.map((b) => b.name).join(", ")}). ` +
          "Only the last branch in a stream should be the production release branch.",
      );
    }
  }

  // Rule 3: >1 stream with terminal prerelease: false (corrected to error per §Versioning).
  const productionTerminalStreams = streams.filter((s) => {
    const last = s.branches[s.branches.length - 1];
    return last && (last.prerelease === false || last.prerelease === undefined);
  });
  if (productionTerminalStreams.length > 1) {
    errors.push(
      `multiple streams have a terminal production branch (no prerelease): ` +
        `${productionTerminalStreams.map((s) => s.name).join(", ")}. ` +
        "Tag collision is unavoidable in a single repo. Give all but one stream a `prerelease` identifier on its terminal branch.",
    );
  }

  // Rule 5: single-branch stream → info notice (not error).
  for (const s of streams) {
    if (s.branches.length === 1) {
      notices.push(
        `stream "${s.name}" has only one branch ("${s.branches[0]!.name}"). ` +
          "Pushes will release immediately; no promotion PRs will be created. Confirm this is intentional.",
      );
    }
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
