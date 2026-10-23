import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../common/database/database.service';
import { NoticeAdminService } from '../notices/notice-admin.service';
import { NoticesService } from '../notices/notices.service';
import { describeDb } from './describe-db';
import { auditActions, createDb, createUser, unique } from './harness';

describeDb('notices publish/update on a real database', () => {
  let db: DatabaseService;
  let admin: NoticeAdminService;
  let notices: NoticesService;
  let adminId: string;

  beforeAll(async () => {
    db = createDb();
    admin = new NoticeAdminService(db, new AuditService(db));
    notices = new NoticesService(db);
    adminId = await createUser(db, { isAdmin: true });
  });
  afterAll(async () => db.onModuleDestroy());

  async function row(id: string) {
    const r = await db.query<{ status: string; published_at: Date | null; title: string; deleted_at: Date | null }>(
      `SELECT status, published_at, title, deleted_at FROM notice WHERE id = $1`, [id],
    );
    return r.rows[0];
  }

  it('publish keeps the original published_at across re-publishes (COALESCE) and clears it on unpublish', async () => {
    const title = unique('notice-');
    const { id } = await admin.create(adminId, { title, body: 'body', category: 'EVENT' });
    expect(await row(id)).toMatchObject({ status: 'DRAFT', published_at: null });
    await expect(notices.detail(id)).rejects.toMatchObject({ message: 'NOTICE_NOT_FOUND' });

    await admin.update(id, { publish: true }, adminId);
    const first = await row(id);
    expect(first.status).toBe('PUBLISHED');
    expect(first.published_at).toBeInstanceOf(Date);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await admin.update(id, { title: `${title}-edited`, publish: true }, adminId);
    const second = await row(id);
    expect(second.title).toBe(`${title}-edited`);
    expect(second.published_at!.getTime()).toBe(first.published_at!.getTime());
    await expect(notices.detail(id)).resolves.toMatchObject({ id, title: `${title}-edited` });

    await admin.update(id, { publish: false }, adminId);
    expect(await row(id)).toMatchObject({ status: 'DRAFT', published_at: null });

    // re-publishing after an unpublish stamps a fresh time
    await admin.update(id, { publish: true }, adminId);
    expect((await row(id)).published_at!.getTime()).toBeGreaterThan(first.published_at!.getTime());

    // a field-only update leaves status/published_at alone
    const before = await row(id);
    await admin.update(id, { summary: 's' }, adminId);
    expect(await row(id)).toMatchObject({ status: before.status, published_at: before.published_at });

    expect(await auditActions(db, 'notice', id)).toEqual(['NOTICE_CREATED', 'NOTICE_UPDATED', 'NOTICE_UPDATED', 'NOTICE_UPDATED', 'NOTICE_UPDATED', 'NOTICE_UPDATED']);
  });

  it('create with publish lists the notice publicly, filtered by category; remove hides it and 404s', async () => {
    const title = unique('published-');
    const { id } = await admin.create(adminId, { title, body: 'b', category: 'RECRUITMENT', publish: true });
    expect(await auditActions(db, 'notice', id)).toEqual(['NOTICE_PUBLISHED']);

    const listed = await notices.list(1, 50, 'RECRUITMENT');
    expect(listed.items.map((item: { id: string }) => item.id)).toContain(id);
    const other = await notices.list(1, 50, 'EVENT');
    expect(other.items.map((item: { id: string }) => item.id)).not.toContain(id);

    await admin.remove(id, adminId);
    expect((await row(id)).deleted_at).toBeInstanceOf(Date);
    await expect(notices.detail(id)).rejects.toMatchObject({ message: 'NOTICE_NOT_FOUND' });
    await expect(admin.remove(id, adminId)).rejects.toMatchObject({ message: 'NOTICE_NOT_FOUND' });
    await expect(admin.update(id, { title: 'x' }, adminId)).rejects.toMatchObject({ message: 'NOTICE_NOT_FOUND' });
  });
});
