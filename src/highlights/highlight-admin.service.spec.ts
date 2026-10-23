import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../common/database/database.service';
import { withParamsCheck } from '../test-support/expect-params-match';
import { HighlightAdminService } from './highlight-admin.service';

describe('HighlightAdminService audit transactions', () => {
  const highlightId = '11111111-1111-4111-8111-111111111111';
  const adminId = '22222222-2222-4222-8222-222222222222';

  function setup(rowCount = 1) {
    // tx.query and db.query are separate: mutation + audit must both run on the transaction client. The dynamic UPDATE builder is checked for $n drift.
    const query = jest.fn().mockResolvedValue({ rowCount, rows: rowCount ? [{ id: highlightId, is_published: true }] : [] });
    const db = { query: jest.fn(), tx: jest.fn(async (callback: (tx: { query: jest.Mock }) => Promise<unknown>) => callback({ query: withParamsCheck(query) })) };
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

  it('update binds the provided columns in order and stamps published_at from the publish flag', async () => {
    const { service, query } = setup();
    await service.update(highlightId, { title: 'T', displayOrder: 3, publish: true }, adminId);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('UPDATE platform_highlight SET title = $2, display_order = $3, is_published = $4, published_at = $5 WHERE id = $1 RETURNING id, is_published');
    expect(params.slice(0, 4)).toEqual([highlightId, 'T', 3, true]);
    expect(params[4]).toBeInstanceOf(Date);

    await service.update(highlightId, { publish: false }, adminId);
    expect(query.mock.calls[2][1]).toEqual([highlightId, false, null]);
  });

  it('rolls back without an audit row when the highlight is missing', async () => {
    const { service, query } = setup(0);
    await expect(service.remove(highlightId, adminId)).rejects.toMatchObject({ message: 'HIGHLIGHT_NOT_FOUND' });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
