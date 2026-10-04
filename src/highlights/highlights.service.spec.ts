import { HighlightsService } from './highlights.service';

describe('HighlightsService stats', () => {
  const row = { completed_bounties: '2', builders: '3', completion_nfts: '4', sponsors: '1' };

  it('excludes soft-deleted bounties from every aggregate', async () => {
    const db = { query: jest.fn(async (_sql: string) => ({ rows: [row], rowCount: 1 })) };
    const service = new HighlightsService(db as never);

    await expect(service.stats()).resolves.toEqual({
      completedBounties: 2,
      builders: 3,
      completionNfts: 4,
      sponsors: 1,
    });

    const sql = db.query.mock.calls[0][0];
    const subqueries = sql.split(/\(SELECT/).slice(1);
    expect(subqueries).toHaveLength(4);
    for (const subquery of subqueries) expect(subquery).toMatch(/deleted_at IS NULL/);
  });
});
