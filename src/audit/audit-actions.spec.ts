import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { ApplicationStatusPolicy } from '../bounties/application-status';
import { BountyStatus, BountyStatusPolicy } from '../bounties/bounty-status';
import { SubmissionDecision } from '../bounties/submission-status';
import { CohortApplicationPolicy } from '../cohorts/cohort-status';
import { listSourceFiles } from '../test-support/source-files';
import { AUDIT_ACTIONS, SCRIPT_AUDIT_ACTIONS } from './audit-actions';

/**
 * 감사 action 카탈로그(audit-actions.ts)의 정적 가드. 호출부의 오타·새 이름은 AuditService.record()의 타입이 막고,
 * 이 스펙은 카탈로그 쪽의 드리프트를 막는다: 아무도 남기지 않는 죽은 항목, 동적 이름(`BOUNTY_${to}` 등)의 빠진 값,
 * docs/api-contract.md 표와의 불일치, 스크립트에서 사라진 스크립트 action.
 */
const SRC_ROOT = join(__dirname, '..');
const REPO_ROOT = join(SRC_ROOT, '..');

/** 템플릿으로 만드는 action - 정책 파일의 값 집합에서 그대로 만든다 */
function dynamicActions(): string[] {
  const transitionTargets = new Set(Object.values(BountyStatus).flatMap((from) => BountyStatusPolicy.transitionsFrom(from)));
  return [
    ...[...transitionTargets].map((to) => `BOUNTY_${to}`),
    ...Object.values(SubmissionDecision).map((decision) => `SUBMISSION_${decision}`),
    ...ApplicationStatusPolicy.reviewDecisions().map((decision) => `APPLICATION_${decision}`),
    ...CohortApplicationPolicy.reviewDecisions().map((decision) => `COHORT_APPLICATION_${decision}`),
  ];
}

describe('audit action catalog', () => {
  it('every dynamically built action (bounty transition, submission/application/cohort decision) is in the catalog', () => {
    expect(dynamicActions().filter((action) => !Object.hasOwn(AUDIT_ACTIONS, action))).toEqual([]);
  });

  it('every catalog action is written somewhere in src (a quoted literal) or built dynamically - no dead entries', () => {
    const sources = listSourceFiles(SRC_ROOT)
      .filter((file) => !file.endsWith(join('audit', 'audit-actions.ts')))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    const dynamic = new Set(dynamicActions());
    const dead = Object.keys(AUDIT_ACTIONS).filter((action) => !dynamic.has(action) && !sources.includes(`'${action}'`));
    expect(dead).toEqual([]);
  });

  it('server and script catalogs do not overlap, and every script action still appears in scripts/*.js or docs/runbook.md', () => {
    expect(Object.keys(SCRIPT_AUDIT_ACTIONS).filter((action) => Object.hasOwn(AUDIT_ACTIONS, action))).toEqual([]);
    const scriptsDir = join(REPO_ROOT, 'scripts');
    const scripts = readdirSync(scriptsDir).filter((name) => name.endsWith('.js'))
      .map((name) => readFileSync(join(scriptsDir, name), 'utf8')).join('\n');
    const runbook = readFileSync(join(REPO_ROOT, 'docs', 'runbook.md'), 'utf8');
    const missing = Object.keys(SCRIPT_AUDIT_ACTIONS).filter((action) => !scripts.includes(`'${action}'`) && !runbook.includes(`'${action}'`));
    expect(missing).toEqual([]);
  });

  it('docs/api-contract.md "감사 action 카탈로그" table lists exactly the catalog, with the same entity_type', () => {
    const doc = readFileSync(join(REPO_ROOT, 'docs', 'api-contract.md'), 'utf8');
    const start = doc.indexOf('### 감사 action 카탈로그');
    expect(start).toBeGreaterThan(-1);
    const section = doc.slice(start, doc.indexOf('\n#', start + 1) === -1 ? undefined : doc.indexOf('\n#', start + 1));
    const documented = Object.fromEntries(
      [...section.matchAll(/^\| `([A-Z_]+)` \| `([a-z_]+)` \|/gm)].map((m) => [m[1], m[2]]),
    );
    expect(documented).toEqual({ ...AUDIT_ACTIONS, ...SCRIPT_AUDIT_ACTIONS });
  });
});
