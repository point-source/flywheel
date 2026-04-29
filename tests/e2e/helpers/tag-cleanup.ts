import { deleteTag, listTagsMatching, type TagSummary } from "./sandbox-e2e.js";

export interface TagBaseline {
  prefix: string;
  names: Set<string>;
}

export async function snapshotTags(prefix: string): Promise<TagBaseline> {
  const tags = await listTagsMatching(prefix);
  return { prefix, names: new Set(tags.map((t) => t.name)) };
}

export async function diffNewTags(baseline: TagBaseline): Promise<TagSummary[]> {
  const current = await listTagsMatching(baseline.prefix);
  return current.filter((t) => !baseline.names.has(t.name));
}

export async function cleanupNewTags(baseline: TagBaseline): Promise<string[]> {
  const newTags = await diffNewTags(baseline);
  for (const t of newTags) {
    await deleteTag(t.name);
  }
  return newTags.map((t) => t.name);
}
