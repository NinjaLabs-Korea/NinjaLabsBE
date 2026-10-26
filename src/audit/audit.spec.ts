import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DatabaseService } from '../common/database/database.service';
import { withParamsCheck } from '../test-support/expect-params-match';
import { createMockDb } from '../test-support/mock-db';
import { AuditController, AuditLogsQueryDto } from './audit.controller';
import { AuditService } from './audit.service';

const failedFields = async (body: object) =>
  (await validate(plainToInstance(AuditLogsQueryDto, body))).map((error) => error.property).sort();

describe('GET /admin/audit-logs query validation', () => {
  it('accepts an empty query and well-formed filters', async () => {
    expect(await failedFields({})).toEqual([]);
    expect(await failedFields({ page: '3', entityType: 'bounty', entityId: '11111111-1111-4111-8111-111111111111' })).toEqual([]);
  });

  it('rejects page < 1 or non-integer, long entityType and non-UUID entityId with 400 instead of a bad query', async () => {
    expect(await failedFields({ page: '0' })).toEqual(['page']);
    expect(await failedFields({ page: 'abc' })).toEqual(['page']);
    expect(await failedFields({ entityType: 'x'.repeat(65) })).toEqual(['entityType']);
    expect(await failedFields({ entityId: 'not-a-uuid' })).toEqual(['entityId']);
  });
});

describe('AuditService.list', () => {
  function setup(rows: unknown[] = [], total = 0) {
    // list() assembles WHERE / LIMIT / OFFSET placeholders dynamically — every statement is checked for $n/params drift
    const query = jest.fn(async (sql: string, _params?: unknown[]) =>
      sql.includes('count(*)') ? { rowCount: 1, rows: [{ total }] } : { rowCount: rows.length, rows });
    return { query, service: new AuditService(createMockDb({ query }).database) };
  }

  it('returns the paginated envelope { items, page, pageSize, total } with bound filters', async () => {
    const { query, service } = setup([{ id: 'a' }], 61);
    await expect(service.list({ page: 3, entityType: 'bounty', entityId: 'e' })).resolves.toEqual({
      items: [{ id: 'a' }], page: 3, pageSize: 30, total: 61,
    });
    const [listSql, listParams] = query.mock.calls.find(([sql]) => sql.includes('ORDER BY a.created_at DESC'))!;
    expect(listSql).toContain('WHERE a.entity_type = $1 AND a.entity_id = $2');
    expect(listParams).toEqual(['bounty', 'e', 30, 60]);
    const [countSql, countParams] = query.mock.calls.find(([sql]) => sql.includes('count(*)'))!;
    expect(countSql).toContain('WHERE a.entity_type = $1 AND a.entity_id = $2');
    expect(countParams).toEqual(['bounty', 'e']);
  });

  it('omits the WHERE clause when no filter is given', async () => {
    const { query, service } = setup();
    await service.list({ page: 1 });
    expect(query.mock.calls.every(([sql]) => !sql.includes('WHERE'))).toBe(true);
    expect(query.mock.calls[0][1]).toEqual([30, 0]);
    expect(query.mock.calls[1][1]).toEqual([]);
  });

  it('numbers the placeholders after a single filter so LIMIT/OFFSET follow it ($2/$3)', async () => {
    const { query, service } = setup();
    await service.list({ page: 2, entityId: 'e' });
    const [listSql, listParams] = query.mock.calls.find(([sql]) => sql.includes('ORDER BY a.created_at DESC'))!;
    expect(listSql).toContain('WHERE a.entity_id = $1');
    expect(listSql).toContain('LIMIT $2 OFFSET $3');
    expect(listParams).toEqual(['e', 30, 30]);
  });
});

describe('AuditService.record', () => {
  it('binds actor/action/entity in order and stores a missing actor (system job) as NULL', async () => {
    const query = jest.fn(async (_sql: string, _params?: unknown[]) => ({ rowCount: 1, rows: [] }));
    const service = new AuditService(createMockDb({ query }).database);
    await service.record(undefined, 'NFT_MINTED', 'nft', 'e1');
    await service.record('u1', 'BOUNTY_UPDATED', 'bounty', 'e2');
    expect(query.mock.calls.map(([sql, params]) => [sql.includes('INSERT INTO audit_log'), params])).toEqual([
      [true, [null, 'NFT_MINTED', 'nft', 'e1']],
      [true, ['u1', 'BOUNTY_UPDATED', 'bounty', 'e2']],
    ]);
  });

  it('recordAgentAction fills actor_agent_id and leaves actor_user_id NULL (an Agent API key has no user)', async () => {
    const tx = { query: jest.fn(withParamsCheck(async (_sql: string, _params?: unknown[]) => ({ rowCount: 1 }))) };
    await new AuditService(createMockDb({ query: jest.fn() }).database).recordAgentAction('agent-1', 'APPLICATION_REAPPLIED', 'bounty_application', 'e1', tx);
    const [sql, params] = tx.query.mock.calls[0];
    expect(sql).toContain('(actor_agent_id, action, entity_type, entity_id)');
    expect(params).toEqual(['agent-1', 'APPLICATION_REAPPLIED', 'bounty_application', 'e1']);
  });

  it('writes through the given transaction runner instead of the pool, so the audit row commits or rolls back with the change', async () => {
    const pool = jest.fn();
    const tx = { query: jest.fn(withParamsCheck(async (_sql: string, _params?: unknown[]) => ({ rowCount: 1 }))) };
    await new AuditService({ query: pool } as unknown as DatabaseService).record('u1', 'A', 'bounty', 'e', tx);
    expect(pool).not.toHaveBeenCalled();
    expect(tx.query).toHaveBeenCalledTimes(1);
  });

  it("propagates a failed insert (the caller's transaction must roll back, not silently lose the audit trail)", async () => {
    const failure = Object.assign(new Error('value too long'), { code: '22001' });
    const service = new AuditService({ query: jest.fn().mockRejectedValue(failure) } as unknown as DatabaseService);
    await expect(service.record('u1', 'X'.repeat(101), 'bounty', 'e')).rejects.toBe(failure);
  });
});

describe('AuditController', () => {
  it('defaults to page 1 and forwards the filters', async () => {
    const list = jest.fn().mockResolvedValue('page');
    const controller = new AuditController({ list } as unknown as AuditService);
    await expect(controller.list({})).resolves.toBe('page');
    await controller.list({ page: 2, entityType: 'bounty', entityId: 'e' });
    expect(list.mock.calls).toEqual([[{ page: 1, entityType: undefined, entityId: undefined }], [{ page: 2, entityType: 'bounty', entityId: 'e' }]]);
  });

  it('rejects a page above MAX_PAGE (OFFSET overflow) and a non-integer page', async () => {
    expect(await failedFields({ page: '100001' })).toEqual(['page']);
    expect(await failedFields({ page: '1.5' })).toEqual(['page']);
    expect(await failedFields({ page: '100000' })).toEqual([]);
  });
});
