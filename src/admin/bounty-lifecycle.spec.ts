import { AdminService } from './admin.service';
import { ApplicationsService } from '../bounties/applications/applications.service';

function setup(status: string, counts: Record<string, number | undefined> = {}, expired = false) {
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('FOR UPDATE')) return { rowCount: 1, rows: [{ status, submission_deadline: expired ? '2020-01-01' : '2099-01-01' }] };
    if (sql.includes('AS pending')) return { rowCount: 1, rows: [counts] };
    return { rowCount: 1, rows: [{ id: 'id', status: 'APPROVED' }] };
  });
  return { query, service: new AdminService({ query, tx: (fn: (tx: { query: typeof query }) => Promise<unknown>) => fn({ query }) } as never) };
}

describe('Bounty lifecycle ordering', () => {
  it.each([{ pending: 1 }, { unsubmitted: 1 }])('blocks closing with unfinished intake %j', async (counts) => {
    const { service, query } = setup('OPEN', counts);
    await expect(service.transitionBounty('b', 'SUBMISSION_CLOSED', 'admin')).rejects.toMatchObject({ response: { message: [expect.any(String)] } });
    expect(query.mock.calls.some(([sql]) => sql.startsWith('UPDATE bounty'))).toBe(false);
  });
  it('allows closing after the submission deadline when approved participants never submitted', async () => {
    await expect(setup('OPEN', { unsubmitted: 1 }, true).service.transitionBounty('b', 'SUBMISSION_CLOSED', 'admin')).resolves.toMatchObject({ status: 'SUBMISSION_CLOSED' });
  });
  it.each([{ unresolved: 1 }, { pending: 1 }, { unpaid: 1 }, { unawarded: 1 }])('blocks completion with outstanding work %j', async (counts) => {
    await expect(setup('IN_REVIEW', counts).service.transitionBounty('b', 'COMPLETED', 'admin')).rejects.toMatchObject({ response: { message: [expect.any(String)] } });
  });
  it('allows completion after all reviews and payments are settled', async () => {
    await expect(setup('IN_REVIEW').service.transitionBounty('b', 'COMPLETED', 'admin')).resolves.toMatchObject({ status: 'COMPLETED' });
  });
  it.each(['SUBMISSION_CLOSED', 'IN_REVIEW'])('reopens %s with a future deadline', async (status) => {
    await expect(setup(status).service.transitionBounty('b', 'OPEN', 'admin')).resolves.toMatchObject({ status: 'OPEN' });
    await expect(setup(status, {}, true).service.transitionBounty('b', 'OPEN', 'admin')).rejects.toMatchObject({ response: { message: [expect.stringContaining('deadline')] } });
  });
  it.each(['SUBMISSION_CLOSED', 'IN_REVIEW'])('prevents stranded application approval in %s', async (status) => {
    await expect(setup(status).service.reviewApplication('a', 'APPROVED', '', 'admin')).rejects.toThrow('APPLICATION_APPROVAL_CLOSED');
    await expect(setup(status).service.reviewApplication('a', 'REJECTED', 'Intake ended', 'admin')).resolves.toBeDefined();
  });
  it('does not approve an application past the submission deadline', async () => {
    await expect(setup('OPEN', {}, true).service.reviewApplication('a', 'APPROVED', '', 'admin')).rejects.toThrow('APPLICATION_APPROVAL_CLOSED');
  });
  it.each(['COMPLETED', 'CANCELLED'])('does not review a submission on a %s bounty', async (status) => {
    await expect(setup(status).service.reviewSubmission('s', 'APPROVE', '', 'admin', 1)).rejects.toThrow('BOUNTY_REVIEW_CLOSED');
  });
  it.each(['submission_deadline', 'application_deadline'])('blocks new applications after %s', async (field) => {
    const query = jest.fn().mockResolvedValue({ rowCount: 1, rows: [{ application_required: true, status: 'OPEN', submission_mode: 'DIRECT', [field]: '2020-01-01' }] });
    const service = new ApplicationsService({ tx: (fn: (tx: { query: typeof query }) => Promise<unknown>) => fn({ query }) } as never);
    await expect(service.apply('b', 'u', 'Apply')).rejects.toThrow('APPLICATION_DEADLINE_PASSED');
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('Submission approval winner cap', () => {
  function setupReview(maxWinners: number, approved: number) {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('FROM bounty b JOIN bounty_submission')) return { rowCount: 1, rows: [{ id: 'b', status: 'IN_REVIEW', max_winners: maxWinners }] };
      if (sql.includes('SELECT id, status, current_revision_no')) return { rowCount: 1, rows: [{ id: 's', status: 'IN_REVIEW', current_revision_no: 1 }] };
      if (sql.includes("status = 'APPROVED'")) return { rowCount: 1, rows: [{ count: String(approved) }] };
      return { rowCount: 1, rows: [{ id: 'rev' }] };
    });
    return { query, service: new AdminService({ query, tx: (fn: (tx: { query: typeof query }) => Promise<unknown>) => fn({ query }) } as never) };
  }

  it('refuses to approve beyond max_winners', async () => {
    const { service, query } = setupReview(1, 1);
    await expect(service.reviewSubmission('s', 'APPROVE', '', 'admin', 1)).rejects.toThrow('MAX_WINNERS_REACHED');
    expect(query.mock.calls.some(([sql]) => sql.includes('UPDATE bounty_submission'))).toBe(false);
  });

  it('approves while under max_winners', async () => {
    await expect(setupReview(2, 1).service.reviewSubmission('s', 'APPROVE', '', 'admin', 1)).resolves.toMatchObject({ status: 'APPROVED' });
  });
});
