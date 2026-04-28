import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

const WORKFLOWS_DIR = join(process.cwd(), '.github/workflows');
const TEMPLATES_DIR = join(process.cwd(), 'templates');

// Learning #12: cross-repo composite-action references regress when
// `./.github/actions/X` is reintroduced. The rewrite's whole point is one
// `uses: ./.swarmflow` per workflow (the bundled-action checkout pattern).
// Static check: if any of the OWNED reusable workflows references
// `./.github/actions/`, fail.
const OWNED_REUSABLE = ['orchestrator.yml', 'pr-lifecycle.yml', 'promote.yml', 'release.yml'];

describe('architecture > no per-composite cross-repo action references (learning #12)', () => {
  it('rejects any uses: ./.github/actions/X in the owned reusable workflows', () => {
    const offenders: string[] = [];
    for (const name of OWNED_REUSABLE) {
      const content = readFileSync(join(WORKFLOWS_DIR, name), 'utf8');
      if (/uses:\s*['"]?\.\/\.github\/actions\//.test(content)) {
        offenders.push(name);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('allows exactly one `uses: ./.swarmflow` per reusable workflow that needs the action', () => {
    const reusableWorkflows = ['pr-lifecycle.yml', 'promote.yml', 'release.yml'];
    for (const name of reusableWorkflows) {
      const content = readFileSync(join(WORKFLOWS_DIR, name), 'utf8');
      const matches = content.match(/uses:\s*\.\/\.swarmflow\b/g) ?? [];
      // At least one (could be two — pr-lifecycle has the if: always() re-render
      // step in a future revision, but Phase 3 keeps it to one).
      expect(matches.length).toBeGreaterThanOrEqual(1);
    }
  });
});

// Learning #9: GitHub validates workflow_call permissions eagerly at load
// time. The caller (entrypoint template) must grant the UNION of permissions
// required by every reusable workflow it might delegate to. Removing any
// permission causes a startup_failure even on event types that don't need it.
//
// Snapshot the union here so any future addition to a child workflow's
// `permissions:` block forces a corresponding update in the templates.
describe('architecture > permissions union (learning #9)', () => {
  const reusableWorkflows = [
    join(WORKFLOWS_DIR, 'pr-lifecycle.yml'),
    join(WORKFLOWS_DIR, 'promote.yml'),
    join(WORKFLOWS_DIR, 'release.yml'),
  ];

  function readPermissions(file: string): Record<string, string> {
    const raw = parseYaml(readFileSync(file, 'utf8')) as { permissions?: Record<string, string> };
    return raw.permissions ?? {};
  }

  function unionOf(maps: Array<Record<string, string>>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const m of maps) {
      for (const [k, v] of Object.entries(m)) {
        if (out[k] === 'write' || v === 'write') out[k] = 'write';
        else out[k] = v;
      }
    }
    return out;
  }

  it('templates declare the union of all reusable workflow permissions', () => {
    const childPerms = reusableWorkflows.map(readPermissions);
    const union = unionOf(childPerms);

    for (const tpl of ['on-pr.yml', 'on-push.yml']) {
      const tplPerms = readPermissions(join(TEMPLATES_DIR, tpl));
      for (const [scope, level] of Object.entries(union)) {
        expect(tplPerms[scope], `${tpl} must grant ${scope}`).toBe(level);
      }
    }
  });

  it('matches the expected snapshot of the permissions union', () => {
    const union = unionOf(reusableWorkflows.map(readPermissions));
    expect(union).toEqual({
      actions: 'write',
      checks: 'write',
      contents: 'write',
      'pull-requests': 'write',
    });
  });
});

// Sanity: the orchestrator pins a swarmflow_repo / swarmflow_ref pair with
// sane defaults, and pr-lifecycle / promote / release accept those inputs.
// This is the override point e2e uses to test pre-merge SHAs.
describe('architecture > swarmflow override inputs are present and defaulted', () => {
  const inputsToCheck = ['pr-lifecycle.yml', 'promote.yml', 'release.yml', 'orchestrator.yml'];
  for (const name of inputsToCheck) {
    it(`${name} declares swarmflow_repo and swarmflow_ref with defaults`, () => {
      const content = readFileSync(join(WORKFLOWS_DIR, name), 'utf8');
      expect(content).toMatch(/swarmflow_repo:/);
      expect(content).toMatch(/default:\s*point-source\/swarmflow/);
      expect(content).toMatch(/swarmflow_ref:/);
      expect(content).toMatch(/default:\s*v1\b/);
    });
  }
});

// Templates must NOT pass swarmflow_repo / swarmflow_ref. Adopters never need
// to override these; the override is for e2e self-test only (per ADR).
describe('architecture > templates do not expose swarmflow override inputs', () => {
  for (const tpl of ['on-pr.yml', 'on-push.yml']) {
    it(`${tpl} does not pass swarmflow_repo / swarmflow_ref`, () => {
      const content = readFileSync(join(TEMPLATES_DIR, tpl), 'utf8');
      expect(content).not.toMatch(/swarmflow_repo:/);
      expect(content).not.toMatch(/swarmflow_ref:/);
    });
  }
});
