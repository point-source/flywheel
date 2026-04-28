import { describe, it, expect } from 'vitest';
import { parseConfigText, nextBranchInChain, ConfigError } from './config.js';

describe('parseConfigText > defaults', () => {
  it('produces spec-default config for an empty file', () => {
    const cfg = parseConfigText('');
    expect(cfg.pipeline.branches).toEqual({ develop: true, staging: false, main: false });
    expect(cfg.pipeline.merge_strategy).toBe('squash');
    expect(cfg.pipeline.auto_merge_types).toEqual(['fix', 'chore', 'refactor', 'perf', 'style', 'test']);
    expect(cfg.pipeline.publish_on_develop).toBe(true);
    expect(cfg.pipeline.publish_on_staging).toBe(true);
    expect(cfg.pipeline.merge_queue).toBe('auto');
    expect(cfg.pipeline.workflows.build).toBe('pipeline-build.yml');
    expect(cfg.pipeline.workflows.publish).toBe('pipeline-publish.yml');
    expect(cfg.pipeline.workflows.quality).toBe('');
    expect(cfg.initial_version).toBe('0.1.0');
  });

  it('produces spec-default config for an empty pipeline block', () => {
    const cfg = parseConfigText('pipeline:\n');
    expect(cfg.pipeline.branches.develop).toBe(true);
    expect(cfg.pipeline.merge_strategy).toBe('squash');
  });
});

describe('parseConfigText > overrides', () => {
  it('respects explicitly set branch flags', () => {
    const cfg = parseConfigText(`
pipeline:
  branches:
    develop: false
    staging: true
    main: true
`);
    expect(cfg.pipeline.branches).toEqual({ develop: false, staging: true, main: true });
  });

  it('accepts merge_queue as boolean true / false / "auto"', () => {
    expect(parseConfigText('pipeline:\n  merge_queue: true').pipeline.merge_queue).toBe(true);
    expect(parseConfigText('pipeline:\n  merge_queue: false').pipeline.merge_queue).toBe(false);
    expect(parseConfigText('pipeline:\n  merge_queue: auto').pipeline.merge_queue).toBe('auto');
  });

  it('preserves a custom auto_merge_types list', () => {
    const cfg = parseConfigText(`
pipeline:
  auto_merge_types:
    - fix
    - chore
`);
    expect(cfg.pipeline.auto_merge_types).toEqual(['fix', 'chore']);
  });
});

describe('parseConfigText > failure cases', () => {
  it('throws ConfigError with location info on malformed YAML', () => {
    expect(() => parseConfigText('not: valid:\n  - this: is:: bad', 'test.yml')).toThrow(ConfigError);
  });

  it('throws ConfigError on schema violations', () => {
    expect(() =>
      parseConfigText(`
pipeline:
  merge_strategy: definitely-not-valid
`),
    ).toThrow(/invalid .pipeline.yml/);
  });
});

// Branch topology coverage from the plan (additional tests beyond the 12
// learnings) — every row in spec.md §93 must produce the right next branch.
describe('nextBranchInChain > all 7 supported topologies (spec §93)', () => {
  type Branches = { develop: boolean; staging: boolean; main: boolean };

  const cases: Array<{
    name: string;
    branches: Branches;
    expected: { develop: 'staging' | 'main' | null; staging: 'main' | null };
  }> = [
    // For each topology: what is `next` when called from develop / staging?
    // Sources that aren't in the active set return null (they're not part of
    // the chain).
    {
      name: 'all three (develop+staging+main)',
      branches: { develop: true, staging: true, main: true },
      expected: { develop: 'staging', staging: 'main' },
    },
    {
      name: 'develop+main (skip staging)',
      branches: { develop: true, staging: false, main: true },
      expected: { develop: 'main', staging: null },
    },
    {
      name: 'staging+main only',
      branches: { develop: false, staging: true, main: true },
      expected: { develop: null, staging: 'main' },
    },
    {
      name: 'develop+staging (no main, no prod release)',
      branches: { develop: true, staging: true, main: false },
      expected: { develop: 'staging', staging: null },
    },
    {
      name: 'develop only',
      branches: { develop: true, staging: false, main: false },
      expected: { develop: null, staging: null },
    },
    {
      name: 'main only',
      branches: { develop: false, staging: false, main: true },
      expected: { develop: null, staging: null },
    },
    {
      name: 'staging only',
      branches: { develop: false, staging: true, main: false },
      expected: { develop: null, staging: null },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(nextBranchInChain('develop', c.branches)).toBe(c.expected.develop);
      expect(nextBranchInChain('staging', c.branches)).toBe(c.expected.staging);
      // main is always terminal
      expect(nextBranchInChain('main', c.branches)).toBeNull();
    });
  }
});
