export type IncrementType = "major" | "minor" | "patch" | "none";

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

export interface ReleaseFileDeclarative {
  path: string;
  pattern: string;
  replacement: string;
}

export interface ReleaseFileExec {
  path: string;
  cmd: string;
}

export type ReleaseFile = ReleaseFileDeclarative | ReleaseFileExec;

export interface FlywheelConfig {
  streams: Stream[];
  release_files?: ReleaseFile[];
  // When true, releases are created as unpublished GitHub Drafts instead of
  // being published immediately, so a separate build workflow can attach
  // artifacts to the release before it becomes immutable. See
  // SPEC §spec:immutable-release-support.
  release_as_draft?: boolean;
}

export interface ParsedTitle {
  type: string;
  scope: string | null;
  breaking: boolean;
  description: string;
  raw: string;
}
