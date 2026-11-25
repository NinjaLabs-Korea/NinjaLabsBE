import { AuditService } from '../audit/audit.service';
import { createMockDb } from '../test-support/mock-db';
import { AdminAccessService } from './admin-access.service';

describe('AdminAccessService', () => {
  const targetId = '11111111-1111-4111-8111-111111111111';
  const actorId = '22222222-2222-4222-8222-222222222222';

  type Target = { is_admin: boolean; status: string; onboarded: boolean };
  function setup(target: Target | null, otherAdmins = 1) {
    const txQuery = jest.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes('WHERE is_admin = true ORDER BY id FOR UPDATE')) return { rowCount: 0, rows: [] };
      if (sql.includes('FOR UPDATE') && sql.includes('onboarded')) {
        return target
          ? { rowCount: 1, rows: [{ id: targetId, email: 'a@x.test', nickname: 'nin', ...target }] }
          : { rowCount: 0, rows: [] };
      }
      if (sql.includes('count(*)')) return { rowCount: 1, rows: [{ n: otherAdmins }] };
      return { rowCount: 1, rows: [] };
    });
    const { database, db } = createMockDb({ txQuery });
    return { service: new AdminAccessService(database, new AuditService(createMockDb().database)), txQuery, db };
  }
  const plain: Target = { is_admin: false, status: 'ACTIVE', onboarded: true };
  const writes = (txQuery: jest.Mock) => txQuery.mock.calls.filter(([sql]) => /UPDATE "user"|INSERT INTO audit_log/.test(sql as string));

  it('rejects changing yourself in both directions before touching the database', async () => {
    const { service, db } = setup(plain);
    await expect(service.setAdmin(actorId, true, actorId)).rejects.toMatchObject({ message: 'ADMIN_SELF_CHANGE', status: 403 });
    await expect(service.setAdmin(actorId, false, actorId)).rejects.toMatchObject({ message: 'ADMIN_SELF_CHANGE', status: 403 });
    expect(db.tx).not.toHaveBeenCalled();
  });

  it('404 USER_NOT_FOUND for a missing or deleted user, nothing written', async () => {
    const { service, txQuery } = setup(null);
    await expect(service.setAdmin(targetId, true, actorId)).rejects.toMatchObject({ message: 'USER_NOT_FOUND', status: 404 });
    expect(writes(txQuery)).toEqual([]);
  });

  it('locks every admin row first, then the live target row', async () => {
    const { service, txQuery } = setup(plain);
    await service.setAdmin(targetId, true, actorId);
    expect(txQuery.mock.calls[0][0]).toContain('WHERE is_admin = true ORDER BY id FOR UPDATE');
    expect(txQuery.mock.calls[1][0]).toContain('deleted_at IS NULL FOR UPDATE');
    expect(txQuery.mock.calls[1][1]).toEqual([targetId]);
  });

  it('409 USER_NOT_ACTIVE when granting to a non-ACTIVE user', async () => {
    const { service, txQuery } = setup({ ...plain, status: 'SUSPENDED' });
    await expect(service.setAdmin(targetId, true, actorId)).rejects.toMatchObject({ message: 'USER_NOT_ACTIVE', status: 409 });
    expect(writes(txQuery)).toEqual([]);
  });

  it('409 PROFILE_REQUIRED when granting before onboarding is complete', async () => {
    const { service, txQuery } = setup({ ...plain, onboarded: false });
    await expect(service.setAdmin(targetId, true, actorId)).rejects.toMatchObject({ message: 'PROFILE_REQUIRED', status: 409 });
    expect(writes(txQuery)).toEqual([]);
  });

  it('409 LAST_ADMIN when no other active admin would remain, nothing written', async () => {
    const { service, txQuery } = setup({ ...plain, is_admin: true }, 0);
    await expect(service.setAdmin(targetId, false, actorId)).rejects.toMatchObject({ message: 'LAST_ADMIN', status: 409 });
    expect(writes(txQuery)).toEqual([]);
  });

  it('returns the current row without UPDATE or audit when already in the desired state', async () => {
    const granted = setup({ ...plain, is_admin: true });
    await expect(granted.service.setAdmin(targetId, true, actorId)).resolves.toEqual({ id: targetId, email: 'a@x.test', nickname: 'nin', is_admin: true });
    expect(writes(granted.txQuery)).toEqual([]);
    const revoked = setup(plain);
    await expect(revoked.service.setAdmin(targetId, false, actorId)).resolves.toMatchObject({ is_admin: false });
    expect(writes(revoked.txQuery)).toEqual([]);
  });

  it('grants: UPDATE plus an ADMIN_GRANTED audit row (actor = acting admin, before/after) in the same transaction', async () => {
    const { service, txQuery, db } = setup(plain);
    await expect(service.setAdmin(targetId, true, actorId)).resolves.toEqual({ id: targetId, email: 'a@x.test', nickname: 'nin', is_admin: true });
    expect(db.tx).toHaveBeenCalledTimes(1);
    const [update, audit] = writes(txQuery);
    expect(update[0]).toContain('is_admin = $2::boolean');
    expect(update[1]).toEqual([targetId, true]);
    expect(audit[1]).toEqual([actorId, 'ADMIN_GRANTED', 'user', targetId, JSON.stringify({ is_admin: false }), JSON.stringify({ is_admin: true })]);
  });

  it('revokes (suspended admins too) with an ADMIN_REVOKED audit row when another active admin remains', async () => {
    const { service, txQuery } = setup({ ...plain, is_admin: true, status: 'SUSPENDED' }, 1);
    await expect(service.setAdmin(targetId, false, actorId)).resolves.toMatchObject({ is_admin: false });
    const count = txQuery.mock.calls.find(([sql]) => (sql as string).includes('count(*)'))!;
    expect(count[0]).toContain("status = 'ACTIVE' AND deleted_at IS NULL");
    expect(count[1]).toEqual([targetId]);
    const [update, audit] = writes(txQuery);
    expect(update[1]).toEqual([targetId, false]);
    expect(audit[1]).toEqual([actorId, 'ADMIN_REVOKED', 'user', targetId, JSON.stringify({ is_admin: true }), JSON.stringify({ is_admin: false })]);
  });
});
