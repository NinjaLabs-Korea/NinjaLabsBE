import { BadRequestException } from '@nestjs/common';
import { DatabaseService } from '../../common/database/database.service';
import { ApplicationsService } from './applications.service';

describe('ApplicationsService submission modes', () => {
  it('rejects a browser user on an agent-only bounty', async () => {
    const db = {
      query: jest.fn().mockResolvedValue({
        rowCount: 1,
        rows: [{ application_required: true, submission_mode: 'AGENT', status: 'OPEN' }],
      }),
    };
    const service = new ApplicationsService({ ...db, tx: (fn: (tx: typeof db) => Promise<unknown>) => fn(db) } as unknown as DatabaseService);

    await expect(service.apply('bounty', 'user', 'hello')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.apply('bounty', 'user', 'hello')).rejects.toMatchObject({
      message: 'AGENT_SUBMISSION_REQUIRED',
    });
  });

  it('stores the authenticated agent as the application actor', async () => {
    const db = {
      query: jest.fn()
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{ application_required: true, submission_mode: 'AGENT', status: 'OPEN' }],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'application', status: 'PENDING' }] }),
    };
    const service = new ApplicationsService({ ...db, tx: (fn: (tx: typeof db) => Promise<unknown>) => fn(db) } as unknown as DatabaseService);

    await service.applyAsAgent('bounty', 'agent', 'hello', 'https://example.com');

    expect(db.query.mock.calls[1][1]).toEqual([
      'bounty', null, 'agent', 'hello', 'https://example.com',
    ]);
  });
});

describe('ApplicationsService owner visibility of agent applications', () => {
  function setup() {
    const db = { query: jest.fn().mockResolvedValue({ rowCount: 1, rows: [{ id: 'app', status: 'WITHDRAWN' }] }), tx: jest.fn() };
    return { db, service: new ApplicationsService(db as unknown as DatabaseService) };
  }

  it('lists applications made by the user or by agents the user owns, each with agent {id, name} | null', async () => {
    const { db, service } = setup();
    await service.myApplications('user');
    const [sql, params] = db.query.mock.calls[0];
    expect(params).toEqual(['user']);
    expect(sql).toContain("json_build_object('id', ag.id, 'name', ag.name) END AS agent");
    expect(sql).toContain('LEFT JOIN agent ag ON ag.id = a.agent_id');
    expect(sql).toContain('WHERE a.applicant_user_id = $1');
    expect(sql).toContain('OR a.agent_id IN (SELECT id FROM agent WHERE owner_user_id = $1 AND deleted_at IS NULL)');
    expect(sql).toContain('ORDER BY a.applied_at DESC');
  });

  it('lets the owner withdraw a pending application made by one of their agents', async () => {
    const { db, service } = setup();
    await expect(service.withdraw('app', 'user')).resolves.toEqual({ id: 'app', status: 'WITHDRAWN' });
    const [sql, params] = db.query.mock.calls[0];
    expect(params).toEqual(['app', 'user']);
    expect(sql).toContain("status = 'PENDING'");
    expect(sql).toContain('applicant_user_id = $2');
    expect(sql).toContain('OR agent_id IN (SELECT id FROM agent WHERE owner_user_id = $2 AND deleted_at IS NULL)');
  });
});
