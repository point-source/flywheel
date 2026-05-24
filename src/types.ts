export type IncrementType = "major" | "minor" | "patch" | "none";

export type ReleaseMode = "none" | "prerelease" | "production";

export interface Branch {
  name: string;
  release: ReleaseMode;
  suffix?: string;
  auto_merge: string[];
  // When true, semantic-release creates this branch's GitHub Release as an
  // unpublished draft instead of publishing it immediately, so a separate
  // build workflow can attach artifacts to the release before the publish
  // that makes it immutable. Only valid on release: prerelease and
  // release: production branches. See SPEC §spec:immutable-release-support.
  release_as_draft?: boolean;
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
}

export interface ParsedTitle {
  type: string;
  scope: string | null;
  breaking: boolean;
  description: string;
  raw: string;
}
