import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service';
import { createMockDb } from '../../test-support/mock-db';
import { SubmissionReviewService } from './submission-review.service';

/**
 * Answers by statement shape: the locked bounty (`FOR UPDATE OF b`), the locked submission, the approved count, the UPDATE, the
 * revision lookup (which revision is current), the review INSERT and the audit INSERT.
 */
function setup(options: {
  bounty?: { id: string; status: string; max_winners: number } | null;
  submission?: { id: string; status: string; current_revision_no: number } | null;
  approved?: number;
  revisionRowExists?: boolean;
  submitterActive?: boolean;
} = {}) {
  const bounty = options.bounty === undefined ? { id: 'bounty', status: 'OPEN', max_winners: 3 } : options.bounty;
  const submission = options.submission === undefined ? { id: 'sub', status: 'SUBMITTED', current_revision_no: 1 } : options.submission;
  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes('FOR UPDATE OF b')) return bounty ? { rowCount: 1, rows: [bounty] } : { rowCount: 0, rows: [] };
    if (sql.includes('FOR SHARE OF u')) return options.submitterActive === false ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ id: 'user' }] };
    if (sql.includes('FROM bounty_submission WHERE id = $1 FOR UPDATE')) return submission ? { rowCount: 1, rows: [submission] } : { rowCount: 0, rows: [] };
    if (sql.includes("status = 'APPROVED'")) return { rowCount: 1, rows: [{ count: String(options.approved ?? 0) }] };
    if (sql.includes('FROM submission_revision WHERE submission_id = $1 AND revision_no = $2')) {
      return options.revisionRowExists === false ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ id: `rev-${params![1]}` }] };
    }
    return { rowCount: 1, rows: [] };
  });
  const dbQuery = jest.fn();
  const { database, db } = createMockDb({ query: dbQuery, txQuery: query });
  const service = new SubmissionReviewService(database, new AuditService(database));
  const call = (fragment: string) => query.mock.calls.find(([sql]) => (sql as string).includes(fragment));
  const wrote = () => query.mock.calls.some(([sql]) => /^\s*(UPDATE|INSERT)/.test(sql as string));
  return { service, query, db, dbQuery, call, wrote };
}

const errorOf = (promise: Promise<unknown>) => promise.then(() => undefined, (caught: unknown) => caught as Error);

