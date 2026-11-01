import { JwtService } from '@nestjs/jwt';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { DatabaseService } from '../common/database/database.service';
import { MediaService } from '../media/media.service';
import { MembersService } from '../members/members.service';
import { AccountWithdrawalService } from '../users/account-withdrawal.service';
import { UserAvatarService } from '../users/user-avatar.service';
import { UsersService } from '../users/users.service';
import { describeDb } from './describe-db';
import { createDb, createUser, TEST_JWT_SECRET, testConfig, unique } from './harness';

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const png = () => ({ buffer: PNG, mimetype: 'image/png', originalname: 'me.png', size: PNG.length });

describeDb('profile avatar on a real database (0022)', () => {
  let db: DatabaseService;
  let auth: AuthService;
  let avatar: UserAvatarService;
  let users: UsersService;
  let members: MembersService;
  let withdrawal: AccountWithdrawalService;

  beforeAll(async () => {
    db = createDb();
    const audit = new AuditService(db);
    auth = new AuthService(db, new JwtService({ secret: TEST_JWT_SECRET, signOptions: { expiresIn: '15m' } }), testConfig(), TEST_JWT_SECRET);
    avatar = new UserAvatarService(db, audit);
    users = new UsersService(db, audit);
    members = new MembersService(db);
    withdrawal = new AccountWithdrawalService(db, audit, auth);
  });
  afterAll(async () => db.onApplicationShutdown());

  const assetExists = async (id: string) => (await db.query(`SELECT 1 FROM media_asset WHERE id = $1::uuid`, [id])).rowCount === 1;
  const mediaIdOf = (url: string | null) => (url ?? '').replace('/media/', '');
  const audits = async (userId: string) =>
    (await db.query<{ action: string; before_data: unknown; after_data: unknown }>(
      `SELECT action, before_data, after_data FROM audit_log WHERE entity_id = $1::uuid AND action LIKE 'USER_AVATAR_%' ORDER BY created_at, id`,
      [userId],
    )).rows;

  it('upload -> replace -> remove: the column follows, every previous asset row is deleted, and each change is audited', async () => {
    const userId = await createUser(db);
    const first = await avatar.replace(userId, png());
    expect(first.avatarUrl).toMatch(/^\/media\/[0-9a-f-]{36}$/);
    expect(await assetExists(mediaIdOf(first.avatarUrl))).toBe(true);
    expect((await auth.getMe(userId)).avatarUrl).toBe(first.avatarUrl);

    const second = await avatar.replace(userId, png());
    expect(second.avatarUrl).not.toBe(first.avatarUrl);
    expect(await assetExists(mediaIdOf(first.avatarUrl))).toBe(false);
    expect(await assetExists(mediaIdOf(second.avatarUrl))).toBe(true);

    await expect(avatar.remove(userId)).resolves.toEqual({ avatarUrl: null });
    expect(await assetExists(mediaIdOf(second.avatarUrl))).toBe(false);
    expect((await auth.getMe(userId)).avatarUrl).toBeNull();
    await expect(avatar.remove(userId)).resolves.toEqual({ avatarUrl: null }); // idempotent

    expect((await audits(userId)).map((a) => a.action)).toEqual(['USER_AVATAR_UPDATED', 'USER_AVATAR_UPDATED', 'USER_AVATAR_REMOVED']);
    expect((await audits(userId))[1]).toMatchObject({
      before_data: { avatarMediaId: mediaIdOf(first.avatarUrl) },
      after_data: { avatarMediaId: mediaIdOf(second.avatarUrl) },
    });
  });

  it('a rejected file rolls back: no new asset row, the old photo stays', async () => {
    const userId = await createUser(db);
    const kept = await avatar.replace(userId, png());
    const before = (await db.query(`SELECT count(*)::int AS n FROM media_asset WHERE created_by = $1::uuid`, [userId])).rows[0].n;
    await expect(avatar.replace(userId, { ...png(), mimetype: 'image/webp' })).rejects.toMatchObject({ message: 'MEDIA_FILE_TYPE_UNSUPPORTED' });
    expect((await db.query(`SELECT count(*)::int AS n FROM media_asset WHERE created_by = $1::uuid`, [userId])).rows[0].n).toBe(before);
    expect((await auth.getMe(userId)).avatarUrl).toBe(kept.avatarUrl);
  });

  it('never deletes an asset the user did not upload (an admin image pointed at by hand-written SQL stays)', async () => {
    const adminId = await createUser(db, { isAdmin: true });
    const userId = await createUser(db);
    const adminAsset = await new MediaService(db).create(adminId, png());
    await db.query(`UPDATE "user" SET avatar_media_id = $2::uuid WHERE id = $1::uuid`, [userId, adminAsset.id]);
    await avatar.remove(userId);
    expect(await assetExists(adminAsset.id)).toBe(true);
    expect((await auth.getMe(userId)).avatarUrl).toBeNull();
  });

  it('public profile and the members list carry avatar_url (null without a photo)', async () => {
    const nickname = unique('ava').slice(0, 20);
    const userId = await createUser(db, { nickname });
    await db.query(`UPDATE "user" SET is_member = true, member_role = 'DEV' WHERE id = $1::uuid`, [userId]);
    expect(((await users.publicProfile(nickname)) as { avatar_url?: string | null }).avatar_url).toBeNull();
    const { avatarUrl } = await avatar.replace(userId, png());
    expect(((await users.publicProfile(nickname)) as { avatar_url?: string | null }).avatar_url).toBe(avatarUrl);
    const listed = (await members.list()).find((m) => m.id === userId);
    expect(listed?.avatar_url).toBe(avatarUrl);
  });

  it('withdrawal clears the photo and deletes the asset in the same transaction', async () => {
    const nickname = unique('wd').slice(0, 20);
    const userId = await createUser(db, { nickname });
    const { avatarUrl } = await avatar.replace(userId, png());
    await withdrawal.withdraw(userId, nickname);
    const row = await db.query<{ avatar_media_id: string | null }>(`SELECT avatar_media_id FROM "user" WHERE id = $1::uuid`, [userId]);
    expect(row.rows[0].avatar_media_id).toBeNull();
    expect(await assetExists(mediaIdOf(avatarUrl))).toBe(false);
    await expect(avatar.replace(userId, png())).rejects.toMatchObject({ message: 'USER_NOT_FOUND' });
  });

  it('deleting a media_asset row by hand turns the photo off instead of breaking the user row (ON DELETE SET NULL)', async () => {
    const userId = await createUser(db);
    const { avatarUrl } = await avatar.replace(userId, png());
    await db.query(`DELETE FROM media_asset WHERE id = $1::uuid`, [mediaIdOf(avatarUrl)]);
    expect((await auth.getMe(userId)).avatarUrl).toBeNull();
  });

  it('two concurrent uploads serialize on the user row: exactly one asset remains and the column points at it', async () => {
    const userId = await createUser(db);
    const [a, b] = await Promise.all([avatar.replace(userId, png()), avatar.replace(userId, png())]);
    const rows = await db.query<{ id: string }>(`SELECT id FROM media_asset WHERE created_by = $1::uuid`, [userId]);
    expect(rows.rows).toHaveLength(1);
    const current = (await auth.getMe(userId)).avatarUrl;
    expect([a.avatarUrl, b.avatarUrl]).toContain(current);
    expect(rows.rows[0].id).toBe(mediaIdOf(current));
  });
});
