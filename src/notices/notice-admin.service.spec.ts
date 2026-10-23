import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../common/database/database.service';
import { NoticeAdminService } from './notice-admin.service';

describe('NoticeAdminService update', () => {
  const noticeId = '11111111-1111-4111-8111-111111111111';
  const adminId = '22222222-2222-4222-8222-222222222222';

  function setup() {
    const query = jest.fn().mockResolvedValue({ rowCount: 1, rows: [{ id: noticeId, status: 'PUBLISHED' }] });
    const tx = { query };
    // 감사 로그는 공지 변경과 같은 트랜잭션 클라이언트로 기록돼야 한다 — db.query는 직접 쓰이지 않는다
    const db = {
      query,
      tx: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    };
    const service = new NoticeAdminService(
      db as unknown as DatabaseService,
      new AuditService({ query: jest.fn() } as unknown as DatabaseService),
    );
    return { db, service };
  }

  it('keeps the original published_at when an already published notice is saved with publish: true', async () => {
    const { db, service } = setup();
    await service.update(noticeId, { title: 'edited', publish: true }, adminId);

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('published_at = COALESCE(published_at, now())');
    expect(sql).not.toMatch(/published_at = \$\d/);
    expect(params).toEqual([noticeId, 'edited', 'PUBLISHED']);
  });

  it('clears published_at when unpublishing', async () => {
    const { db, service } = setup();
    await service.update(noticeId, { publish: false }, adminId);

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('status = $2, published_at = $3');
    expect(sql).not.toContain('COALESCE');
    expect(params).toEqual([noticeId, 'DRAFT', null]);
  });

  it('does not touch status or published_at when publish is omitted', async () => {
    const { db, service } = setup();
    await service.update(noticeId, { summary: 's' }, adminId);

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).not.toContain('published_at');
    expect(params).toEqual([noticeId, 's']);
  });

  it.each([
    ['create', (s: NoticeAdminService) => s.create(adminId, { title: 't', body: 'b', category: 'EVENT', publish: true }), 'NOTICE_PUBLISHED'],
    ['update', (s: NoticeAdminService) => s.update(noticeId, { title: 't' }, adminId), 'NOTICE_UPDATED'],
    ['remove', (s: NoticeAdminService) => s.remove(noticeId, adminId), 'NOTICE_DELETED'],
  ])('records the %s audit row inside the same transaction as the mutation', async (_label, run, action) => {
    const { db, service } = setup();
    await run(service);
    expect(db.tx).toHaveBeenCalledTimes(1);
    const sqls = db.query.mock.calls.map(([sql]) => sql as string);
    expect(sqls).toHaveLength(2);
    expect(sqls[1]).toContain('INSERT INTO audit_log');
    expect(db.query.mock.calls[1][1]).toEqual([adminId, action, 'notice', noticeId]);
  });

  it('rolls the audit row back with the mutation when the notice does not exist', async () => {
    const { db, service } = setup();
    db.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(service.remove(noticeId, adminId)).rejects.toMatchObject({ message: 'NOTICE_NOT_FOUND' });
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});
