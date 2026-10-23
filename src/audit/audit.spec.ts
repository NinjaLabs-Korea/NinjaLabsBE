import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DatabaseService } from '../common/database/database.service';
import { AuditLogsQueryDto } from './audit.controller';
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
    const query = jest.fn(async (sql: string, _params?: unknown[]) =>
      sql.includes('count(*)') ? { rowCount: 1, rows: [{ total }] } : { rowCount: rows.length, rows });
    return { query, service: new AuditService({ query } as unknown as DatabaseService) };
  }

  it('returns the paginated envelope { items, page, pageSize, total } with bound filters', async () => {
    const { query, service } = setup([{ id: 'a' }], 61);
    await expect(service.list({ page: 3, entityType: 'bounty', entityId: 'e' })).resolves.toEqual({
      items: [{ id: 'a' }], page: 3, pageSize: 30, total: 61,
    });
    const [listSql, listParams] = query.mock.calls.find(([sql]) => sql.includes('ORDER BY created_at DESC'))!;
    expect(listSql).toContain('WHERE entity_type = $1 AND entity_id = $2');
    expect(listParams).toEqual(['bounty', 'e', 30, 60]);
    const [countSql, countParams] = query.mock.calls.find(([sql]) => sql.includes('count(*)'))!;
    expect(countSql).toContain('WHERE entity_type = $1 AND entity_id = $2');
    expect(countParams).toEqual(['bounty', 'e']);
  });

  it('omits the WHERE clause when no filter is given', async () => {
    const { query, service } = setup();
    await service.list({ page: 1 });
    expect(query.mock.calls.every(([sql]) => !sql.includes('WHERE'))).toBe(true);
    expect(query.mock.calls[0][1]).toEqual([30, 0]);
  });
});
