import { AuditService } from '../audit/audit.service';
import { createMockDb } from '../test-support/mock-db';
import { NoticeAdminService } from './notice-admin.service';

describe('NoticeAdminService update', () => {
  const noticeId = '11111111-1111-4111-8111-111111111111';
  const adminId = '22222222-2222-4222-8222-222222222222';

  function setup() {
    // tx.query (transaction client) and db.query (autocommit pool) are separate mocks: the mutation AND its audit row must both run on
    // the transaction client, so anything reaching db.query is a bug. The dynamic UPDATE builder is checked for $n/params drift on every call.
    const query = jest.fn().mockResolvedValue({ rowCount: 1, rows: [{ id: noticeId, status: 'PUBLISHED' }] });
    const { database, db } = createMockDb({ txQuery: query });
    const service = new NoticeAdminService(database, new AuditService(createMockDb().database));
    return { db, query, service };
  }

  it('keeps the original published_at when an already published notice is saved with publish: true', async () => {
    const { db, query, service } = setup();
    await service.update(noticeId, { title: 'edited', publish: true }, adminId);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('published_at = COALESCE(published_at, now())');
    expect(sql).not.toMatch(/published_at = \$\d/);
    expect(params).toEqual([noticeId, 'edited', 'PUBLISHED']);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('clears published_at when unpublishing', async () => {
    const { db, query, service } = setup();
    await service.update(noticeId, { publish: false }, adminId);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('status = $2, published_at = $3');
    expect(sql).not.toContain('COALESCE');
    expect(params).toEqual([noticeId, 'DRAFT', null]);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('does not touch status or published_at when publish is omitted', async () => {
    const { db, query, service } = setup();
    await service.update(noticeId, { summary: 's' }, adminId);

    const [sql, params] = query.mock.calls[0];
    expect(sql).not.toContain('published_at');
    expect(params).toEqual([noticeId, 's']);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('binds every provided column in declaration order ($2.. in the SET list) and nothing else', async () => {
    const { query, service } = setup();
    await service.update(noticeId, { body: 'b', category: 'EVENT', externalUrl: 'https://x.test', publish: true }, adminId);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('UPDATE notice SET body = $2, category = $3, external_url = $4, status = $5, published_at = COALESCE(published_at, now()) WHERE id = $1 AND deleted_at IS NULL');
    expect(params).toEqual([noticeId, 'b', 'EVENT', 'https://x.test', 'PUBLISHED']);
  });

  it.each([
    ['create', (s: NoticeAdminService) => s.create(adminId, { title: 't', body: 'b', category: 'EVENT', publish: true }), 'NOTICE_PUBLISHED'],
    ['update', (s: NoticeAdminService) => s.update(noticeId, { title: 't' }, adminId), 'NOTICE_UPDATED'],
    ['remove', (s: NoticeAdminService) => s.remove(noticeId, adminId), 'NOTICE_DELETED'],
  ])('records the %s audit row inside the same transaction as the mutation', async (_label, run, action) => {
    const { db, query, service } = setup();
    await run(service);
    expect(db.tx).toHaveBeenCalledTimes(1);
    const sqls = query.mock.calls.map(([sql]) => sql as string);
    expect(sqls).toHaveLength(2);
    expect(sqls[1]).toContain('INSERT INTO audit_log');
    expect(query.mock.calls[1][1]).toEqual([adminId, action, 'notice', noticeId]);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('rolls the audit row back with the mutation when the notice does not exist', async () => {
    const { db, query, service } = setup();
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(service.remove(noticeId, adminId)).rejects.toMatchObject({ message: 'NOTICE_NOT_FOUND' });
    expect(query).toHaveBeenCalledTimes(1);
    expect(db.query).not.toHaveBeenCalled();
  });
});
