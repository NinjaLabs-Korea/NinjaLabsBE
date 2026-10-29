import { AuditService } from '../audit/audit.service';
import { BountyLifecycleService } from '../bounties/admin/bounty-lifecycle.service';
import { BountyAdminService } from '../bounties/admin/bounty-admin.service';
import { RewardTokenResolver } from '../bounties/admin/reward-token.resolver';
import { DatabaseService } from '../common/database/database.service';
import { HighlightAdminService } from '../highlights/highlight-admin.service';
import { NoticeAdminService } from '../notices/notice-admin.service';
import { describeDb } from './describe-db';
import { createDb, createUser, testConfig, unique } from './harness';

/** 수정(PATCH)은 완화 DTO 규칙을 쓰지만, 저장값과 다른 새 URL은 생성과 같은 엄격 규칙을 지켜야 한다 (공지·하이라이트·바운티 공통) */
describeDb('admin PATCH enforces the strict URL rule on changed values', () => {
  let db: DatabaseService;
  let notices: NoticeAdminService;
  let highlights: HighlightAdminService;
  let bounties: BountyAdminService;
  let adminId: string;

  beforeAll(async () => {
    db = createDb();
    const audit = new AuditService(db);
    notices = new NoticeAdminService(db, audit);
    highlights = new HighlightAdminService(db, audit);
    bounties = new BountyAdminService(db, audit, new BountyLifecycleService(), new RewardTokenResolver(testConfig()));
    adminId = await createUser(db, { isAdmin: true });
  });
  afterAll(async () => db.onApplicationShutdown());

  const bad = ['http://127.0.0.1/x', 'http://localhost:3000/x', 'http://10.0.0.5/x'];
  const legacy = 'cdn.example/legacy.png'; // 엄격 규칙 이전에 스킴 없이 저장된 값
  const column = async (table: string, col: string, id: string) =>
    (await db.query<Record<string, string | null>>(`SELECT ${col} FROM ${table} WHERE id = $1`, [id])).rows[0][col];

  it('highlight: changed private/localhost imageUrl and linkUrl are 400 and leave the row unchanged', async () => {
    const { id } = await highlights.create(adminId, { type: 'OTHER', title: unique('hl-'), description: 'd', imageUrl: 'https://cdn.example.com/a.png', linkUrl: 'https://example.com/a' });
    for (const url of bad) {
      await expect(highlights.update(id, { imageUrl: url }, adminId)).rejects.toMatchObject({ status: 400 });
      await expect(highlights.update(id, { linkUrl: url }, adminId)).rejects.toMatchObject({ status: 400 });
    }
    expect(await column('platform_highlight', 'image_url', id)).toBe('https://cdn.example.com/a.png');
    expect(await column('platform_highlight', 'link_url', id)).toBe('https://example.com/a');
    await expect(highlights.update(id, { title: unique('t-') }, adminId)).resolves.toMatchObject({ id });
    await expect(highlights.update(id, { linkUrl: '/bounties/some-slug' }, adminId)).resolves.toMatchObject({ id });
  });

  it('highlight: a stored legacy value sent back or an omitted field passes; a missing row stays 404', async () => {
    const { id } = await highlights.create(adminId, { type: 'OTHER', title: unique('hl-'), description: 'd' });
    await db.query(`UPDATE platform_highlight SET image_url = $2, link_url = $2 WHERE id = $1`, [id, legacy]);
    await expect(highlights.update(id, { imageUrl: legacy, linkUrl: legacy, title: unique('t-') }, adminId)).resolves.toMatchObject({ id });
    await expect(highlights.update(id, { description: 'd2' }, adminId)).resolves.toMatchObject({ id });
    await expect(highlights.update(id, { imageUrl: 'http://127.0.0.1/x' }, adminId)).rejects.toMatchObject({ status: 400 });
    await expect(highlights.update('00000000-0000-4000-8000-000000000000', { imageUrl: 'https://cdn.example.com/b.png' }, adminId)).rejects.toMatchObject({ status: 404 });
  });

  const bountyInput = () => ({
    title: unique('url-'), sponsorName: 'S', summary: 's', description: 'd', requirements: 'r', evaluationCriteria: 'e',
    category: 'DEV', applicationRequired: false, submissionMode: 'DIRECT', maxWinners: 1,
    submissionDeadline: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  });

  it('bounty: changed private/localhost coverImageUrl is 400 and unchanged; legacy value, null and omission pass', async () => {
    const { id } = await bounties.create(adminId, { ...bountyInput(), coverImageUrl: 'https://cdn.example.com/c.png' });
    for (const url of bad) await expect(bounties.update(id, { coverImageUrl: url }, adminId)).rejects.toMatchObject({ status: 400 });
    expect(await column('bounty', 'cover_image_url', id)).toBe('https://cdn.example.com/c.png');
    await db.query(`UPDATE bounty SET cover_image_url = $2 WHERE id = $1`, [id, legacy]);
    await expect(bounties.update(id, { coverImageUrl: legacy, title: unique('t-') }, adminId)).resolves.toMatchObject({ id });
    await expect(bounties.update(id, { summary: 's2' }, adminId)).resolves.toMatchObject({ id });
    await expect(bounties.update(id, { coverImageUrl: null }, adminId)).resolves.toMatchObject({ id });
    expect(await column('bounty', 'cover_image_url', id)).toBeNull();
  });

  it('notice: behaviour unchanged (changed private externalUrl/thumbnailUrl is 400, legacy value and omission pass)', async () => {
    const { id } = await notices.create(adminId, { category: 'EVENT', title: unique('n-'), body: 'b' });
    await db.query(`UPDATE notice SET external_url = $2, thumbnail_url = $2 WHERE id = $1`, [id, legacy]);
    for (const url of bad) {
      await expect(notices.update(id, { externalUrl: url }, adminId)).rejects.toMatchObject({ status: 400 });
      await expect(notices.update(id, { thumbnailUrl: url }, adminId)).rejects.toMatchObject({ status: 400 });
    }
    expect(await column('notice', 'external_url', id)).toBe(legacy);
    await expect(notices.update(id, { externalUrl: legacy, thumbnailUrl: legacy }, adminId)).resolves.toMatchObject({ id });
    await expect(notices.update(id, { title: unique('n2-') }, adminId)).resolves.toMatchObject({ id });
  });
});
