import { statusCheckValues } from '../test-support/migration-check';
import { ApplicationStatusPolicy } from './application-status';

/**
 * 지원서 상태 규칙표 — 이 스펙이 정책의 문서다. application-status.ts를 바꾸면 아래 표도 같이 고친다.
 * PENDING에서만 심사·철회되는 규칙은 SQL 조건부 UPDATE가 집행하므로 applications/*.spec.ts와 test-db가 검사한다.
 */
const ALL = ['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN'] as const;

describe('ApplicationStatusPolicy', () => {
  it('has exactly the status values the DB CHECK allows (0004_bounties.sql)', () => {
    expect(ApplicationStatusPolicy.all()).toEqual([...ALL]);
    expect([...ApplicationStatusPolicy.all()].sort()).toEqual([...statusCheckValues('bounty_application')].sort());
  });

  it('operators decide APPROVED or REJECTED — the decision is the resulting status', () => {
    expect(ApplicationStatusPolicy.reviewDecisions()).toEqual(['APPROVED', 'REJECTED']);
  });

  it('only a WITHDRAWN application can be re-applied (the same row reopens as PENDING); anything else is 409 ALREADY_APPLIED', () => {
    expect(ALL.filter(ApplicationStatusPolicy.canReapply)).toEqual(['WITHDRAWN']);
  });

  it('approval needs open intake (bounty OPEN, before the deadline); rejection is allowed afterwards to clean up', () => {
    expect(ApplicationStatusPolicy.needsOpenIntake('APPROVED')).toBe(true);
    expect(ApplicationStatusPolicy.needsOpenIntake('REJECTED')).toBe(false);
  });
});
