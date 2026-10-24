import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service';
import { createMockDb } from '../../test-support/mock-db';
import { ApplicationReviewService } from './application-review.service';

const FUTURE = '2999-01-01T00:00:00.000Z';
const PAST = '2000-01-01T00:00:00.000Z';

/** The conditional UPDATE (`AND status = 'PENDING'`) is answered from the application's current status, like Postgres would */
function setup(options: { bounty?: { status: string; submission_deadline: string } | null; applicationStatus?: string } = {}) {
  const bounty = options.bounty === undefined ? { status: 'OPEN', submission_deadline: FUTURE } : options.bounty;
  const applicationStatus = options.applicationStatus ?? 'PENDING';
  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes('FOR UPDATE OF b')) return bounty ? { rowCount: 1, rows: [bounty] } : { rowCount: 0, rows: [] };
    if (sql.includes('UPDATE bounty_application')) {
      const matches = !sql.includes("status = 'PENDING'") || applicationStatus === 'PENDING';
      return matches ? { rowCount: 1, rows: [{ id: params![0], status: params![1] }] } : { rowCount: 0, rows: [] };
    }
    return { rowCount: 1, rows: [] };
  });
  const dbQuery = jest.fn();
  const { database } = createMockDb({ query: dbQuery, txQuery: query });
  const service = new ApplicationReviewService(database, new AuditService(database));
  const update = () => query.mock.calls.find(([sql]) => (sql as string).includes('UPDATE bounty_application'));
  const audited = () => query.mock.calls.some(([sql]) => (sql as string).includes('INSERT INTO audit_log'));
  return { service, query, dbQuery, update, audited };
}

describe('ApplicationReviewService', () => {
  it.each(['APPROVED', 'REJECTED'] as const)('%s on an OPEN bounty: stores reviewer + trimmed note, audits APPLICATION_<decision> on the tx', async (decision) => {
    const { service, query, update, dbQuery } = setup();
    await expect(service.review('app', decision, '  looks good  ', 'admin')).resolves.toEqual({ id: 'app', status: decision });
    expect(query.mock.calls[0][1]).toEqual(['app']);
    expect(update()![0]).toContain('SET status = $2, reviewed_by = $3, review_note = $4, reviewed_at = now()');
    expect(update()![1]).toEqual(['app', decision, 'admin', 'looks good']);
    expect(query.mock.calls.at(-1)![1]).toEqual(['admin', `APPLICATION_${decision}`, 'bounty_application', 'app']);
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it.each([undefined, '', '   '])('a blank note (%p) is stored as NULL', async (note) => {
    const { service, update } = setup();
    await service.review('app', 'REJECTED', note, 'admin');
    expect((update()![1] as unknown[])[3]).toBeNull();
  });

  it('an unknown application, or one on a deleted bounty, is 404 APPLICATION_NOT_FOUND_OR_NOT_PENDING without writing', async () => {
    const { service, update, audited } = setup({ bounty: null });
    const error = await service.review('app', 'APPROVED', undefined, 'admin').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as Error).message).toBe('APPLICATION_NOT_FOUND_OR_NOT_PENDING');
    expect(update()).toBeUndefined();
    expect(audited()).toBe(false);
  });

  it.each(['APPROVED', 'REJECTED', 'WITHDRAWN'])('an application already %s is 404 (the conditional UPDATE matches nothing) and is not audited', async (applicationStatus) => {
    const { service, audited } = setup({ applicationStatus });
    await expect(service.review('app', 'REJECTED', 'x', 'admin')).rejects.toMatchObject({ status: 404, message: 'APPLICATION_NOT_FOUND_OR_NOT_PENDING' });
    expect(audited()).toBe(false);
  });

  it.each(['COMPLETED', 'CANCELLED'])('a %s bounty refuses both decisions with 400 BOUNTY_REVIEW_CLOSED', async (status) => {
    for (const decision of ['APPROVED', 'REJECTED'] as const) {
      const { service, update } = setup({ bounty: { status, submission_deadline: FUTURE } });
      const error = await service.review('app', decision, undefined, 'admin').catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as Error).message).toBe('BOUNTY_REVIEW_CLOSED');
      expect(update()).toBeUndefined();
    }
  });

  it.each(['DRAFT', 'FUNDING_PENDING', 'SUBMISSION_CLOSED', 'IN_REVIEW'])('approval needs an OPEN bounty: %s → 400 APPLICATION_APPROVAL_CLOSED, rejection still allowed', async (status) => {
    const approve = setup({ bounty: { status, submission_deadline: FUTURE } });
    await expect(approve.service.review('app', 'APPROVED', undefined, 'admin')).rejects.toMatchObject({ message: 'APPLICATION_APPROVAL_CLOSED' });
    expect(approve.update()).toBeUndefined();
    await expect(setup({ bounty: { status, submission_deadline: FUTURE } }).service.review('app', 'REJECTED', undefined, 'admin'))
      .resolves.toEqual({ id: 'app', status: 'REJECTED' });
  });

  it('approval after the submission deadline would strand the applicant → 400 APPLICATION_APPROVAL_CLOSED; rejection still allowed', async () => {
    await expect(setup({ bounty: { status: 'OPEN', submission_deadline: PAST } }).service.review('app', 'APPROVED', undefined, 'admin'))
      .rejects.toMatchObject({ message: 'APPLICATION_APPROVAL_CLOSED' });
    await expect(setup({ bounty: { status: 'OPEN', submission_deadline: PAST } }).service.review('app', 'REJECTED', undefined, 'admin'))
      .resolves.toEqual({ id: 'app', status: 'REJECTED' });
  });

  it('a submission deadline exactly now already closes approval (<=)', async () => {
    jest.useFakeTimers({ now: new Date('2031-01-01T00:00:00.000Z') });
    try {
      await expect(setup({ bounty: { status: 'OPEN', submission_deadline: '2031-01-01T00:00:00.000Z' } }).service.review('app', 'APPROVED', undefined, 'admin'))
        .rejects.toMatchObject({ message: 'APPLICATION_APPROVAL_CLOSED' });
      await expect(setup({ bounty: { status: 'OPEN', submission_deadline: '2031-01-01T00:00:01.000Z' } }).service.review('app', 'APPROVED', undefined, 'admin'))
        .resolves.toEqual({ id: 'app', status: 'APPROVED' });
    } finally {
      jest.useRealTimers();
    }
  });
});
