import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../common/database/database.service';
import { MemberAdminService } from './member-admin.service';

describe('MemberAdminService', () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const adminId = '22222222-2222-4222-8222-222222222222';

  function setup(rowCount = 1) {
    const query = jest.fn().mockResolvedValue({ rowCount, rows: rowCount ? [{ id: userId, is_member: true }] : [] });
    const db = { query, tx: jest.fn(async (callback: (tx: { query: jest.Mock }) => Promise<unknown>) => callback({ query })) };
    const service = new MemberAdminService(db as unknown as DatabaseService, new AuditService({ query: jest.fn() } as unknown as DatabaseService));
    return { service, query, db };
  }

  it('escapes ILIKE metacharacters so a search term cannot act as a wildcard', () => {
    expect(MemberAdminService.likePattern('a_b%c\\d')).toBe('%a\\_b\\%c\\\\d%');
    expect(MemberAdminService.likePattern('')).toBe('%%');
  });

  it('pages 30 at a time, newest first, and keeps the empty-query "latest 30" behaviour on page 1', async () => {
    const { service, query } = setup();
    await service.searchUsers('', 1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("ILIKE $1 ESCAPE '\\'");
    expect(sql).toContain('ORDER BY u.created_at DESC');
    expect(sql).toContain('LIMIT $2 OFFSET $3');
    expect(params).toEqual(['%%', 30, 0]);

    await service.searchUsers('50%_off', 3);
    expect(query.mock.calls[1][1]).toEqual(['%50\\%\\_off%', 30, 60]);
  });

  it('sets membership and audits inside one transaction', async () => {
    const { service, query, db } = setup();
    await expect(service.setMember(userId, true, 'CORE', 2, adminId)).resolves.toEqual({ id: userId, is_member: true });
    expect(db.tx).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual([userId, true, 'CORE', 2]);
    expect(query.mock.calls[1][0]).toContain('INSERT INTO audit_log');
    expect(query.mock.calls[1][1]).toEqual([adminId, 'USER_MEMBER_GRANTED', 'user', userId]);
  });

  it('does not write an audit row for an unknown user', async () => {
    const { service, query } = setup(0);
    await expect(service.setMember(userId, false, undefined, undefined, adminId)).rejects.toMatchObject({ message: 'USER_NOT_FOUND' });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
