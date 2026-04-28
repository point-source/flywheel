import { describe, it, expect } from 'vitest';
import { parseCommits } from './commits.js';
import { renderFeatureBody, renderPromotionBody } from './pr-body.js';

const c = (sha: string, message: string) => ({ sha, message });

describe('renderFeatureBody', () => {
  it('groups commits by type and includes 7-char SHAs', () => {
    const commits = parseCommits([
      c('aaaaaaa1111', 'fix: handle null'),
      c('bbbbbbb2222', 'fix(auth): refresh token'),
      c('ccccccc3333', 'feat: new flow'),
    ]);
    const body = renderFeatureBody({
      commits,
      bump: 'minor',
      target: 'develop',
      quality: 'pending',
    });
    expect(body).toContain('### feat');
    expect(body).toContain('### fix');
    expect(body).toContain('(aaaaaaa)');
    expect(body).toContain('**auth:**');
    expect(body).toContain('**Version bump:** minor');
    expect(body).toContain('**Target:** develop');
    expect(body).toContain('**Quality checks:** pending');
  });

  it('formats passed/failed quality with emoji markers', () => {
    const commits = parseCommits([c('a', 'fix: bug')]);
    expect(renderFeatureBody({ commits, bump: 'patch', target: 'main', quality: 'passed' }))
      .toContain('**Quality checks:** ✅ passed');
    expect(renderFeatureBody({ commits, bump: 'patch', target: 'main', quality: 'failed' }))
      .toContain('**Quality checks:** ❌ failed');
  });

  it('marks breaking changes with the BREAKING marker', () => {
    const commits = parseCommits([c('a1', 'feat!: drop legacy auth')]);
    const body = renderFeatureBody({ commits, bump: 'major', target: 'main', quality: 'passed' });
    expect(body).toContain('[⚠ BREAKING]');
  });

  // Learning #6: only emit the quality line when a quality workflow is
  // actually configured. quality === undefined means no workflow.
  it('omits the quality line entirely when quality is undefined', () => {
    const commits = parseCommits([c('a', 'fix: bug')]);
    const body = renderFeatureBody({
      commits,
      bump: 'patch',
      target: 'develop',
      quality: undefined,
    });
    expect(body).not.toContain('Quality checks');
  });

  it('orders types canonically (feat before fix before chore)', () => {
    const commits = parseCommits([
      c('a', 'chore: deps'),
      c('b', 'fix: bug'),
      c('c', 'feat: thing'),
    ]);
    const body = renderFeatureBody({ commits, bump: 'minor', target: 'develop', quality: 'pending' });
    const featIdx = body.indexOf('### feat');
    const fixIdx = body.indexOf('### fix');
    const choreIdx = body.indexOf('### chore');
    expect(featIdx).toBeLessThan(fixIdx);
    expect(fixIdx).toBeLessThan(choreIdx);
  });
});

describe('renderPromotionBody', () => {
  it('includes the version (promotions know their version, unlike feature PRs)', () => {
    const commits = parseCommits([c('a', 'feat: new')]);
    const body = renderPromotionBody({
      commits,
      bump: 'minor',
      source: 'develop',
      target: 'staging',
      version: '1.3.0-rc.1',
    });
    expect(body).toContain('## Promote develop → staging');
    expect(body).toContain('**Version:** v1.3.0-rc.1');
    expect(body).toContain('**Bump:** minor');
  });
});
