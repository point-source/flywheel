export type PermissionLevel = "read" | "write";

export interface RequiredPermission {
  name: string;
  level: PermissionLevel;
  reason: string;
}

export const REQUIRED_PERMISSIONS: RequiredPermission[] = [
  { name: "contents", level: "write", reason: "tag creation, semantic-release CHANGELOG push" },
  { name: "pull_requests", level: "write", reason: "PR creation, body updates, native auto-merge enabling" },
  { name: "issues", level: "write", reason: "adding / removing flywheel:* labels on PRs" },
  { name: "checks", level: "write", reason: "posting flywheel/conventional-commit check on invalid titles" },
  { name: "metadata", level: "read", reason: "required for any token interacting with a repo" },
];

export interface MissingPermission {
  name: string;
  required: PermissionLevel;
  granted: PermissionLevel | "none";
  reason: string;
}

export function findMissingPermissions(
  granted: Record<string, string>,
  required: RequiredPermission[] = REQUIRED_PERMISSIONS,
): MissingPermission[] {
  const missing: MissingPermission[] = [];
  for (const req of required) {
    const got = granted[req.name];
    if (got === undefined) {
      missing.push({ name: req.name, required: req.level, granted: "none", reason: req.reason });
    } else if (req.level === "write" && got !== "write") {
      missing.push({
        name: req.name,
        required: req.level,
        granted: got === "read" || got === "write" ? got : "none",
        reason: req.reason,
      });
    }
  }
  return missing;
}

export function formatMissingPermissionsError(
  missing: MissingPermission[],
  appSlug: string | null,
  repoFullName: string,
): string {
  const lines = [
    `Flywheel: missing or insufficient App permissions on ${repoFullName}.`,
    "",
    "Missing:",
  ];
  for (const m of missing) {
    lines.push(`  - ${m.name}: need ${m.required}, granted ${m.granted} — ${m.reason}`);
  }
  lines.push("");
  if (appSlug) {
    lines.push(`Update the App's permissions:`);
    lines.push(`  https://github.com/settings/apps/${appSlug}/permissions`);
    lines.push(`(or for org-owned Apps: https://github.com/organizations/<org>/settings/apps/${appSlug}/permissions)`);
  } else {
    lines.push("Update the App's permissions in its settings page on GitHub.");
  }
  lines.push("");
  lines.push("After updating, each App installation must accept the new permissions before they take effect.");
  return lines.join("\n");
}
