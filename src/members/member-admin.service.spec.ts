import { AuditService } from '../audit/audit.service';
import { createMockDb } from '../test-support/mock-db';
import { MemberAdminService } from './member-admin.service';

describe('MemberAdminService', () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const adminId = '22222222-2222-4222-8222-222222222222';

  function setup(rowCount = 1, onboarded = true) {
    const result = { rowCount, rows: rowCount ? [{ id: userId, is_member: true }] : [] };
    // separate mocks: reads (searchUsers) go to the pool, the membership mutation + audit must stay on the transaction client
    const dbQuery = jest.fn().mockResolvedValue(result);
    const txQuery = jest.fn(async (sql: string, _params?: unknown[]) =>
      sql.includes('onboarding_completed_at IS NOT NULL AS done') ? (rowCount ? { rowCount: 1, rows: [{ done: onboarded }] } : { rowCount: 0, rows: [] }) : result);
    const { database, db } = createMockDb({ query: dbQuery, txQuery });
    const service = new MemberAdminService(database, new AuditService(createMockDb().database));
    return { service, dbQuery, txQuery, db };
  }

  it('escapes ILIKE metacharacters so a search term cannot act as a wildcard', () => {
    expect(MemberAdminService.likePattern('a_b%c\\d')).toBe('%a\\_b\\%c\\\\d%');
    expect(MemberAdminService.likePattern('')).toBe('%%');
  });

  it('pages 30 at a time, newest first, and keeps the empty-query "latest 30" behaviour on page 1', async () => {
    const { service, dbQuery, txQuery } = setup();
    await service.searchUsers('', 1);
    const [sql, params] = dbQuery.mock.calls[0];
    expect(sql).toContain("ILIKE $1 ESCAPE '\\'");
    expect(sql).toContain('ORDER BY u.created_at DESC');
    expect(sql).toContain('LIMIT $2 OFFSET $3');
    expect(params).toEqual(['%%', 30, 0]);

    await service.searchUsers('50%_off', 3);
    expect(dbQuery.mock.calls[1][1]).toEqual(['%50\\%\\_off%', 30, 60]);
    expect(txQuery).not.toHaveBeenCalled();
  });

  it('sets membership and audits inside one transaction, never on the pool', async () => {
    const { service, dbQuery, txQuery, db } = setup();
    await expect(service.setMember(userId, true, 'CORE', 2, adminId)).resolves.toEqual({ id: userId, is_member: true });
    expect(db.tx).toHaveBeenCalledTimes(1);
    expect(txQuery.mock.calls[0][0]).toContain('onboarding_completed_at IS NOT NULL AS done');
    expect(txQuery.mock.calls[1][0]).toContain('UPDATE "user"');
    expect(txQuery.mock.calls[1][1]).toEqual([userId, true, 'CORE', 2]);
    expect(txQuery.mock.calls[2][0]).toContain('INSERT INTO audit_log');
    expect(txQuery.mock.calls[2][1]).toEqual([adminId, 'USER_MEMBER_GRANTED', 'user', userId]);
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('does not write an audit row for an unknown user', async () => {
    const { service, dbQuery, txQuery } = setup(0);
    await expect(service.setMember(userId, false, undefined, undefined, adminId)).rejects.toMatchObject({ message: 'USER_NOT_FOUND' });
    expect(txQuery).toHaveBeenCalledTimes(1);
    expect(txQuery.mock.calls[0][1]).toEqual([userId, false, null, null]);
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('refuses to grant membership to a user who has not finished onboarding (409 PROFILE_REQUIRED, nothing written), but revoking never needs onboarding', async () => {
    const { service, txQuery } = setup(1, false);
    await expect(service.setMember(userId, true, 'DEV', undefined, adminId)).rejects.toMatchObject({ status: 409, message: 'PROFILE_REQUIRED' });
    expect(txQuery).toHaveBeenCalledTimes(1);
    await expect(service.setMember(userId, false, undefined, undefined, adminId)).resolves.toBeDefined();
  });

  it('granting to an unknown user is 404 USER_NOT_FOUND', async () => {
    const { service } = setup(0);
    await expect(service.setMember(userId, true, 'DEV', undefined, adminId)).rejects.toMatchObject({ status: 404, message: 'USER_NOT_FOUND' });
  });
});
