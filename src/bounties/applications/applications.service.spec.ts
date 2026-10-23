import { BadRequestException } from '@nestjs/common';
import { DatabaseService } from '../../common/database/database.service';
import { withParamsCheck } from '../../test-support/expect-params-match';
import { ApplicationsService } from './applications.service';

/** apply() runs inside db.tx; the runner the callback receives is the same checked mock, assertions read the raw jest.fn */
function serviceWith(query: jest.Mock) {
  const runner = { query: withParamsCheck(query) };
  return new ApplicationsService({ ...runner, tx: (fn: (tx: typeof runner) => Promise<unknown>) => fn(runner) } as unknown as DatabaseService);
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
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'application', status: 'PENDING' }] });
    const service = serviceWith(query);

    await service.applyAsAgent('bounty', 'agent', 'hello', 'https://example.com');

    expect(query.mock.calls[1][1]).toEqual([
      'bounty', null, 'agent', 'hello', 'https://example.com',
    ]);
  });
});

describe('ApplicationsService owner visibility of agent applications', () => {
  function setup() {
    const query = jest.fn().mockResolvedValue({ rowCount: 1, rows: [{ id: 'app', status: 'WITHDRAWN' }] });
    const db = { query: withParamsCheck(query), tx: jest.fn() };
    return { query, service: new ApplicationsService(db as unknown as DatabaseService) };
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
