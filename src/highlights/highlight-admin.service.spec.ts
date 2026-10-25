import { AuditService } from '../audit/audit.service';
import { createMockDb } from '../test-support/mock-db';
import { HighlightAdminService } from './highlight-admin.service';

describe('HighlightAdminService audit transactions', () => {
  const highlightId = '11111111-1111-4111-8111-111111111111';
  const adminId = '22222222-2222-4222-8222-222222222222';

  function setup(rowCount = 1) {
    // tx.query and db.query are separate: mutation + audit must both run on the transaction client. The dynamic UPDATE builder is checked for $n drift.
    const query = jest.fn().mockResolvedValue({ rowCount, rows: rowCount ? [{ id: highlightId, is_published: true }] : [] });
    const { database, db } = createMockDb({ txQuery: query });
    const service = new HighlightAdminService(database, new AuditService(database));
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

  it('update binds the provided columns in order and keeps the first published_at on publish, clears it on unpublish', async () => {
    const { service, query } = setup();
    await service.update(highlightId, { title: 'T', displayOrder: 3, publish: true }, adminId);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('UPDATE platform_highlight SET title = $2, display_order = $3, is_published = $4, published_at = COALESCE(published_at, now()) WHERE id = $1 RETURNING id, is_published');
    // the first publish time is kept on re-publish (same rule as notices) — no client-side Date is bound
    expect(params).toEqual([highlightId, 'T', 3, true]);

    await service.update(highlightId, { publish: false }, adminId);
    expect(query.mock.calls[2][1]).toEqual([highlightId, false, null]);
  });

  it('rolls back without an audit row when the highlight is missing', async () => {
    const { service, query } = setup(0);
    await expect(service.remove(highlightId, adminId)).rejects.toMatchObject({ message: 'HIGHLIGHT_NOT_FOUND' });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('an empty PATCH answers 404 for a missing highlight instead of 200 { id }', async () => {
    const query = jest.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    const { database } = createMockDb({ query });
    const service = new HighlightAdminService(database, new AuditService(database));
    await expect(service.update(highlightId, {}, adminId)).rejects.toMatchObject({ message: 'HIGHLIGHT_NOT_FOUND' });
    query.mockResolvedValueOnce({ rowCount: 1, rows: [{}] });
    await expect(service.update(highlightId, {}, adminId)).resolves.toEqual({ id: highlightId });
  });

  it('create with a bountyId that does not exist → 400 BOUNTY_NOT_FOUND (FK fk_highlight_bounty), other errors pass through', async () => {
    const { service, db } = setup();
    const fk = Object.assign(new Error('fk'), { code: '23503', constraint: 'fk_highlight_bounty' });
    db.tx.mockRejectedValueOnce(fk);
    await expect(service.create(adminId, { type: 'MILESTONE', title: 't', description: 'd', bountyId: highlightId }))
      .rejects.toMatchObject({ status: 400, message: 'BOUNTY_NOT_FOUND' });
    const other = new Error('boom');
    db.tx.mockRejectedValueOnce(other);
    await expect(service.create(adminId, { type: 'MILESTONE', title: 't', description: 'd' })).rejects.toBe(other);
  });
});
