import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../common/database/database.service';
import { HighlightAdminService } from '../highlights/highlight-admin.service';
import { describeDb } from './describe-db';
import { createDb, createUser, unique } from './harness';

describeDb('highlight publish on a real database', () => {
  let db: DatabaseService;
  let admin: HighlightAdminService;
  let adminId: string;

  beforeAll(async () => {
    db = createDb();
    admin = new HighlightAdminService(db, new AuditService(db));
    adminId = await createUser(db, { isAdmin: true });
  });
  afterAll(async () => db.onApplicationShutdown());

  const publishedAt = async (id: string) =>
    (await db.query<{ published_at: Date | null }>(`SELECT published_at FROM platform_highlight WHERE id = $1`, [id])).rows[0].published_at;

  it('keeps the first published_at across re-publishes, clears it on unpublish, stamps a fresh one on the next publish', async () => {
    const { id } = await admin.create(adminId, { type: 'OTHER', title: unique('hl-'), description: 'd' });
    expect(await publishedAt(id)).toBeNull();

    await admin.update(id, { publish: true }, adminId);
    const first = (await publishedAt(id))!;
    expect(first).toBeInstanceOf(Date);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await admin.update(id, { title: unique('hl-edit-'), publish: true }, adminId);
    expect((await publishedAt(id))!.getTime()).toBe(first.getTime());

    await admin.update(id, { publish: false }, adminId);
    expect(await publishedAt(id)).toBeNull();
    await admin.update(id, { publish: true }, adminId);
    expect((await publishedAt(id))!.getTime()).toBeGreaterThan(first.getTime());
  });
});
