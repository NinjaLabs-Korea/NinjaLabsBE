import { BadRequestException } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service';
import { createMockDb } from '../../test-support/mock-db';
import { ApplicationsService } from './applications.service';

/** apply() runs inside db.tx; pool and tx share the same checked mock, assertions read the raw jest.fn */
function serviceWith(query: jest.Mock, audit = { record: jest.fn() }) {
  return new ApplicationsService(createMockDb({ query, txQuery: query }).database, audit as unknown as AuditService);
}

describe('ApplicationsService submission modes', () => {
  it('rejects a browser user on an agent-only bounty', async () => {
    const query = jest.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{ application_required: true, submission_mode: 'AGENT', status: 'OPEN' }],
    });
    const service = serviceWith(query);

    await expect(service.apply('bounty', 'user', 'hello')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.apply('bounty', 'user', 'hello')).rejects.toMatchObject({
      message: 'AGENT_SUBMISSION_REQUIRED',
    });
  });

  it('stores the authenticated agent as the application actor', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ application_required: true, submission_mode: 'AGENT', status: 'OPEN' }],
      })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'application', status: 'PENDING' }] });
    const service = serviceWith(query);

    await service.applyAsAgent('bounty', 'agent', 'hello', 'https://example.com');

    expect(query.mock.calls[1][0]).toContain('agent_id = $2 FOR UPDATE');
    expect(query.mock.calls[1][1]).toEqual(['bounty', 'agent']);
    expect(query.mock.calls[2][1]).toEqual([
      'bounty', null, 'agent', 'hello', 'https://example.com',
    ]);
  });
});

