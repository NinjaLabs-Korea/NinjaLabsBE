import { AuditService } from '../../audit/audit.service';
import { withParamsCheck } from '../../test-support/expect-params-match';
import { ApplicationReviewService } from '../applications/application-review.service';
import { SubmissionReviewService } from '../submissions/submission-review.service';
import { BountyAdminService } from './bounty-admin.service';
import { BountyLifecycleService } from './bounty-lifecycle.service';
import { RewardTokenResolver } from './reward-token.resolver';
import { ConfigService } from '@nestjs/config';

const adminServicesFor = (db: unknown) => {
  const audit = new AuditService(db as never);
  return {
    bounties: new BountyAdminService(db as never, audit, new BountyLifecycleService(), new RewardTokenResolver(new ConfigService())),
    applicationReviews: new ApplicationReviewService(db as never, audit),
    submissionReviews: new SubmissionReviewService(db as never, audit),
  };
};
import { ApplicationsService } from '../applications/applications.service';

/** `db.query` (autocommit) and `tx.query` are separate mocks — transitions and reviews must never issue a statement outside the transaction */
function dbWith(txQuery: jest.Mock) {
  const dbQuery = jest.fn();
  return { dbQuery, db: { query: dbQuery, tx: (fn: (tx: { query: jest.Mock }) => Promise<unknown>) => fn({ query: withParamsCheck(txQuery) }) } };
}

function setup(status: string, counts: Record<string, number | undefined> = {}, expired = false) {
  const query = jest.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes('FOR UPDATE')) return { rowCount: 1, rows: [{ status, submission_deadline: expired ? '2020-01-01' : '2099-01-01' }] };
    if (sql.includes('AS pending')) return { rowCount: 1, rows: [counts] };
    return { rowCount: 1, rows: [{ id: 'id', status: 'APPROVED' }] };
  });
  const { db, dbQuery } = dbWith(query);
  return { query, dbQuery, services: adminServicesFor(db) };
}

const statusUpdate = (query: jest.Mock) => query.mock.calls.find(([sql]) => (sql as string).startsWith('UPDATE bounty SET status = $2'));

