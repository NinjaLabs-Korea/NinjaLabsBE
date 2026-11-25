import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../common/database/database.service';
import { runWithRequestContext } from '../common/http/request-context';
import { AdminAccessService } from '../members/admin-access.service';
import { describeDb } from './describe-db';
import { createDb, createUser } from './harness';

/** 운영자 권한 부여/회수 API의 실제 SQL: 잠금 경로, 마지막 운영자 규칙, 감사 행 (scripts/grant-admin.js와 같은 규칙) */
describeDb('admin access grant/revoke on a real database', () => {
  let db: DatabaseService;
  let service: AdminAccessService;

  beforeAll(() => {
    db = createDb();
    service = new AdminAccessService(db, new AuditService(db));
  });
  afterAll(async () => db.onApplicationShutdown());
  // 마지막 운영자 규칙은 DB 전체의 운영자를 센다 - 각 테스트가 빈 상태에서 시작한다 (스위트는 --runInBand)
  beforeEach(async () => {
    await db.query(`UPDATE "user" SET is_admin = false WHERE is_admin = true`);
  });

  const state = async (id: string) =>
    (await db.query<{ is_admin: boolean }>(`SELECT is_admin FROM "user" WHERE id = $1`, [id])).rows[0].is_admin;
  const audit = async (id: string) =>
    (await db.query(`SELECT actor_user_id, action, entity_type, before_data, after_data FROM audit_log WHERE entity_id = $1 ORDER BY created_at`, [id])).rows;

  it('grants, writes ADMIN_GRANTED with the acting admin as actor and before/after, inside a request context, and the flag flips', async () => {
    const actor = await createUser(db, { isAdmin: true });
    const target = await createUser(db);
    const res = await runWithRequestContext('203.0.113.9', () => service.setAdmin(target, true, actor));
    expect(res).toMatchObject({ id: target, is_admin: true });
    expect(await state(target)).toBe(true);
    expect(await audit(target)).toEqual([{ actor_user_id: actor, action: 'ADMIN_GRANTED', entity_type: 'user', before_data: { is_admin: false }, after_data: { is_admin: true } }]);
  });

  it('revokes with ADMIN_REVOKED while another active admin remains', async () => {
    const actor = await createUser(db, { isAdmin: true });
    const target = await createUser(db, { isAdmin: true });
    await expect(service.setAdmin(target, false, actor)).resolves.toMatchObject({ id: target, is_admin: false });
    expect(await state(target)).toBe(false);
    expect(await audit(target)).toEqual([{ actor_user_id: actor, action: 'ADMIN_REVOKED', entity_type: 'user', before_data: { is_admin: true }, after_data: { is_admin: false } }]);
  });

  it('is a no-op with no audit row when already in the desired state', async () => {
    const actor = await createUser(db, { isAdmin: true });
    const admin = await createUser(db, { isAdmin: true });
    const plain = await createUser(db);
    await expect(service.setAdmin(admin, true, actor)).resolves.toMatchObject({ is_admin: true });
    await expect(service.setAdmin(plain, false, actor)).resolves.toMatchObject({ is_admin: false });
    expect(await audit(admin)).toEqual([]);
    expect(await audit(plain)).toEqual([]);
  });

  it('refuses grants to suspended, not-onboarded and deleted users, and writes nothing', async () => {
    const actor = await createUser(db, { isAdmin: true });
    const suspended = await createUser(db);
    await db.query(`UPDATE "user" SET status = 'SUSPENDED' WHERE id = $1`, [suspended]);
    const fresh = await createUser(db, { onboarded: false });
    const gone = await createUser(db);
    await db.query(`UPDATE "user" SET deleted_at = now() WHERE id = $1`, [gone]);
    await expect(service.setAdmin(suspended, true, actor)).rejects.toMatchObject({ message: 'USER_NOT_ACTIVE' });
    await expect(service.setAdmin(fresh, true, actor)).rejects.toMatchObject({ message: 'PROFILE_REQUIRED' });
    await expect(service.setAdmin(gone, true, actor)).rejects.toMatchObject({ message: 'USER_NOT_FOUND' });
    for (const id of [suspended, fresh, gone]) {
      expect(await state(id)).toBe(false);
      expect(await audit(id)).toEqual([]);
    }
  });

  it('suspended, deleted or non-admin actors cannot revoke the only active admin, nothing written', async () => {
    const actor = await createUser(db, { isAdmin: true });
    const suspended = await createUser(db, { isAdmin: true });
    await db.query(`UPDATE "user" SET status = 'SUSPENDED' WHERE id = $1`, [suspended]);
    const gone = await createUser(db, { isAdmin: true });
    await db.query(`UPDATE "user" SET deleted_at = now() WHERE id = $1`, [gone]);
    // `actor` is the only ACTIVE admin. A suspended admin cannot act: the recheck under the lock refuses it (ADMIN_ONLY),
    // so LAST_ADMIN stays a defensive guard that an ACTIVE acting admin (who is never the target) cannot reach
    await expect(service.setAdmin(actor, false, suspended)).rejects.toMatchObject({ message: 'ADMIN_ONLY' });
    const other = await createUser(db);
    await expect(service.setAdmin(actor, false, other)).rejects.toMatchObject({ message: 'ADMIN_ONLY' });
    expect(await state(actor)).toBe(true);
    expect(await audit(actor)).toEqual([]);
  });

  it('two admins revoking each other at once: exactly one wins, one active admin remains (admin rows are locked first)', async () => {
    const a = await createUser(db, { isAdmin: true });
    const b = await createUser(db, { isAdmin: true });
    const results = await Promise.allSettled([service.setAdmin(b, false, a), service.setAdmin(a, false, b)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    // the loser waited on the admin-row lock and then finds it is no longer an admin itself
    expect(rejected.reason).toMatchObject({ message: 'ADMIN_ONLY' });
    const remaining = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "user" WHERE is_admin = true AND status = 'ACTIVE' AND deleted_at IS NULL`);
    expect(remaining.rows[0].n).toBe(1);
    expect(await audit(a)).toHaveLength(Number(!(await state(a))));
    expect(await audit(b)).toHaveLength(Number(!(await state(b))));
  });
});