describe('ApplicationsService re-application after withdrawal', () => {
  const openBounty = { rowCount: 1, rows: [{ application_required: true, submission_mode: 'BOTH', status: 'OPEN', submission_deadline: '2999-01-01' }] };

  it.each([
    ['user', 'applicant_user_id', (s: ApplicationsService) => s.apply('bounty', 'user', 'again', 'https://p.example'), 'record'],
    ['agent', 'agent_id', (s: ApplicationsService) => s.applyAsAgent('bounty', 'agent', 'again', 'https://p.example'), 'recordAgentAction'],
  ] as const)('reopens the %s\'s own WITHDRAWN row: PENDING, new message/portfolio, review fields cleared, id kept, APPLICATION_REAPPLIED in the tx', async (kind, column, call, auditMethod) => {
    const query = jest.fn()
      .mockResolvedValueOnce(openBounty)
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'app-1', status: 'WITHDRAWN' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'app-1', status: 'PENDING', applied_at: 'now' }] });
    const audit = { record: jest.fn(), recordAgentAction: jest.fn() };
    const service = serviceWith(query, audit);

    await expect(call(service)).resolves.toEqual({ id: 'app-1', status: 'PENDING', applied_at: 'now' });
    expect(query.mock.calls[1][0]).toContain(`${column} = $2 FOR UPDATE`);
    const [sql, params] = query.mock.calls[2];
    expect(sql).toContain("SET status = 'PENDING', message = $2, portfolio_url = $3, applied_at = now()");
    expect(sql).toContain('reviewed_by = NULL, reviewed_at = NULL, review_note = NULL');
    expect(sql).toContain("WHERE id = $1 AND status = 'WITHDRAWN'");
    expect(params).toEqual(['app-1', 'again', 'https://p.example']);
    expect(query).toHaveBeenCalledTimes(3); // no INSERT
    // the agent path has no user id: the row must carry actor_agent_id (recordAgentAction), not an anonymous record()
    const other = auditMethod === 'record' ? 'recordAgentAction' : 'record';
    expect(audit[auditMethod]).toHaveBeenCalledWith(kind, 'APPLICATION_REAPPLIED', 'bounty_application', 'app-1', expect.anything());
    expect(audit[other]).not.toHaveBeenCalled();
  });

  it.each(['PENDING', 'APPROVED', 'REJECTED'])('keeps 409 ALREADY_APPLIED for an existing %s application', async (status) => {
    const query = jest.fn()
      .mockResolvedValueOnce(openBounty)
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'app-1', status }] });
    const audit = { record: jest.fn() };
    await expect(serviceWith(query, audit).apply('bounty', 'user', 'again')).rejects.toMatchObject({ message: 'ALREADY_APPLIED' });
    expect(query).toHaveBeenCalledTimes(2);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('does not reopen when the bounty no longer accepts applications (checks run before the lookup)', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rowCount: 1, rows: [{ ...openBounty.rows[0], status: 'SUBMISSION_CLOSED' }] });
    await expect(serviceWith(query).apply('bounty', 'user', 'again')).rejects.toMatchObject({ message: 'BOUNTY_NOT_OPEN' });
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('ApplicationsService owner visibility of agent applications', () => {
  function setup() {
    const query = jest.fn().mockResolvedValue({ rowCount: 1, rows: [{ id: 'app', status: 'WITHDRAWN' }] });
    return { query, service: new ApplicationsService(createMockDb({ query }).database, { record: jest.fn() } as unknown as AuditService) };
  }

  it('lists applications made by the user or by agents the user owns, each with agent {id, name} | null', async () => {
    const { query, service } = setup();
    await service.myApplications('user');
    const [sql, params] = query.mock.calls[0];
    expect(params).toEqual(['user']);
    expect(sql).toContain("json_build_object('id', ag.id, 'name', ag.name) END AS agent");
    expect(sql).toContain('LEFT JOIN agent ag ON ag.id = a.agent_id');
    expect(sql).toContain('WHERE a.applicant_user_id = $1');
    // `= ANY(ARRAY(subquery))` so the planner can BitmapOr idx_application_applicant + idx_application_agent (0015); `IN (subquery)` cannot
    expect(sql).toContain('OR a.agent_id = ANY(ARRAY(SELECT id FROM agent WHERE owner_user_id = $1 AND deleted_at IS NULL))');
    expect(sql).not.toContain('agent_id IN (');
    expect(sql).toContain('ORDER BY a.applied_at DESC');
  });

  it('lets the owner withdraw a pending application made by one of their agents', async () => {
    const { query, service } = setup();
    await expect(service.withdraw('app', 'user')).resolves.toEqual({ id: 'app', status: 'WITHDRAWN' });
    const [sql, params] = query.mock.calls[0];
    expect(params).toEqual(['app', 'user']);
    expect(sql).toContain("status = 'PENDING'");
    expect(sql).toContain('applicant_user_id = $2');
    expect(sql).toContain('OR agent_id = ANY(ARRAY(SELECT id FROM agent WHERE owner_user_id = $2 AND deleted_at IS NULL))');
  });
});

