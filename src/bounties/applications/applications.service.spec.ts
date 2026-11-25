import { AuditService } from '../../audit/audit.service';
import { createMockDb, normalizeSql } from '../../test-support/mock-db';
import { ApplicationsService } from './applications.service';
import { activeUserSql } from '../../users/active-user';

/** apply() runs inside db.tx; pool and tx share the same checked mock, assertions read the raw jest.fn */
function serviceWith(query: jest.Mock, audit: Record<string, jest.Mock> = { record: jest.fn() }) {
  return new ApplicationsService(createMockDb({ query, txQuery: query }).database, audit as unknown as AuditService);
}

/** Eligibility lookup for the user, before reading participant rows. */
const ONBOARDED = { rowCount: 1, rows: [{ done: true }] };

describe('ApplicationsService apply (human only)', () => {
  it('stores the user as the application actor (no agent column in the INSERT)', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ application_required: true, status: 'OPEN' }] })
      .mockResolvedValueOnce(ONBOARDED)
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'application', status: 'PENDING' }] });
    await serviceWith(query).apply('bounty', 'user', 'hello', 'https://example.com');

    expect(query.mock.calls[2][0]).toContain('applicant_user_id = $2 FOR UPDATE');
    expect(query.mock.calls[2][1]).toEqual(['bounty', 'user']);
    expect(query.mock.calls[3][0]).not.toContain('agent_id');
    expect(query.mock.calls[3][1]).toEqual(['bounty', 'user', 'hello', 'https://example.com']);
  });

  it('treats a legacy AGENT submission_mode bounty like any other (no mode check anymore)', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ application_required: true, submission_mode: 'AGENT', status: 'OPEN' }] })
      .mockResolvedValueOnce(ONBOARDED)
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'new', status: 'PENDING' }] });
    await expect(serviceWith(query).apply('bounty', 'user', 'hello')).resolves.toEqual({ id: 'new', status: 'PENDING' });
  });

  it('audits a first application as APPLICATION_SUBMITTED in the same tx with the user as actor and no user input', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ application_required: true, status: 'OPEN' }] })
      .mockResolvedValueOnce(ONBOARDED)
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'new', status: 'PENDING' }] });
    const audit = { record: jest.fn() };
    await serviceWith(query, audit).apply('bounty', 'user', 'hello');
    expect(audit.record).toHaveBeenCalledWith('user', 'APPLICATION_SUBMITTED', 'bounty_application', 'new', expect.not.objectContaining({ tx: expect.anything() }), { // the tx client, not the pool
      after: { status: 'PENDING', bountyId: 'bounty' },
    });
  });

  it('a failed audit insert fails the application (the caller transaction rolls back)', async () => {
    const boom = new Error('audit down');
    const query = jest.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ application_required: true, status: 'OPEN' }] })
      .mockResolvedValueOnce(ONBOARDED)
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'new', status: 'PENDING' }] });
    await expect(serviceWith(query, { record: jest.fn().mockRejectedValue(boom) }).apply('bounty', 'user', 'hi')).rejects.toBe(boom);
  });
});

