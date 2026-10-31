import { statusCheckValues } from '../test-support/migration-check';
import { SubmissionStatusPolicy } from './submission-status';

/**
 * 제출 상태 규칙표 - 이 스펙이 정책의 문서다. submission-status.ts를 바꾸면 아래 표도 의도에 맞게 같이 고친다.
 * (서비스 단위 동작은 submissions/*.spec.ts, admin/*.spec.ts가 따로 검사한다.)
 */
const ALL = ['SUBMITTED', 'IN_REVIEW', 'REVISION_REQUESTED', 'RESUBMITTED', 'APPROVED', 'REJECTED', 'WITHDRAWN'] as const;
const DECISIONS = ['START_REVIEW', 'REQUEST_REVISION', 'APPROVE', 'REJECT'] as const;

describe('SubmissionStatusPolicy', () => {
  it('has exactly the status values the DB CHECK allows (0005_submissions.sql)', () => {
    expect(SubmissionStatusPolicy.all()).toEqual([...ALL]);
    expect([...SubmissionStatusPolicy.all()].sort()).toEqual([...statusCheckValues('bounty_submission')].sort());
  });

  it('accepts exactly the four operator decisions (REOPEN is in the DB CHECK but not exposed)', () => {
    expect(SubmissionStatusPolicy.decisions()).toEqual([...DECISIONS]);
    expect(SubmissionStatusPolicy.decisions()).not.toContain('REOPEN');
  });

  it.each([
    ['START_REVIEW', 'IN_REVIEW'],
    ['REQUEST_REVISION', 'REVISION_REQUESTED'],
    ['APPROVE', 'APPROVED'],
    ['REJECT', 'REJECTED'],
  ])('decision %s moves the submission to %s', (decision, status) => {
    expect(SubmissionStatusPolicy.statusAfter(decision)).toBe(status);
  });

  it('an unknown decision has no resulting status (→ 404 INVALID_DECISION)', () => {
    expect(SubmissionStatusPolicy.statusAfter('REOPEN')).toBeUndefined();
    expect(SubmissionStatusPolicy.statusAfter('approve')).toBeUndefined();
  });

  describe('review table (status × decision): reviewable / comment required', () => {
    // [status, decision, reviewable, commentRequired] - commentRequired는 reviewable일 때만 의미가 있다
    const Y = true;
    const N = false;
    const TABLE: Array<[string, string, boolean, boolean]> = [
      ['SUBMITTED', 'START_REVIEW', Y, N],
      ['SUBMITTED', 'REQUEST_REVISION', Y, Y],
      ['SUBMITTED', 'APPROVE', Y, N],
      ['SUBMITTED', 'REJECT', Y, N],
      ['RESUBMITTED', 'START_REVIEW', Y, N],
      ['RESUBMITTED', 'REQUEST_REVISION', Y, Y],
      ['RESUBMITTED', 'APPROVE', Y, N],
      ['RESUBMITTED', 'REJECT', Y, N],
      // 이미 심사 중인 제출에 START_REVIEW를 또 보내면 바뀌는 게 없는데 심사 이력·감사 행만 쌓인다
      ['IN_REVIEW', 'START_REVIEW', N, N],
      ['IN_REVIEW', 'REQUEST_REVISION', Y, Y],
      ['IN_REVIEW', 'APPROVE', Y, N],
      ['IN_REVIEW', 'REJECT', Y, N],
      // 수정 요청 중: 재제출을 기다린다. 버려진 리비전을 닫는 반려만 허용하고, 이유(코멘트)가 필수
      ['REVISION_REQUESTED', 'START_REVIEW', N, N],
      ['REVISION_REQUESTED', 'REQUEST_REVISION', N, Y],
      ['REVISION_REQUESTED', 'APPROVE', N, N],
      ['REVISION_REQUESTED', 'REJECT', Y, Y],
      // 확정·철회된 제출은 어떤 결정도 받지 않는다
      ...(['APPROVED', 'REJECTED', 'WITHDRAWN'] as const).flatMap((s) =>
        DECISIONS.map((d) => [s, d, N, d === 'REQUEST_REVISION'] as [string, string, boolean, boolean])),
    ];

    it('covers every status × decision pair', () => {
      expect(TABLE).toHaveLength(ALL.length * DECISIONS.length);
    });

    it.each(TABLE)('%s + %s → reviewable=%s, commentRequired=%s', (status, decision, reviewable, commentRequired) => {
      expect(SubmissionStatusPolicy.canReview(status, decision)).toBe(reviewable);
      expect(SubmissionStatusPolicy.requiresComment(status, decision)).toBe(commentRequired);
    });
  });

  it('unresolved = awaiting review + REVISION_REQUESTED (blocks COMPLETED, withdrawn on account deletion)', () => {
    expect(SubmissionStatusPolicy.unresolvedStatuses()).toEqual(['SUBMITTED', 'RESUBMITTED', 'IN_REVIEW', 'REVISION_REQUESTED']);
  });

  it('unresolvedStatuses() returns a copy (callers may not mutate the policy)', () => {
    SubmissionStatusPolicy.unresolvedStatuses().push('APPROVED');
    expect(SubmissionStatusPolicy.unresolvedStatuses()).not.toContain('APPROVED');
  });

  it('only APPROVED and REJECTED are finalized (a WITHDRAWN submission can be resubmitted while intake is open)', () => {
    expect(ALL.filter(SubmissionStatusPolicy.isFinalized)).toEqual(['APPROVED', 'REJECTED']);
  });

  it('only REVISION_REQUESTED may be resubmitted after intake closed (bounty not OPEN or deadline passed)', () => {
    expect(ALL.filter(SubmissionStatusPolicy.canResubmitAfterIntakeClosed)).toEqual(['REVISION_REQUESTED']);
  });

  it('every status is in exactly one bucket: unresolved, finalized, or WITHDRAWN', () => {
    for (const s of ALL) {
      const buckets = [SubmissionStatusPolicy.unresolvedStatuses().includes(s), SubmissionStatusPolicy.isFinalized(s), s === 'WITHDRAWN'];
      expect(buckets.filter(Boolean)).toHaveLength(1);
    }
  });
});