describe('ApplicationsService apply rules', () => {
  const FUTURE = '2999-01-01T00:00:00.000Z';
  const bountyRow = (overrides: Record<string, unknown> = {}) => ({
    rowCount: 1,
    rows: [{ application_required: true, submission_mode: 'DIRECT', status: 'OPEN', submission_deadline: FUTURE, application_deadline: null, ...overrides }],
  });

  it('locks the bounty row first and refuses an unknown/deleted bounty with 404 BOUNTY_NOT_FOUND', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const error = await serviceWith(query).apply('bounty', 'user', 'hi').catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 404, message: 'BOUNTY_NOT_FOUND' });
    expect(query.mock.calls[0][0]).toContain('WHERE id = $1 AND deleted_at IS NULL FOR UPDATE');
    expect(query.mock.calls[0][1]).toEqual(['bounty']);
  });

  it('a submission-type bounty (application_required = false) is 400 SUBMISSION_TYPE_BOUNTY — submit directly instead', async () => {
    const query = jest.fn().mockResolvedValueOnce(bountyRow({ application_required: false }));
    await expect(serviceWith(query).apply('bounty', 'user', 'hi')).rejects.toMatchObject({ status: 400, message: 'SUBMISSION_TYPE_BOUNTY' });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each(['DRAFT', 'FUNDING_PENDING', 'SUBMISSION_CLOSED', 'IN_REVIEW', 'COMPLETED', 'CANCELLED'])('a %s bounty is 400 BOUNTY_NOT_OPEN', async (status) => {
    const query = jest.fn().mockResolvedValueOnce(bountyRow({ status }));
    await expect(serviceWith(query).apply('bounty', 'user', 'hi')).rejects.toMatchObject({ message: 'BOUNTY_NOT_OPEN' });
  });

  it('a DIRECT bounty refuses an agent (400 DIRECT_SUBMISSION_REQUIRED), an AGENT bounty refuses a person (400 AGENT_SUBMISSION_REQUIRED)', async () => {
    await expect(serviceWith(jest.fn().mockResolvedValueOnce(bountyRow({ submission_mode: 'DIRECT' }))).applyAsAgent('bounty', 'agent', 'hi'))
      .rejects.toMatchObject({ message: 'DIRECT_SUBMISSION_REQUIRED' });
    await expect(serviceWith(jest.fn().mockResolvedValueOnce(bountyRow({ submission_mode: 'AGENT' }))).apply('bounty', 'user', 'hi'))
      .rejects.toMatchObject({ message: 'AGENT_SUBMISSION_REQUIRED' });
    for (const [mode, call] of [
      ['DIRECT', (s: ApplicationsService) => s.apply('bounty', 'user', 'hi')],
      ['AGENT', (s: ApplicationsService) => s.applyAsAgent('bounty', 'agent', 'hi')],
    ] as const) {
      const query = jest.fn()
        .mockResolvedValueOnce(bountyRow({ submission_mode: mode }))
        .mockResolvedValueOnce({ rowCount: 0, rows: [] })
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'new', status: 'PENDING' }] });
      await expect(call(serviceWith(query))).resolves.toEqual({ id: 'new', status: 'PENDING' });
    }
  });

  it('inserts a first application for a user with the user column set and the agent column NULL, portfolio defaulting to NULL', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce(bountyRow())
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'new', status: 'PENDING' }] });
    const audit = { record: jest.fn() };
    await serviceWith(query, audit).apply('bounty', 'user', 'hello');
    expect(query.mock.calls[1][0]).toContain('applicant_user_id = $2 FOR UPDATE');
    expect(query.mock.calls[2][1]).toEqual(['bounty', 'user', null, 'hello', null]);
    expect(audit.record).not.toHaveBeenCalled(); // first applications are not audited, only re-applications
  });

  it('maps a unique violation on INSERT (a concurrent first application) to 409 ALREADY_APPLIED', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce(bountyRow())
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'uq_application_user' }));
    await expect(serviceWith(query).apply('bounty', 'user', 'hi')).rejects.toMatchObject({ status: 409, message: 'ALREADY_APPLIED' });
  });

  it('rethrows any other database error unchanged', async () => {
    const boom = Object.assign(new Error('fk'), { code: '23503' });
    const query = jest.fn()
      .mockResolvedValueOnce(bountyRow())
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
        .mockResolvedValueOnce({ rowCount: 0, rows: [] })
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'new', status: 'PENDING' }] });
      await expect(serviceWith(later).apply('bounty', 'user', 'hi')).resolves.toEqual({ id: 'new', status: 'PENDING' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('withdraw of a non-pending, foreign or unknown application is 404 APPLICATION_NOT_FOUND_OR_NOT_PENDING', async () => {
    const query = jest.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    const service = new ApplicationsService(createMockDb({ query }).database, { record: jest.fn() } as unknown as AuditService);
    await expect(service.withdraw('app', 'someone-else')).rejects.toMatchObject({ status: 404, message: 'APPLICATION_NOT_FOUND_OR_NOT_PENDING' });
  });
});
