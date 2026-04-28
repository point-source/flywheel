import { readFileSync, existsSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// Defaults from spec.md §366. The branches default mirrors §103: develop-only,
// optimised for the early-development case before main and staging exist.
const DEFAULT_AUTO_MERGE_TYPES = ['fix', 'chore', 'refactor', 'perf', 'style', 'test'] as const;
const DEFAULT_INITIAL_VERSION = '0.1.0';

const BranchesSchema = z
  .object({
    develop: z.boolean().default(true),
    staging: z.boolean().default(false),
    main: z.boolean().default(false),
  })
  .default({ develop: true, staging: false, main: false });

const WorkflowsSchema = z
  .object({
    build: z.string().default('pipeline-build.yml'),
    publish: z.string().default('pipeline-publish.yml'),
    quality: z.string().default(''),
  })
  .default({});

const PipelineSchema = z.object({
  branches: BranchesSchema,
  merge_strategy: z.enum(['squash', 'merge', 'rebase']).default('squash'),
  auto_merge_types: z.array(z.string()).default([...DEFAULT_AUTO_MERGE_TYPES]),
  publish_on_develop: z.boolean().default(true),
  publish_on_staging: z.boolean().default(true),
  merge_queue: z.union([z.literal('auto'), z.boolean()]).default('auto'),
  workflows: WorkflowsSchema,
});

// `pipeline:` with no value parses to null in YAML; coerce to {} so defaults
// apply rather than failing schema validation.
const RootSchema = z.object({
  pipeline: z.preprocess((v) => v ?? {}, PipelineSchema),
  initial_version: z.string().default(DEFAULT_INITIAL_VERSION),
});

export type Config = z.infer<typeof RootSchema>;

export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Load and validate a `.pipeline.yml` from disk.
 *
 * If the file doesn't exist, returns spec defaults. Per spec §103 ("develop-
 * first" default), this is intentional: a repo with no config still gets
 * develop-only operation without surprising the user.
 */
export function loadConfig(path = '.pipeline.yml'): Config {
  if (!existsSync(path)) {
    return RootSchema.parse({});
  }
  const raw = readFileSync(path, 'utf8');
  return parseConfigText(raw, path);
}

/**
 * Parse and validate raw YAML text. Exposed separately so tests can exercise
 * parsing without writing to disk.
 */
export function parseConfigText(text: string, sourcePath = '<inline>'): Config {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (err) {
    throw new ConfigError(`failed to parse YAML in ${sourcePath}: ${(err as Error).message}`, err);
  }
  // An empty file parses to null/undefined; coerce to {} so defaults apply.
  if (parsed === null || parsed === undefined) {
    return RootSchema.parse({});
  }
  const result = RootSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(
      `invalid .pipeline.yml: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      result.error,
    );
  }
  return result.data;
}

/**
 * Derive the next active branch in the promotion chain (develop → staging → main),
 * skipping disabled branches. Returns null if `source` is the last active
 * branch OR if `source` itself is disabled (a push to a disabled branch is a
 * misconfiguration; we don't synthesize a promotion PR for it).
 *
 * Per spec §75, "the promotion chain is derived automatically from whichever
 * branches are enabled, always in develop → staging → main order through the
 * active set." A disabled branch isn't part of the chain — calling from one
 * is a no-op.
 */
export function nextBranchInChain(
  source: 'develop' | 'staging' | 'main',
  branches: Config['pipeline']['branches'],
): 'staging' | 'main' | null {
  if (!branches[source]) return null;
  if (source === 'develop') {
    if (branches.staging) return 'staging';
    if (branches.main) return 'main';
    return null;
  }
  if (source === 'staging') {
    return branches.main ? 'main' : null;
  }
  // source === 'main' — terminal
  return null;
}
