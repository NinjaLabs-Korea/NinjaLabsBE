import { ConflictException } from '@nestjs/common';
import { AdminService } from './admin.service';

type Row = Record<string, unknown>;

/** Routes each SQL statement to a canned result; records every call for assertions. */
function fakeDb(route: (sql: string) => Row[] | undefined) {
  const tx = {
    query: jest.fn(async (sql: string, _params?: unknown[]) => {
      const rows = route(sql) ?? [];
      return { rows, rowCount: rows.length || 1 };
    }),
  };
  const db = { tx: jest.fn(async (fn: (runner: typeof tx) => unknown) => fn(tx)), query: tx.query };
  return { db, tx, service: new AdminService(db as never) };
}

const ADMIN = '00000000-0000-4000-8000-000000000001';
const BOUNTY = '00000000-0000-4000-8000-000000000002';
const SUBMISSION = '00000000-0000-4000-8000-000000000003';
const updates = (tx: { query: jest.Mock }) => tx.query.mock.calls.filter(([sql]) => /^\s*UPDATE (bounty|bounty_submission) SET status/.test(sql));

describe('AdminService bounty completion guards', () => {
  const route = (counts: { approved: string; pending: string }) => (sql: string) => {
    if (sql.includes('SELECT status FROM bounty')) return [{ status: 'IN_REVIEW' }];
    if (sql.includes('FILTER (WHERE status')) return [counts];
    return undefined;
  };

  it('refuses to complete a bounty with no approved submission', async () => {
    const { tx, service } = fakeDb(route({ approved: '0', pending: '0' }));
    await expect(service.transitionBounty(BOUNTY, 'COMPLETED', ADMIN)).rejects.toThrow(new ConflictException('NO_APPROVED_SUBMISSION'));
    expect(updates(tx)).toHaveLength(0);
  });

  it('refuses to complete while submissions are still pending review', async () => {
    const { tx, service } = fakeDb(route({ approved: '1', pending: '2' }));
    await expect(service.transitionBounty(BOUNTY, 'COMPLETED', ADMIN)).rejects.toThrow(new ConflictException('SUBMISSIONS_PENDING_REVIEW'));
    expect(updates(tx)).toHaveLength(0);
  });

  it('completes once every submission is decided and one is approved', async () => {
    const { tx, service } = fakeDb(route({ approved: '1', pending: '0' }));
    await expect(service.transitionBounty(BOUNTY, 'COMPLETED', ADMIN)).resolves.toEqual({ id: BOUNTY, status: 'COMPLETED' });
    expect(updates(tx)).toHaveLength(1);
  });

  it('rejects transitions outside the lifecycle with a conflict', async () => {
    const { service } = fakeDb((sql) => (sql.includes('SELECT status FROM bounty') ? [{ status: 'OPEN' }] : undefined));
    await expect(service.transitionBounty(BOUNTY, 'COMPLETED', ADMIN)).rejects.toThrow(new ConflictException('INVALID_TRANSITION:OPEN->COMPLETED'));
  });
});

describe('AdminService submission review ordering', () => {
  const route = (submission: { status: string; bounty_status?: string; max_winners?: number }, approved = '0') => (sql: string) => {
    if (sql.includes('FROM bounty_submission s')) {
      return [{ id: SUBMISSION, current_revision_no: 1, bounty_id: BOUNTY, bounty_status: 'IN_REVIEW', max_winners: 1, ...submission }];
    }
    if (sql.includes("status = 'APPROVED'")) return [{ count: approved }];
    if (sql.includes('FROM submission_revision')) return [{ id: 'rev-1' }];
    return undefined;
  };

  it('requires START_REVIEW before a decision', async () => {
    const { tx, service } = fakeDb(route({ status: 'SUBMITTED' }));
    await expect(service.reviewSubmission(SUBMISSION, 'APPROVE', undefined, ADMIN)).rejects.toThrow(new ConflictException('INVALID_REVIEW_ORDER:SUBMITTED->APPROVE'));
    expect(updates(tx)).toHaveLength(0);
  });

  it('moves a fresh or resubmitted submission into review', async () => {
    for (const status of ['SUBMITTED', 'RESUBMITTED']) {
      const { service } = fakeDb(route({ status }));
      await expect(service.reviewSubmission(SUBMISSION, 'START_REVIEW', undefined, ADMIN)).resolves.toEqual({ id: SUBMISSION, status: 'IN_REVIEW' });
    }
  });

  it('never re-reviews a finalized submission', async () => {
    for (const status of ['APPROVED', 'REJECTED']) {
      const { service } = fakeDb(route({ status }));
      await expect(service.reviewSubmission(SUBMISSION, 'REQUEST_REVISION', undefined, ADMIN)).rejects.toBeInstanceOf(ConflictException);
    }
  });

  it('blocks reviews once the bounty is completed or cancelled', async () => {
    const { service } = fakeDb(route({ status: 'IN_REVIEW', bounty_status: 'COMPLETED' }));
    await expect(service.reviewSubmission(SUBMISSION, 'APPROVE', undefined, ADMIN)).rejects.toThrow(new ConflictException('BOUNTY_NOT_REVIEWABLE:COMPLETED'));
  });

  it('caps approvals at max_winners', async () => {
    const { tx, service } = fakeDb(route({ status: 'IN_REVIEW', max_winners: 1 }, '1'));
    await expect(service.reviewSubmission(SUBMISSION, 'APPROVE', undefined, ADMIN)).rejects.toThrow(new ConflictException('MAX_WINNERS_REACHED'));
    expect(updates(tx)).toHaveLength(0);
  });

  it('approves an in-review submission under the winner cap', async () => {
    const { tx, service } = fakeDb(route({ status: 'IN_REVIEW', max_winners: 2 }, '1'));
    await expect(service.reviewSubmission(SUBMISSION, 'APPROVE', 'great work', ADMIN)).resolves.toEqual({ id: SUBMISSION, status: 'APPROVED' });
    expect(updates(tx)).toHaveLength(1);
    expect(tx.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO submission_review'))).toBe(true);
  });
});
