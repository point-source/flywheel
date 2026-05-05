export type IncrementType = "major" | "minor" | "patch" | "none";

export type MergeStrategy = "squash" | "rebase";

export type ReleaseMode = "none" | "prerelease" | "production";

export interface Branch {
  name: string;
  release: ReleaseMode;
  suffix?: string;
  auto_merge: string[];
}

export interface Stream {
  name: string;
  branches: Branch[];
}

export interface FlywheelConfig {
  streams: Stream[];
  merge_strategy: MergeStrategy;
}

export interface ParsedTitle {
  type: string;
  scope: string | null;
  breaking: boolean;
  description: string;
  raw: string;
}
