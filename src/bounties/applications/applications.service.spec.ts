import { BadRequestException } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service';
import { DatabaseService } from '../../common/database/database.service';
import { withParamsCheck } from '../../test-support/expect-params-match';
import { ApplicationsService } from './applications.service';

/** apply() runs inside db.tx; the runner the callback receives is the same checked mock, assertions read the raw jest.fn */
function serviceWith(query: jest.Mock, audit = { record: jest.fn() }) {
  const runner = { query: withParamsCheck(query) };
  return new ApplicationsService(
    { ...runner, tx: (fn: (tx: typeof runner) => Promise<unknown>) => fn(runner) } as unknown as DatabaseService,
    audit as unknown as AuditService,
  );
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
    ['user', 'applicant_user_id', (s: ApplicationsService) => s.apply('bounty', 'user', 'again', 'https://p.example'), 'user'],
    ['agent', 'agent_id', (s: ApplicationsService) => s.applyAsAgent('bounty', 'agent', 'again', 'https://p.example'), undefined],
  ] as const)('reopens the %s\'s own WITHDRAWN row: PENDING, new message/portfolio, review fields cleared, id kept, APPLICATION_REAPPLIED in the tx', async (_kind, column, call, auditActor) => {
    const query = jest.fn()
      .mockResolvedValueOnce(openBounty)
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'app-1', status: 'WITHDRAWN' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'app-1', status: 'PENDING', applied_at: 'now' }] });
    const audit = { record: jest.fn() };
    const service = serviceWith(query, audit);

    await expect(call(service)).resolves.toEqual({ id: 'app-1', status: 'PENDING', applied_at: 'now' });
    expect(query.mock.calls[1][0]).toContain(`${column} = $2 FOR UPDATE`);
    const [sql, params] = query.mock.calls[2];
    expect(sql).toContain("SET status = 'PENDING', message = $2, portfolio_url = $3, applied_at = now()");
    expect(sql).toContain('reviewed_by = NULL, reviewed_at = NULL, review_note = NULL');
    expect(sql).toContain("WHERE id = $1 AND status = 'WITHDRAWN'");
    expect(params).toEqual(['app-1', 'again', 'https://p.example']);
    expect(query).toHaveBeenCalledTimes(3); // no INSERT
    expect(audit.record).toHaveBeenCalledWith(auditActor, 'APPLICATION_REAPPLIED', 'bounty_application', 'app-1', expect.anything());
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
    const db = { query: withParamsCheck(query), tx: jest.fn() };
    return { query, service: new ApplicationsService(db as unknown as DatabaseService, { record: jest.fn() } as unknown as AuditService) };
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
