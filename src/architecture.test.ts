import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

const WORKFLOWS_DIR = join(process.cwd(), '.github/workflows');
const TEMPLATES_DIR = join(process.cwd(), 'templates');

// Learning #12: cross-repo composite-action references regress when
// `./.github/actions/X` is reintroduced. The rewrite's whole point is one
// `uses: ./.swarmflow` per workflow (the bundled-action checkout pattern).
// Static check: if orchestrator.yml references `./.github/actions/`, fail.
const OWNED_REUSABLE = ['orchestrator.yml'];

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

  // Orchestrator runs all three commands as STEPS in one job. Each step is
  // a `uses: ./.swarmflow` invocation. Plus one for the swarmflow checkout.
  it('orchestrator dispatches each command via uses: ./.swarmflow steps', () => {
    const content = readFileSync(join(WORKFLOWS_DIR, 'orchestrator.yml'), 'utf8');
    const matches = content.match(/uses:\s*\.\/\.swarmflow\b/g) ?? [];
    // One step per command (pr-lifecycle, promote, release) — three.
    expect(matches.length).toBe(3);
  });
});

// Single-job orchestrator: per-job `if:` filtering (the previous design)
// reports SKIPPED check_runs on the PR, which GitHub treats as
// `mergeStateStatus: UNSTABLE` and refuses `enablePullRequestAutoMerge`.
// Step-level filtering produces NO check_runs for unmatched branches.
describe('architecture > orchestrator uses a single job with step-level if filters', () => {
  it('orchestrator declares exactly one job', () => {
    const raw = parseYaml(readFileSync(join(WORKFLOWS_DIR, 'orchestrator.yml'), 'utf8')) as {
      jobs?: Record<string, unknown>;
    };
    expect(Object.keys(raw.jobs ?? {})).toHaveLength(1);
  });

  it('command-dispatch steps use step-level `if:` filters (not job-level)', () => {
    const content = readFileSync(join(WORKFLOWS_DIR, 'orchestrator.yml'), 'utf8');
    // The three command steps each have an `if:` line.
    const stepIfs = content.match(/^\s+if:\s+inputs\.event_type/gm) ?? [];
    expect(stepIfs.length).toBeGreaterThanOrEqual(3);
  });
});

// Learning #9: GitHub validates workflow_call permissions eagerly at load
// time. The caller (entrypoint template) must grant the UNION of permissions
// the orchestrator could need across all command paths. Removing any
// permission causes a startup_failure even on events that don't need it.
//
// Snapshot the orchestrator's permissions block here so any future addition
// forces a corresponding update in the templates.
describe('architecture > permissions union (learning #9)', () => {
  function readPermissions(file: string): Record<string, string> {
    const raw = parseYaml(readFileSync(file, 'utf8')) as { permissions?: Record<string, string> };
    return raw.permissions ?? {};
  }

  it('templates declare the union of orchestrator permissions', () => {
    const orchPerms = readPermissions(join(WORKFLOWS_DIR, 'orchestrator.yml'));
    for (const tpl of ['on-pr.yml', 'on-push.yml']) {
      const tplPerms = readPermissions(join(TEMPLATES_DIR, tpl));
      for (const [scope, level] of Object.entries(orchPerms)) {
        expect(tplPerms[scope], `${tpl} must grant ${scope}`).toBe(level);
      }
    }
  });

  it('matches the expected snapshot of the permissions union', () => {
    const orchPerms = readPermissions(join(WORKFLOWS_DIR, 'orchestrator.yml'));
    expect(orchPerms).toEqual({
      actions: 'write',
      checks: 'write',
      contents: 'write',
      'pull-requests': 'write',
    });
  });
});

// Sanity: the orchestrator pins a swarmflow_repo / swarmflow_ref pair with
// sane defaults. This is the override point e2e uses to test pre-merge SHAs.
describe('architecture > swarmflow override inputs are present and defaulted', () => {
  it('orchestrator declares swarmflow_repo and swarmflow_ref with defaults', () => {
    const content = readFileSync(join(WORKFLOWS_DIR, 'orchestrator.yml'), 'utf8');
    expect(content).toMatch(/swarmflow_repo:/);
    expect(content).toMatch(/default:\s*point-source\/swarmflow/);
    expect(content).toMatch(/swarmflow_ref:/);
    expect(content).toMatch(/default:\s*v1\b/);
  });
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
