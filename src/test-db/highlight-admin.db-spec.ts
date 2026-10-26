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

  it('refuses a /media image that has no media_asset row (create and update) and accepts one that exists; external URLs are not checked', async () => {
    const missing = '/media/00000000-0000-4000-8000-000000000000';
    await expect(admin.create(adminId, { type: 'PARTNERSHIP', title: unique('hl-'), description: 'd', imageUrl: missing })).rejects.toMatchObject({ status: 400, message: 'REFERENCE_NOT_FOUND' });
    const { id } = await admin.create(adminId, { type: 'OTHER', title: unique('hl-'), description: 'd', imageUrl: 'https://cdn.example.com/a.png' });
    await expect(admin.update(id, { imageUrl: missing }, adminId)).rejects.toMatchObject({ status: 400, message: 'REFERENCE_NOT_FOUND' });
    const asset = await db.query<{ id: string }>(
      `INSERT INTO media_asset (created_by, file_name, mime_type, file_size, sha256, data) VALUES ($1, 'a.png', 'image/png', 1, repeat('0', 64), '\\x00') RETURNING id`, [adminId]);
    await expect(admin.update(id, { imageUrl: `/media/${asset.rows[0].id}` }, adminId)).resolves.toMatchObject({ id });
  });
});
