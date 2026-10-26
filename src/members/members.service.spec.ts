import { HighlightsController } from '../highlights/highlights.controller';
import { HighlightsService } from '../highlights/highlights.service';
import { createMockDb } from '../test-support/mock-db';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';

/** Public list reads — the real-database behaviour (filters, ordering, link aggregation) is in src/test-db/public-lists.db-spec.ts */
function fakeDb(rows: unknown[]) {
  const query = jest.fn(async (_sql: string, _params?: unknown[]) => ({ rowCount: rows.length, rows }));
  return { query, db: createMockDb({ query }).database };
}

describe('MembersService.list (GET /members)', () => {
  it('returns the rows as-is through the controller', async () => {
    const rows = [{ id: 'u1', nickname: 'a', links: [] }];
    const { db } = fakeDb(rows);
    await expect(new MembersController(new MembersService(db)).list()).resolves.toBe(rows);
  });

  it('only lists active, non-deleted official members and never exposes private user columns', async () => {
    const { query, db } = fakeDb([]);
    await new MembersService(db).list();
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('u.is_member = true');
    expect(sql).toContain('u.deleted_at IS NULL');
    expect(sql).toContain(`u.status = 'ACTIVE'`);
    // unfinished onboarding => the public profile is 404, so the card would link to a dead page
    expect(sql).toContain('u.onboarding_completed_at IS NOT NULL');
    expect(params).toBeUndefined();
    for (const column of ['email', 'google_id', 'is_admin', 'status']) {
      expect(/SELECT([\s\S]*?)FROM/.exec(sql)![1]).not.toContain(column);
    }
  });
});

describe('HighlightsService.list (GET /hall-of-fame)', () => {
  it('returns published highlights through the controller', async () => {
    const rows = [{ id: 'h1' }];
    const { query, db } = fakeDb(rows);
    await expect(new HighlightsController(new HighlightsService(db)).list()).resolves.toBe(rows);
    expect(query.mock.calls[0][0]).toContain('WHERE is_published = true');
  });

  it('GET /hall-of-fame/stats goes through the cached stats()', async () => {
    // two reads: the counts row and the per-token PAID totals (FROM payout)
    const query = jest.fn(async (sql: string, _params?: unknown[]) => (sql.includes('sum(p.amount)')
      ? { rowCount: 1, rows: [{ symbol: 'INJ', token_type: 'NATIVE', amount: '5' }] }
      : { rowCount: 1, rows: [{ completed_bounties: '3', builders: '2', completion_nfts: '1', sponsors: '4' }] }));
    const db = createMockDb({ query }).database;
    await expect(new HighlightsController(new HighlightsService(db)).stats()).resolves.toEqual({
      completedBounties: 3, builders: 2, completionNfts: 1, sponsors: 4,
      paidTotals: [{ symbol: 'INJ', tokenType: 'NATIVE', decimals: 18, amount: '5' }],
    });
  });
});
