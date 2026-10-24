import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { createMockDb } from '../test-support/mock-db';
import { NoticesController } from './notices.controller';
import { NoticesService } from './notices.service';

function setup(rows: unknown[] = [], count = '0') {
  const query = jest.fn(async (sql: string, _params?: unknown[]) =>
    sql.includes('count(*)') ? { rowCount: 1, rows: [{ count }] } : { rowCount: rows.length, rows });
  return { query, service: new NoticesService(createMockDb({ query }).database) };
}

const listCall = (query: jest.Mock) => query.mock.calls.find(([sql]) => sql.includes('LIMIT'))!;
const countCall = (query: jest.Mock) => query.mock.calls.find(([sql]) => sql.includes('count(*)'))!;

describe('NoticesService.list', () => {
  it('returns { items, page, pageSize, total } with total parsed from the bigint string count', async () => {
    const { service } = setup([{ id: 'n1' }, { id: 'n2' }], '42');
    await expect(service.list(3, 2)).resolves.toEqual({ items: [{ id: 'n1' }, { id: 'n2' }], page: 3, pageSize: 2, total: 42 });
  });

  it.each([
    [1, 10, 0],
    [2, 10, 10],
    [5, 7, 28],
    [100_000, 50, 4_999_950], // MAX_PAGE × max pageSize stays an ordinary integer offset
  ])('page %p, pageSize %p → LIMIT/OFFSET bound as [%p-sized, %p]', async (page, pageSize, offset) => {
    const { query, service } = setup();
    await service.list(page, pageSize);
    expect(listCall(query)[1]).toEqual([pageSize, offset]);
  });

  it('without a category only published, non-deleted notices are listed and the count has no parameters', async () => {
    const { query, service } = setup();
    await service.list();
    const [listSql, listParams] = listCall(query);
    expect(listSql).toContain(`status = 'PUBLISHED' AND deleted_at IS NULL`);
    expect(listSql).not.toContain('category =');
    expect(listParams).toEqual([10, 0]); // defaults page 1, pageSize 10
    const [countSql, countParams] = countCall(query);
    expect(countSql).toContain(`status = 'PUBLISHED' AND deleted_at IS NULL`);
    expect(countParams).toEqual([]);
  });

  it('binds the category as a parameter ($3 in the list, $1 in the count) — never interpolated', async () => {
    const hostile = `EVENT' OR '1'='1`;
    const { query, service } = setup();
    await service.list(1, 10, hostile);
    const [listSql, listParams] = listCall(query);
    expect(listSql).toContain('category = $3');
    expect(listSql).not.toContain(hostile);
    expect(listParams).toEqual([10, 0, hostile]);
    const [countSql, countParams] = countCall(query);
    expect(countSql).toContain('category = $1');
    expect(countParams).toEqual([hostile]);
  });

  it('treats an empty category as "no filter" (the FE sends ?category= for "all")', async () => {
    const { query, service } = setup();
    await service.list(1, 10, '');
    expect(listCall(query)[1]).toEqual([10, 0]);
    expect(countCall(query)[1]).toEqual([]);
  });

  it('orders with a unique tie-breaker so pages never overlap when published_at ties', async () => {
    const { query, service } = setup();
    await service.list();
    expect(listCall(query)[0]).toMatch(/ORDER BY published_at DESC, created_at DESC, id\b/);
  });

  it('never selects the body or admin-only columns in the list', async () => {
    const { query, service } = setup();
    await service.list();
    const columns = /SELECT([\s\S]*?)FROM/.exec(listCall(query)[0])![1].split(',').map((c) => c.trim());
    expect(columns).toEqual(['id', 'title', 'summary', 'category', 'thumbnail_url', 'external_url', 'published_at']);
  });
});

describe('NoticesService.detail', () => {
  it('returns the published notice row', async () => {
    const row = { id: 'n1', title: 't', body: 'b' };
    const { query, service } = setup([row]);
    await expect(service.detail('n1')).resolves.toBe(row);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain(`status = 'PUBLISHED' AND deleted_at IS NULL`);
    expect(params).toEqual(['n1']);
  });

  it('throws 404 NOTICE_NOT_FOUND for a missing, draft or deleted notice', async () => {
    const { service } = setup([]);
    const error = await service.detail('n1').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).getStatus()).toBe(404);
    expect((error as NotFoundException).message).toBe('NOTICE_NOT_FOUND');
  });
});

describe('NoticesController', () => {
  it('fills page 1 / pageSize 10 when omitted and forwards category', async () => {
    const list = jest.fn().mockResolvedValue('ok');
    const controller = new NoticesController({ list } as unknown as NoticesService);
    await controller.list({});
    await controller.list({ page: 4, pageSize: 25, category: 'EVENT' });
    expect(list.mock.calls).toEqual([[1, 10, undefined], [4, 25, 'EVENT']]);
  });
});