describe('ApplicationsService re-application after withdrawal', () => {
  const openBounty = { rowCount: 1, rows: [{ application_required: true, status: 'OPEN', submission_deadline: '2999-01-01' }] };

  it('reopens the user\'s own WITHDRAWN row: PENDING, new message/portfolio, review fields cleared, id kept, APPLICATION_REAPPLIED in the tx', async () => {
    const o = 1; // the onboarding lookup shifts every later call by one
    const call = (s: ApplicationsService) => s.apply('bounty', 'user', 'again', 'https://p.example');
    const query = jest.fn().mockResolvedValueOnce(openBounty);
    query.mockResolvedValueOnce(ONBOARDED);
    query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'app-1', status: 'WITHDRAWN' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'app-1', status: 'PENDING', applied_at: 'now' }] });
    const audit = { record: jest.fn() };
    const service = serviceWith(query, audit);

    await expect(call(service)).resolves.toEqual({ id: 'app-1', status: 'PENDING', applied_at: 'now' });
    expect(query.mock.calls[1 + o][0]).toContain('applicant_user_id = $2 FOR UPDATE');
    const [sql, params] = query.mock.calls[2 + o];
    expect(sql).toContain("SET status = 'PENDING', message = $2, portfolio_url = $3, applied_at = now()");
    expect(sql).toContain('reviewed_by = NULL, reviewed_at = NULL, review_note = NULL');
    expect(sql).toContain("WHERE id = $1 AND status = 'WITHDRAWN'");
    expect(params).toEqual(['app-1', 'again', 'https://p.example']);
    expect(query).toHaveBeenCalledTimes(3 + o); // no INSERT
    expect(audit.record).toHaveBeenCalledWith('user', 'APPLICATION_REAPPLIED', 'bounty_application', 'app-1', expect.anything(), undefined);
  });

  it.each(['PENDING', 'APPROVED', 'REJECTED'])('keeps 409 ALREADY_APPLIED for an existing %s application', async (status) => {
    const query = jest.fn()
      .mockResolvedValueOnce(openBounty)
      .mockResolvedValueOnce(ONBOARDED)
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'app-1', status }] });
    const audit = { record: jest.fn() };
    await expect(serviceWith(query, audit).apply('bounty', 'user', 'again')).rejects.toMatchObject({ message: 'ALREADY_APPLIED' });
    expect(query).toHaveBeenCalledTimes(3);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('does not reopen when the bounty no longer accepts applications (checks run before the lookup)', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rowCount: 1, rows: [{ ...openBounty.rows[0], status: 'SUBMISSION_CLOSED' }] });
    await expect(serviceWith(query).apply('bounty', 'user', 'again')).rejects.toMatchObject({ message: 'BOUNTY_NOT_OPEN' });
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('ApplicationsService my applications and withdraw', () => {
  function setup() {
    const query = jest.fn().mockResolvedValue({ rowCount: 1, rows: [{ id: 'app', status: 'WITHDRAWN', bounty_id: 'bounty' }] });
    const audit = { record: jest.fn() };
    const mock = createMockDb({ query: jest.fn(), txQuery: query });
    return { query, audit, mock, service: new ApplicationsService(mock.database, audit as unknown as AuditService) };
  }

  it('lists only the user\'s own applications; agent is a constant null shim', async () => {
    const { mock, service } = setup();
    const query = mock.db.query as jest.Mock;
    query.mockResolvedValue({ rowCount: 0, rows: [] });
    await service.myApplications('user');
    const [sql, params] = query.mock.calls[0];
    expect(params).toEqual(['user']);
    expect(sql).toContain('NULL::json AS agent');
    expect(sql).toContain('WHERE a.applicant_user_id = $1');
    expect(sql).not.toContain('agent_id');
    expect(sql).not.toContain('JOIN agent');
    expect(sql).toContain('JOIN bounty b ON b.id = a.bounty_id AND b.deleted_at IS NULL'); // soft-deleted bounties are gone, as on the public profile
    expect(sql).toContain('b.status AS bounty_status, b.submission_deadline, b.application_deadline');
    expect(sql).toContain('ORDER BY a.applied_at DESC');
  });

  it('lets the applicant withdraw a pending application', async () => {
    const { query, audit, mock, service } = setup();
    await expect(service.withdraw('app', 'user')).resolves.toEqual({ id: 'app', status: 'WITHDRAWN' });
    expect(mock.db.tx).toHaveBeenCalledTimes(1);
    // the withdrawing person is the actor, in the same tx as the UPDATE
    expect(audit.record).toHaveBeenCalledWith('user', 'APPLICATION_WITHDRAWN', 'bounty_application', 'app', expect.not.objectContaining({ tx: expect.anything() }), {
      before: { status: 'PENDING' }, after: { status: 'WITHDRAWN', bountyId: 'bounty' },
    });
    const [sql, params] = query.mock.calls[0];
    expect(params).toEqual(['app', 'user']);
    expect(sql).toContain("status = 'PENDING'");
    expect(sql).toContain('AND applicant_user_id = $2');
    expect(sql).not.toContain('agent');
  });
});

