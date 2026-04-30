export type IncrementType = "major" | "minor" | "patch" | "none";

export type MergeStrategy = "squash" | "rebase";

export interface Branch {
  name: string;
  prerelease?: string | false;
  auto_merge: string[];
}

export interface Stream {
  name: string;
  branches: Branch[];
}

export interface FlywheelConfig {
  streams: Stream[];
  merge_strategy: MergeStrategy;
  initial_version: string;
  semantic_release_plugins?: unknown[];
}

export interface ParsedTitle {
  type: string;
  scope: string | null;
  breaking: boolean;
  description: string;
  raw: string;
}
