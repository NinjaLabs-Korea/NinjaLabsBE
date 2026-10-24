import { NotFoundException } from '@nestjs/common';
import { withParamsCheck } from '../test-support/expect-params-match';
import { BountiesService, PUBLIC_DETAIL_COLUMNS } from './bounties.service';

function setup(answer: (sql: string) => { rowCount: number; rows: unknown[] }) {
  const query = jest.fn(async (sql: string, _params?: unknown[]) => answer(sql));
  return { query, service: new BountiesService({ query: withParamsCheck(query) } as never) };
}

describe('BountiesService.list (public)', () => {
  const listAnswer = (sql: string) => (sql.includes('count(*)') ? { rowCount: 1, rows: [{ count: '42' }] } : { rowCount: 1, rows: [{ id: 'b1' }] });

  it('hides unpublished and deleted bounties and pages with LIMIT/OFFSET bound after the filters', async () => {
    const { service, query } = setup(listAnswer);
    await expect(service.list()).resolves.toEqual({ items: [{ id: 'b1' }], page: 1, pageSize: 12, total: 42 });
    const [listSql, listParams] = query.mock.calls[0];
    expect(listSql).toContain(`WHERE b.deleted_at IS NULL AND b.status NOT IN ('DRAFT', 'FUNDING_PENDING')`);
    expect(listSql).toContain('LIMIT $1 OFFSET $2');
    expect(listParams).toEqual([12, 0]);
    expect(query.mock.calls[1][1]).toEqual([]);
  });

  it('binds category and status as parameters (never interpolated) and shares them with the count query', async () => {
    const { service, query } = setup(listAnswer);
    await expect(service.list(3, 5, "DEV'; DROP TABLE bounty; --", 'OPEN')).resolves.toMatchObject({ page: 3, pageSize: 5, total: 42 });
    const [listSql, listParams] = query.mock.calls[0];
    expect(listSql).toContain('AND b.category = $1 AND b.status = $2');
    expect(listSql).toContain('LIMIT $3 OFFSET $4');
    expect(listSql).not.toContain('DROP TABLE');
    expect(listParams).toEqual(["DEV'; DROP TABLE bounty; --", 'OPEN', 5, 10]);
    const [countSql, countParams] = query.mock.calls[1];
    expect(countSql).toContain('b.category = $1 AND b.status = $2');
    expect(countParams).toEqual(["DEV'; DROP TABLE bounty; --", 'OPEN']);
  });

  it('status alone takes $1', async () => {
    const { service, query } = setup(listAnswer);
    await service.list(2, 12, undefined, 'COMPLETED');
    expect(query.mock.calls[0][0]).toContain('AND b.status = $1');
    expect(query.mock.calls[0][1]).toEqual(['COMPLETED', 12, 12]);
  });

  it('orders deterministically so pages never overlap', async () => {
    const { service, query } = setup(listAnswer);
    await service.list();
    expect(query.mock.calls[0][0]).toContain('ORDER BY b.opened_at DESC NULLS LAST, b.created_at DESC, b.id');
  });
});

describe('BountiesService.detail (public)', () => {
  it('404 BOUNTY_NOT_FOUND when the bounty is unknown, deleted or unpublished', async () => {
    const { service, query } = setup(() => ({ rowCount: 0, rows: [] }));
    const error = await service.detail('b').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as Error).message).toBe('BOUNTY_NOT_FOUND');
    expect(query.mock.calls[0][0]).toContain(`WHERE b.id = $1 AND b.deleted_at IS NULL`);
    expect(query.mock.calls[0][0]).toContain(`AND b.status NOT IN ('DRAFT', 'FUNDING_PENDING')`);
  });

  it('returns the row and selects an explicit public column list (no operator ids, no deleted_at)', async () => {
    const { service, query } = setup(() => ({ rowCount: 1, rows: [{ id: 'b', title: 't' }] }));
    await expect(service.detail('b')).resolves.toEqual({ id: 'b', title: 't' });
    const sql = query.mock.calls[0][0] as string;
    expect(sql).not.toContain('b.*');
    for (const hidden of ['created_by', 'sponsor_user_id', 'deleted_at']) expect(PUBLIC_DETAIL_COLUMNS).not.toContain(hidden);
    for (const shown of ['b.status', 'b.max_winners', 'b.submission_deadline', 'b.application_deadline', 'b.submission_mode']) expect(PUBLIC_DETAIL_COLUMNS).toContain(shown);
  });
});