describe('ApplicationsService apply rules', () => {
  const FUTURE = '2999-01-01T00:00:00.000Z';
  const bountyRow = (overrides: Record<string, unknown> = {}) => ({
    rowCount: 1,
    rows: [{ application_required: true, status: 'OPEN', submission_deadline: FUTURE, application_deadline: null, ...overrides }],
  });

  it('locks the bounty row first and refuses an unknown/deleted bounty with 404 BOUNTY_NOT_FOUND', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const error = await serviceWith(query).apply('bounty', 'user', 'hi').catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 404, message: 'BOUNTY_NOT_FOUND' });
    expect(query.mock.calls[0][0]).toContain('WHERE id = $1 AND deleted_at IS NULL FOR UPDATE');
    expect(query.mock.calls[0][1]).toEqual(['bounty']);
  });

  it('a submission-type bounty (application_required = false) is 400 SUBMISSION_TYPE_BOUNTY - submit directly instead', async () => {
    const query = jest.fn().mockResolvedValueOnce(bountyRow({ application_required: false }));
    await expect(serviceWith(query).apply('bounty', 'user', 'hi')).rejects.toMatchObject({ status: 400, message: 'SUBMISSION_TYPE_BOUNTY' });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each(['DRAFT', 'FUNDING_PENDING', 'SUBMISSION_CLOSED', 'IN_REVIEW', 'COMPLETED', 'CANCELLED'])('a %s bounty is 400 BOUNTY_NOT_OPEN', async (status) => {
    const query = jest.fn().mockResolvedValueOnce(bountyRow({ status }));
    await expect(serviceWith(query).apply('bounty', 'user', 'hi')).rejects.toMatchObject({ message: 'BOUNTY_NOT_OPEN' });
  });

  it('inserts a first application for a user, portfolio defaulting to NULL', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce(bountyRow())
      .mockResolvedValueOnce(ONBOARDED)
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'new', status: 'PENDING' }] });
    await serviceWith(query).apply('bounty', 'user', 'hello');
    expect(query.mock.calls[2][0]).toContain('applicant_user_id = $2 FOR UPDATE');
    expect(query.mock.calls[3][1]).toEqual(['bounty', 'user', 'hello', null]);
  });

  it('maps a unique violation on INSERT (a concurrent first application) to 409 ALREADY_APPLIED', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce(bountyRow())
      .mockResolvedValueOnce(ONBOARDED)
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'uq_application_user' }));
    await expect(serviceWith(query).apply('bounty', 'user', 'hi')).rejects.toMatchObject({ status: 409, message: 'ALREADY_APPLIED' });
  });

  it.each([
    ['another unique index', 'uq_something_else'],
    ['the retired agent index', 'uq_application_agent'],
    ['no constraint name', undefined],
  ])('rethrows a unique violation from %s instead of calling it ALREADY_APPLIED', async (_what, constraint) => {
    const boom = Object.assign(new Error('duplicate key'), { code: '23505', constraint });
    const query = jest.fn()
      .mockResolvedValueOnce(bountyRow())
      .mockResolvedValueOnce(ONBOARDED)
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockRejectedValueOnce(boom);
    await expect(serviceWith(query).apply('bounty', 'user', 'hi')).rejects.toBe(boom);
  });

  it('rethrows any other database error unchanged', async () => {
    const boom = Object.assign(new Error('fk'), { code: '23503' });
    const query = jest.fn()
      .mockResolvedValueOnce(bountyRow())
      .mockResolvedValueOnce(ONBOARDED)
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockRejectedValueOnce(boom);
    await expect(serviceWith(query).apply('bounty', 'user', 'hi')).rejects.toBe(boom);
  });

  it.each([
    ['submission_deadline', 'application_deadline'],
    ['application_deadline', 'submission_deadline'],
  ])('%s exactly now closes applications (<=) even when %s is far away', async (field, other) => {
    jest.useFakeTimers({ now: new Date('2032-02-02T02:02:02.000Z') });
    try {
      const query = jest.fn().mockResolvedValueOnce(bountyRow({ [field]: '2032-02-02T02:02:02.000Z', [other]: FUTURE }));
      await expect(serviceWith(query).apply('bounty', 'user', 'hi')).rejects.toMatchObject({ message: 'APPLICATION_DEADLINE_PASSED' });
      const later = jest.fn()
        .mockResolvedValueOnce(bountyRow({ [field]: '2032-02-02T02:02:03.000Z', [other]: FUTURE }))
        .mockResolvedValueOnce(ONBOARDED)
        .mockResolvedValueOnce({ rowCount: 0, rows: [] })
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'new', status: 'PENDING' }] });
      await expect(serviceWith(later).apply('bounty', 'user', 'hi')).resolves.toEqual({ id: 'new', status: 'PENDING' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('withdraw of a non-pending, foreign or unknown application is 404 APPLICATION_NOT_FOUND_OR_NOT_PENDING', async () => {
    const query = jest.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    const audit = { record: jest.fn() };
    const service = new ApplicationsService(createMockDb({ query, txQuery: query }).database, audit as unknown as AuditService);
    await expect(service.withdraw('app', 'someone-else')).rejects.toMatchObject({ status: 404, message: 'APPLICATION_NOT_FOUND_OR_NOT_PENDING' });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each([
    ['onboarding not completed', { rowCount: 1, rows: [{ done: false }] }],
    ['the user row is gone', { rowCount: 0, rows: [] }],
  ])('a person who has not finished onboarding (%s) is 409 PROFILE_REQUIRED, nothing is read or written afterwards', async (_label, onboarding) => {
    const query = jest.fn().mockResolvedValueOnce(bountyRow()).mockResolvedValueOnce(onboarding);
    await expect(serviceWith(query).apply('bounty', 'user', 'hi')).rejects.toMatchObject({ status: 409, message: 'PROFILE_REQUIRED' });
    expect(query).toHaveBeenCalledTimes(2);
    expect(normalizeSql(query.mock.calls[1][0])).toContain(`onboarding_completed_at IS NOT NULL AS done FROM "user" WHERE id = $1 AND ${activeUserSql('')} FOR SHARE`);
    expect(query.mock.calls[1][1]).toEqual(['user']);
  });

});

describe('ApplicationsService check order (status, no-application-needed, deadline)', () => {
  const row = (overrides: Record<string, unknown>) => ({
    rowCount: 1,
    rows: [{ application_required: false, status: 'OPEN', submission_deadline: '2999-01-01', application_deadline: null, ...overrides }],
  });
  const apply = (overrides: Record<string, unknown>) =>
    serviceWith(jest.fn().mockResolvedValue(row(overrides))).apply('bounty', 'user', 'hi');

  it('a no-application bounty that is not open answers with the status error; when open, SUBMISSION_TYPE_BOUNTY', async () => {
    await expect(apply({ status: 'DRAFT' })).rejects.toMatchObject({ message: 'BOUNTY_NOT_OPEN' });
    await expect(apply({ status: 'SUBMISSION_CLOSED' })).rejects.toMatchObject({ message: 'BOUNTY_NOT_OPEN' });
    await expect(apply({ status: 'OPEN' })).rejects.toMatchObject({ message: 'SUBMISSION_TYPE_BOUNTY' });
  });
});
