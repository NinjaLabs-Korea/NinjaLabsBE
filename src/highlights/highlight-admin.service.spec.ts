import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../common/database/database.service';
import { HighlightAdminService } from './highlight-admin.service';

describe('HighlightAdminService audit transactions', () => {
  const highlightId = '11111111-1111-4111-8111-111111111111';
  const adminId = '22222222-2222-4222-8222-222222222222';

  function setup(rowCount = 1) {
    const query = jest.fn().mockResolvedValue({ rowCount, rows: rowCount ? [{ id: highlightId, is_published: true }] : [] });
    const db = { query: jest.fn(), tx: jest.fn(async (callback: (tx: { query: jest.Mock }) => Promise<unknown>) => callback({ query })) };
    const service = new HighlightAdminService(db as unknown as DatabaseService, new AuditService(db as unknown as DatabaseService));
    return { service, query, db };
  }

  it.each([
    ['create', (s: HighlightAdminService) => s.create(adminId, { type: 'MILESTONE', title: 't', description: 'd' }), 'HIGHLIGHT_CREATED'],
    ['update', (s: HighlightAdminService) => s.update(highlightId, { title: 't' }, adminId), 'HIGHLIGHT_UPDATED'],
    ['remove', (s: HighlightAdminService) => s.remove(highlightId, adminId), 'HIGHLIGHT_DELETED'],
  ])('%s mutates and audits on the same transaction client', async (_label, run, action) => {
    const { service, query, db } = setup();
    await run(service);
    expect(db.tx).toHaveBeenCalledTimes(1);
    expect(db.query).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][0]).toContain('INSERT INTO audit_log');
    expect(query.mock.calls[1][1]).toEqual([adminId, action, 'platform_highlight', highlightId]);
  });

  it('rolls back without an audit row when the highlight is missing', async () => {
    const { service, query } = setup(0);
    await expect(service.remove(highlightId, adminId)).rejects.toMatchObject({ message: 'HIGHLIGHT_NOT_FOUND' });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