describe('SubmissionReviewService decisions', () => {
  it.each([
    ['START_REVIEW', 'IN_REVIEW'],
    ['REQUEST_REVISION', 'REVISION_REQUESTED'],
    ['APPROVE', 'APPROVED'],
    ['REJECT', 'REJECTED'],
  ])('%s moves a SUBMITTED submission to %s and records the review against the current revision', async (decision, status) => {
    const { service, call, dbQuery } = setup({ submission: { id: 'sub', status: 'SUBMITTED', current_revision_no: 4 } });
    await expect(service.review('sub', decision, 'note', 'admin', 4)).resolves.toEqual({ id: 'sub', status });
    expect(call('UPDATE bounty_submission SET status = $2')![1]).toEqual(['sub', status]);
    expect(call('FROM submission_revision')![1]).toEqual(['sub', 4]);
    expect(call('INSERT INTO submission_review')![1]).toEqual(['sub', 'rev-4', 'admin', decision, 'note']);
    expect(call('INSERT INTO audit_log')![1]).toEqual(['admin', `SUBMISSION_${decision}`, 'bounty_submission', 'sub']);
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('stores a blank or padded comment as NULL / trimmed (the submitter sees it as the review comment)', async () => {
    const blank = setup();
    await blank.service.review('sub', 'APPROVE', '  \n ', 'admin');
    expect(blank.call('INSERT INTO submission_review')![1]).toEqual(['sub', 'rev-1', 'admin', 'APPROVE', null]);
    const padded = setup();
    await padded.service.review('sub', 'APPROVE', '  nice work ', 'admin');
    expect(padded.call('INSERT INTO submission_review')![1]).toEqual(['sub', 'rev-1', 'admin', 'APPROVE', 'nice work']);
  });

  it('an unknown decision is refused before any transaction is opened', async () => {
    const { service, db } = setup();
    const error = await errorOf(service.review('sub', 'DELETE', undefined, 'admin'));
    expect(error).toBeInstanceOf(NotFoundException);
    expect(error!.message).toBe('INVALID_DECISION');
    expect(db.tx).not.toHaveBeenCalled();
  });

  it('a submission without a live bounty (unknown id or soft-deleted bounty) is 404 SUBMISSION_NOT_FOUND', async () => {
    const { service, wrote } = setup({ bounty: null });
    await expect(service.review('sub', 'APPROVE', undefined, 'admin')).rejects.toMatchObject({ status: 404, message: 'SUBMISSION_NOT_FOUND' });
    expect(wrote()).toBe(false);
  });

  it('a submission row that vanished between the two locks is 404 SUBMISSION_NOT_FOUND', async () => {
    const { service, wrote } = setup({ submission: null });
    await expect(service.review('sub', 'APPROVE', undefined, 'admin')).rejects.toMatchObject({ message: 'SUBMISSION_NOT_FOUND' });
    expect(wrote()).toBe(false);
  });

  it.each(['DRAFT', 'FUNDING_PENDING', 'COMPLETED', 'CANCELLED'])('no review on a %s bounty → 400 BOUNTY_REVIEW_CLOSED, before the submission is read', async (status) => {
    const { service, query } = setup({ bounty: { id: 'bounty', status, max_winners: 1 } });
    const error = await errorOf(service.review('sub', 'REJECT', 'x', 'admin'));
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error!.message).toBe('BOUNTY_REVIEW_CLOSED');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each(['OPEN', 'SUBMISSION_CLOSED', 'IN_REVIEW'])('reviews are allowed while the bounty is %s', async (status) => {
    const { service } = setup({ bounty: { id: 'bounty', status, max_winners: 1 } });
    await expect(service.review('sub', 'START_REVIEW', undefined, 'admin')).resolves.toEqual({ id: 'sub', status: 'IN_REVIEW' });
  });

  // reviewable statuses × decisions — REVISION_REQUESTED only accepts REJECT (closing an abandoned revision), finalized ones nothing
  const DECISIONS = ['START_REVIEW', 'REQUEST_REVISION', 'APPROVE', 'REJECT'];
  const matrix: Array<[string, string, boolean]> = [];
  for (const status of ['SUBMITTED', 'RESUBMITTED', 'IN_REVIEW']) for (const d of DECISIONS) matrix.push([status, d, true]);
  for (const d of DECISIONS) matrix.push(['REVISION_REQUESTED', d, d === 'REJECT']);
  for (const status of ['APPROVED', 'REJECTED', 'WITHDRAWN']) for (const d of DECISIONS) matrix.push([status, d, false]);

  it.each(matrix)('submission %s + %s → reviewable=%s', async (status, decision, reviewable) => {
    const { service, wrote } = setup({ submission: { id: 'sub', status, current_revision_no: 1 } });
    const error = await errorOf(service.review('sub', decision, 'feedback', 'admin', 1));
    if (reviewable) {
      expect(error).toBeUndefined();
      expect(wrote()).toBe(true);
    } else {
      expect(error).toBeInstanceOf(BadRequestException);
      expect(error!.message).toBe('SUBMISSION_NOT_REVIEWABLE');
      expect(wrote()).toBe(false);
    }
  });
});

describe('SubmissionReviewService revision guard and feedback', () => {
  it('revisionNo omitted skips the stale-revision check and reviews whatever is current', async () => {
    const { service, call } = setup({ submission: { id: 'sub', status: 'RESUBMITTED', current_revision_no: 7 } });
    await expect(service.review('sub', 'APPROVE', undefined, 'admin')).resolves.toEqual({ id: 'sub', status: 'APPROVED' });
    expect(call('INSERT INTO submission_review')![1]).toEqual(['sub', 'rev-7', 'admin', 'APPROVE', null]);
  });

  it.each([[1, 2], [3, 2]])('revisionNo %i while the current revision is %i → 400 SUBMISSION_REVISION_CHANGED, nothing written', async (seen, current) => {
    const { service, wrote } = setup({ submission: { id: 'sub', status: 'RESUBMITTED', current_revision_no: current } });
    await expect(service.review('sub', 'APPROVE', undefined, 'admin', seen)).rejects.toMatchObject({ status: 400, message: 'SUBMISSION_REVISION_CHANGED' });
    expect(wrote()).toBe(false);
  });

  it.each([undefined, '', '   \n\t'])('REQUEST_REVISION needs actionable feedback (comment %p → 400 REVISION_COMMENT_REQUIRED)', async (comment) => {
    const { service, wrote } = setup();
    await expect(service.review('sub', 'REQUEST_REVISION', comment, 'admin')).rejects.toMatchObject({ message: 'REVISION_COMMENT_REQUIRED' });
    expect(wrote()).toBe(false);
  });

  it('rejecting an abandoned revision request also needs a comment; rejecting a fresh submission does not', async () => {
    const abandoned = setup({ submission: { id: 'sub', status: 'REVISION_REQUESTED', current_revision_no: 2 } });
    await expect(abandoned.service.review('sub', 'REJECT', ' ', 'admin', 2)).rejects.toMatchObject({ message: 'REVISION_COMMENT_REQUIRED' });
    expect(abandoned.wrote()).toBe(false);
    await expect(setup().service.review('sub', 'REJECT', undefined, 'admin')).resolves.toEqual({ id: 'sub', status: 'REJECTED' });
  });

  it('a missing revision snapshot (legacy row) stores the review with revision_id NULL instead of failing', async () => {
    const { service, call } = setup({ revisionRowExists: false });
    await expect(service.review('sub', 'START_REVIEW', undefined, 'admin')).resolves.toEqual({ id: 'sub', status: 'IN_REVIEW' });
    expect(call('INSERT INTO submission_review')![1]).toEqual(['sub', null, 'admin', 'START_REVIEW', null]);
  });
});

describe('SubmissionReviewService max winners', () => {
  it.each([[1, 0, true], [1, 1, false], [3, 2, true], [3, 3, false], [3, 4, false]])(
    'max_winners %i with %i already approved → approve allowed=%s',
    async (maxWinners, approved, allowed) => {
      const { service, call, wrote } = setup({ bounty: { id: 'bounty-9', status: 'IN_REVIEW', max_winners: maxWinners }, approved });
      const error = await errorOf(service.review('sub', 'APPROVE', undefined, 'admin'));
      expect(call("status = 'APPROVED'")![1]).toEqual(['bounty-9']);
      if (allowed) {
        expect(error).toBeUndefined();
      } else {
        expect(error).toBeInstanceOf(BadRequestException);
        expect(error!.message).toBe('MAX_WINNERS_REACHED');
        expect(wrote()).toBe(false);
      }
    },
  );

  it('max_winners is compared numerically even when the driver returns it as a string', async () => {
    const { service } = setup({ bounty: { id: 'b', status: 'OPEN', max_winners: '10' as unknown as number }, approved: 9 });
    await expect(service.review('sub', 'APPROVE', undefined, 'admin')).resolves.toEqual({ id: 'sub', status: 'APPROVED' });
  });

  it.each(['START_REVIEW', 'REQUEST_REVISION', 'REJECT'])('%s is not counted against max_winners even when the cap is reached', async (decision) => {
    const { service, call } = setup({ bounty: { id: 'b', status: 'OPEN', max_winners: 1 }, approved: 1 });
    await expect(service.review('sub', decision, 'fix it', 'admin')).resolves.toBeDefined();
    expect(call("SELECT count(*) FROM bounty_submission")).toBeUndefined();
  });
});

describe('SubmissionReviewService approval and the submitter account', () => {
  it('APPROVE locks the submitter (or the agent owner) user row FOR SHARE, active and not deleted, before the submission row', async () => {
    const { service, query } = setup();
    await service.review('sub', 'APPROVE', undefined, 'admin');
    const sqls = query.mock.calls.map(([sql]) => sql as string);
    const userLock = sqls.findIndex((sql) => sql.includes('FOR SHARE OF u'));
    expect(userLock).toBeGreaterThan(-1);
    expect(userLock).toBeLessThan(sqls.findIndex((sql) => sql.includes('FROM bounty_submission WHERE id = $1 FOR UPDATE')));
    expect(sqls[userLock]).toContain('COALESCE(s.submitter_user_id, a.owner_user_id)');
    expect(sqls[userLock]).toContain('u.deleted_at IS NULL');
    expect(sqls[userLock]).toContain("u.status = 'ACTIVE'");
    expect(query.mock.calls[userLock][1]).toEqual(['sub']);
  });

  it('APPROVE of a withdrawn or suspended submitter is 404 USER_NOT_FOUND and writes nothing', async () => {
    const { service, wrote } = setup({ submitterActive: false });
    await expect(service.review('sub', 'APPROVE', undefined, 'admin')).rejects.toMatchObject({ status: 404, message: 'USER_NOT_FOUND' });
    expect(wrote()).toBe(false);
  });

  it.each(['START_REVIEW', 'REQUEST_REVISION', 'REJECT'])('%s does not need the submitter lock (rejecting a withdrawn user submission stays possible)', async (decision) => {
    const { service, call } = setup({ submitterActive: false });
    await expect(service.review('sub', decision, 'feedback', 'admin')).resolves.toMatchObject({ id: 'sub' });
    expect(call('FOR SHARE OF u')).toBeUndefined();
  });
});
