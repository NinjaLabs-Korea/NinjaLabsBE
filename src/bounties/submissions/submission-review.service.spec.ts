import { AuditService } from '../../audit/audit.service';
import { createMockDb, SqlHandler } from '../../test-support/mock-db';
import { SubmissionReviewService } from './submission-review.service';

/**
 * 단위 스펙은 결정 -> 상태 매핑, 검사 순서, 바인딩만 본다. 심사 가능 상태 x 결정 표, 리비전 가드, 코멘트 규칙, max_winners 경계,
 * 제출자 계정 잠금, 리뷰 행이 가리키는 리비전은 src/test-db/submission-review.db-spec.ts가 실 DB 행으로 단언한다.
 * DB 대역은 엄격 모드라, 오류가 나야 하는 시점 뒤의 문장이 나가면 `Unexpected SQL`로 실패한다.
 */
function setup(options: { bountyStatus?: string; submissionStatus?: string; revision?: number; approveLocks?: boolean } = {}) {
  const ok = { rowCount: 1, rows: [] };
  const handlers: SqlHandler[] = [
    { match: /FOR UPDATE OF b$/, reply: () => ({ rowCount: 1, rows: [{ id: 'bounty', status: options.bountyStatus ?? 'OPEN', max_winners: 3 }] }) },
    { match: /FROM bounty_submission WHERE id = \$1 FOR UPDATE$/, reply: () => ({ rowCount: 1, rows: [{ id: 'sub', status: options.submissionStatus ?? 'SUBMITTED', current_revision_no: options.revision ?? 1 }] }) },
    { match: /^UPDATE bounty_submission SET status = \$2/, reply: () => ok },
    { match: /^INSERT INTO submission_review/, reply: () => ok },
    { match: /^INSERT INTO audit_log/, reply: () => ok },
    // approval-only statements: when approveLocks is false they are not registered, so a non-approval decision that issues them fails
    ...(options.approveLocks === false ? [] : [
      { match: /FOR SHARE OF u$/, reply: () => ({ rowCount: 1, rows: [{ id: 'user' }] }) },
      { match: /^SELECT count\(\*\) FROM bounty_submission/, reply: () => ({ rowCount: 1, rows: [{ count: '0' }] }) },
    ]),
  ];
  const mock = createMockDb({ strict: true, handlers });
  return { mock, service: new SubmissionReviewService(mock.database, new AuditService(mock.database)) };
}

describe('SubmissionReviewService decisions', () => {
  it.each([
    ['START_REVIEW', 'IN_REVIEW'],
    ['REQUEST_REVISION', 'REVISION_REQUESTED'],
    ['APPROVE', 'APPROVED'],
    ['REJECT', 'REJECTED'],
  ])('%s moves a SUBMITTED submission to %s and records the review and the audit entry in the same transaction', async (decision, status) => {
    const { service, mock } = setup({ revision: 4 });
    await expect(service.review('sub', decision, 'note', 'admin', 4)).resolves.toEqual({ id: 'sub', status });
    expect(mock.txStatements(/^UPDATE bounty_submission SET status = \$2/)[0].params).toEqual(['sub', status]);
    expect(mock.txStatements(/^INSERT INTO submission_review/)[0].params).toEqual([['sub'], 'admin', decision, 'note']);
    expect(mock.txStatements(/^INSERT INTO audit_log/)[0].params).toEqual(['admin', `SUBMISSION_${decision}`, 'bounty_submission', 'sub']);
    expect(mock.db.tx).toHaveBeenCalledTimes(1);
    expect(mock.db.query).not.toHaveBeenCalled();
  });

  it('stores a blank comment as NULL and a padded one trimmed (the submitter sees it as the review comment)', async () => {
    const blank = setup();
    await blank.service.review('sub', 'APPROVE', '  \n ', 'admin');
    expect(blank.mock.txStatements(/^INSERT INTO submission_review/)[0].params).toEqual([['sub'], 'admin', 'APPROVE', null]);
    const padded = setup();
    await padded.service.review('sub', 'APPROVE', '  nice work ', 'admin');
    expect(padded.mock.txStatements(/^INSERT INTO submission_review/)[0].params).toEqual([['sub'], 'admin', 'APPROVE', 'nice work']);
  });

  it('an unknown decision is 404 INVALID_DECISION before any transaction is opened', async () => {
    const { service, mock } = setup();
    await expect(service.review('sub', 'DELETE', undefined, 'admin')).rejects.toMatchObject({ status: 404, message: 'INVALID_DECISION' });
    expect(mock.db.tx).not.toHaveBeenCalled();
  });

  it.each(['DRAFT', 'FUNDING_PENDING', 'COMPLETED', 'CANCELLED'])('a %s bounty is 400 BOUNTY_REVIEW_CLOSED before the submission or the submitter is read', async (status) => {
    const { service, mock } = setup({ bountyStatus: status });
    await expect(service.review('sub', 'APPROVE', 'x', 'admin')).rejects.toMatchObject({ status: 400, message: 'BOUNTY_REVIEW_CLOSED' });
    expect(mock.txQuery).toHaveBeenCalledTimes(1);
  });

  it.each(['APPROVED', 'REJECTED', 'WITHDRAWN'])('a %s submission is 400 SUBMISSION_NOT_REVIEWABLE and nothing is written', async (submissionStatus) => {
    const { service, mock } = setup({ submissionStatus });
    await expect(service.review('sub', 'REJECT', 'x', 'admin')).rejects.toMatchObject({ status: 400, message: 'SUBMISSION_NOT_REVIEWABLE' });
    expect(mock.txStatements(/^UPDATE bounty_submission/)).toHaveLength(0);
  });

  it('the stale-revision guard is checked before the comment rule and before any winner count', async () => {
    const { service, mock } = setup({ submissionStatus: 'RESUBMITTED', revision: 2 });
    await expect(service.review('sub', 'REQUEST_REVISION', undefined, 'admin', 1)).rejects.toMatchObject({ message: 'SUBMISSION_REVISION_CHANGED' });
    expect(mock.txStatements(/^SELECT count/)).toHaveLength(0);
  });

  it('approval binds the submitter lock to the submission id and the winner count to the bounty id', async () => {
    const { service, mock } = setup();
    await service.review('sub', 'APPROVE', undefined, 'admin');
    expect(mock.txStatements(/FOR SHARE OF u$/)[0].params).toEqual(['sub']);
    expect(mock.txStatements(/^SELECT count\(\*\) FROM bounty_submission/)[0].params).toEqual(['bounty']);
  });

  it.each(['START_REVIEW', 'REQUEST_REVISION', 'REJECT'])('%s neither locks the submitter nor counts winners (strict: those statements are not registered for it)', async (decision) => {
    const { service } = setup({ approveLocks: false });
    await expect(service.review('sub', decision, 'fix it', 'admin')).resolves.toMatchObject({ id: 'sub' });
  });
});