describe('Bounty lifecycle ordering', () => {
  it.each([{ pending: 1 }, { unsubmitted: 1 }])('blocks closing with unfinished intake %j', async (counts) => {
    const { services, query, dbQuery } = setup('OPEN', counts);
    await expect(services.bounties.transition('b', 'SUBMISSION_CLOSED', 'admin')).rejects.toMatchObject({ response: { message: [expect.any(String)] } });
    expect(query.mock.calls.some(([sql]) => sql.startsWith('UPDATE bounty'))).toBe(false);
    // the blockers query counts the rows of THIS bounty
    expect(query.mock.calls.find(([sql]) => sql.includes('AS pending'))![1]).toEqual(['b']);
    expect(dbQuery).not.toHaveBeenCalled();
  });
  it('allows closing after the submission deadline when approved participants never submitted', async () => {
    const { services, query, dbQuery } = setup('OPEN', { unsubmitted: 1 }, true);
    await expect(services.bounties.transition('b', 'SUBMISSION_CLOSED', 'admin')).resolves.toMatchObject({ status: 'SUBMISSION_CLOSED' });
    expect(statusUpdate(query)![1]).toEqual(['b', 'SUBMISSION_CLOSED']);
    expect(statusUpdate(query)![0]).toBe('UPDATE bounty SET status = $2 WHERE id = $1'); // no timestamp column for this transition
    expect(query.mock.calls.at(-1)![1]).toEqual(['admin', 'BOUNTY_SUBMISSION_CLOSED', 'bounty', 'b']);
    expect(dbQuery).not.toHaveBeenCalled();
  });
  it.each([{ unresolved: 1 }, { pending: 1 }, { unpaid: 1 }, { unawarded: 1 }])('blocks completion with outstanding work %j', async (counts) => {
    const { services, query } = setup('IN_REVIEW', counts);
    await expect(services.bounties.transition('b', 'COMPLETED', 'admin')).rejects.toMatchObject({ response: { message: [expect.any(String)] } });
    expect(statusUpdate(query)).toBeUndefined();
  });
  it('allows completion after all reviews and payments are settled', async () => {
    const { services, query, dbQuery } = setup('IN_REVIEW');
    await expect(services.bounties.transition('b', 'COMPLETED', 'admin')).resolves.toMatchObject({ status: 'COMPLETED' });
    expect(statusUpdate(query)![1]).toEqual(['b', 'COMPLETED']);
    expect(statusUpdate(query)![0]).toBe('UPDATE bounty SET status = $2, completed_at = COALESCE(completed_at, now()) WHERE id = $1');
    expect(dbQuery).not.toHaveBeenCalled();
  });
  it.each(['SUBMISSION_CLOSED', 'IN_REVIEW'])('reopens %s with a future deadline', async (status) => {
    const reopened = setup(status);
    await expect(reopened.services.bounties.transition('b', 'OPEN', 'admin')).resolves.toMatchObject({ status: 'OPEN' });
    expect(statusUpdate(reopened.query)![1]).toEqual(['b', 'OPEN']);
    expect(statusUpdate(reopened.query)![0]).toContain('opened_at = COALESCE(opened_at, now())'); // first opening time survives a reopen
    const expired = setup(status, {}, true);
    await expect(expired.services.bounties.transition('b', 'OPEN', 'admin')).rejects.toMatchObject({ response: { message: [expect.stringContaining('deadline')] } });
    expect(statusUpdate(expired.query)).toBeUndefined();
  });
  it.each(['SUBMISSION_CLOSED', 'IN_REVIEW'])('prevents stranded application approval in %s', async (status) => {
    await expect(setup(status).services.applicationReviews.review('a', 'APPROVED', '', 'admin')).rejects.toThrow('APPLICATION_APPROVAL_CLOSED');
    const rejected = setup(status);
    await expect(rejected.services.applicationReviews.review('a', 'REJECTED', 'Intake ended', 'admin')).resolves.toBeDefined();
    expect(rejected.query.mock.calls.find(([sql]) => sql.startsWith('UPDATE bounty_application'))![1]).toEqual(['a', 'REJECTED', 'admin', 'Intake ended']);
    expect(rejected.dbQuery).not.toHaveBeenCalled();
  });
  it('does not approve an application past the submission deadline', async () => {
    await expect(setup('OPEN', {}, true).services.applicationReviews.review('a', 'APPROVED', '', 'admin')).rejects.toThrow('APPLICATION_APPROVAL_CLOSED');
  });
  it.each(['COMPLETED', 'CANCELLED'])('does not review a submission on a %s bounty', async (status) => {
    await expect(setup(status).services.submissionReviews.review('s', 'APPROVE', '', 'admin', 1)).rejects.toThrow('BOUNTY_REVIEW_CLOSED');
  });
  it.each(['submission_deadline', 'application_deadline'])('blocks new applications after %s', async (field) => {
    const query = jest.fn().mockResolvedValue({ rowCount: 1, rows: [{ application_required: true, status: 'OPEN', submission_mode: 'DIRECT', [field]: '2020-01-01' }] });
    const { db, dbQuery } = dbWith(query);
    const service = new ApplicationsService(db as never, { record: jest.fn() } as never);
    await expect(service.apply('b', 'u', 'Apply')).rejects.toThrow('APPLICATION_DEADLINE_PASSED');
    expect(query).toHaveBeenCalledTimes(1);
    expect(dbQuery).not.toHaveBeenCalled();
  });
});

describe('Submission approval winner cap', () => {
  function setupReview(maxWinners: number, approved: number) {
    const query = jest.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes('FROM bounty b JOIN bounty_submission')) return { rowCount: 1, rows: [{ id: 'b', status: 'IN_REVIEW', max_winners: maxWinners }] };
      if (sql.includes('SELECT id, status, current_revision_no')) return { rowCount: 1, rows: [{ id: 's', status: 'IN_REVIEW', current_revision_no: 1 }] };
      if (sql.includes("status = 'APPROVED'")) return { rowCount: 1, rows: [{ count: String(approved) }] };
      return { rowCount: 1, rows: [{ id: 'rev' }] };
    });
    const { db, dbQuery } = dbWith(query);
    return { query, dbQuery, services: adminServicesFor(db) };
  }

  it('refuses to approve beyond max_winners, counting APPROVED submissions of the bounty inside the locked transaction', async () => {
    const { services, query, dbQuery } = setupReview(1, 1);
    await expect(services.submissionReviews.review('s', 'APPROVE', '', 'admin', 1)).rejects.toThrow('MAX_WINNERS_REACHED');
    const count = query.mock.calls.find(([sql]) => sql.includes("status = 'APPROVED'"))!;
    expect(count[0]).toContain(`SELECT count(*) FROM bounty_submission WHERE bounty_id = $1 AND status = 'APPROVED'`);
    expect(count[1]).toEqual(['b']);
    expect(query.mock.calls.some(([sql]) => sql.includes('UPDATE bounty_submission'))).toBe(false);
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('approves while under max_winners', async () => {
    const { services, query, dbQuery } = setupReview(2, 1);
    await expect(services.submissionReviews.review('s', 'APPROVE', '', 'admin', 1)).resolves.toMatchObject({ status: 'APPROVED' });
    expect(query.mock.calls.find(([sql]) => sql.includes('UPDATE bounty_submission'))![1]).toEqual(['s', 'APPROVED']);
    expect(dbQuery).not.toHaveBeenCalled();
  });
});
