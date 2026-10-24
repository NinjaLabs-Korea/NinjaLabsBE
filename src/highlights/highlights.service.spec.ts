import { createMockDb } from '../test-support/mock-db';
import { HighlightsService, STATS_CACHE_TTL_MS } from './highlights.service';

describe('HighlightsService stats', () => {
  const row = { completed_bounties: '2', builders: '3', completion_nfts: '4', sponsors: '1' };
  const paidRows = [
    { symbol: 'INJ', token_type: 'NATIVE', amount: '300000000000000000000' },
    { symbol: 'USDC', token_type: 'ERC20', amount: '12500000000' },
  ];
  const paidTotals = [
    { symbol: 'INJ', tokenType: 'NATIVE', decimals: 18, amount: '300000000000000000000' },
    { symbol: 'USDC', tokenType: 'ERC20', decimals: 6, amount: '12500000000' },
  ];
  const expected = { completedBounties: 2, builders: 3, completionNfts: 4, sponsors: 1, paidTotals };

  const isPaidQuery = (sql: string) => sql.includes('FROM payout');

  function setup(paid: unknown[] = paidRows) {
    const query = jest.fn(async (sql: string, _params?: unknown[]) =>
      isPaidQuery(sql) ? { rows: paid, rowCount: paid.length } : { rows: [row], rowCount: 1 },
    );
    const countsSql = () => query.mock.calls.map(([sql]) => sql).filter((sql) => !isPaidQuery(sql));
    const paidSql = () => query.mock.calls.map(([sql]) => sql).filter(isPaidQuery);
    return { query, countsSql, paidSql, service: new HighlightsService(createMockDb({ query: query }).database) };
  }

  afterEach(() => jest.restoreAllMocks());

  it('excludes soft-deleted bounties from every aggregate', async () => {
    const { countsSql, paidSql, service } = setup();
    await expect(service.stats()).resolves.toEqual(expected);

    const subqueries = countsSql()[0].split(/\(SELECT/).slice(1);
    expect(subqueries).toHaveLength(4);
    for (const subquery of subqueries) expect(subquery).toMatch(/deleted_at IS NULL/);
    expect(paidSql()[0]).toMatch(/b\.deleted_at IS NULL/);
  });

  it('counts agent submitters as builders (submitter_user_id is NULL for agent submissions)', async () => {
    const { countsSql, service } = setup();
    await service.stats();

    const sql = countsSql()[0];
    expect(sql).toContain('count(DISTINCT COALESCE(s.submitter_user_id, s.agent_id))');
    expect(sql).not.toContain('count(DISTINCT s.submitter_user_id)');
  });

  it('sums only PAID payouts, grouped per token, joining bounty_reward for the token metadata', async () => {
    const { paidSql, service } = setup();
    await service.stats();

    const sql = paidSql()[0];
    expect(sql).toContain("p.status = 'PAID'");
    expect(sql).toContain('JOIN bounty_reward br ON br.id = p.bounty_reward_id');
    expect(sql).toMatch(/GROUP BY upper\(br\.display_symbol\), br\.token_type/);
    // the DECIMAL(78,0) sum is returned as text so it never passes through a JS number
    expect(sql).toContain('sum(p.amount)::text');
  });

  it('keeps amounts as base-unit strings beyond Number precision and reports null decimals for unknown symbols', async () => {
    const huge = '123456789012345678901234567890';
    const { service } = setup([
      { symbol: 'INJ', token_type: 'NATIVE', amount: huge },
      { symbol: 'ATOM', token_type: 'CW20', amount: '5' },
    ]);
    await expect(service.stats()).resolves.toMatchObject({
      paidTotals: [
        { symbol: 'INJ', tokenType: 'NATIVE', decimals: 18, amount: huge },
        { symbol: 'ATOM', tokenType: 'CW20', decimals: null, amount: '5' },
      ],
    });
  });

  it('returns an empty paidTotals list when nothing has been paid yet', async () => {
    const { service } = setup([]);
    await expect(service.stats()).resolves.toEqual({ ...expected, paidTotals: [] });
  });

  it('serves repeated calls from a 60 s in-memory cache and recomputes once the TTL has passed', async () => {
    const { query, service } = setup();
    let now = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);

    await expect(service.stats()).resolves.toEqual(expected);
    now += STATS_CACHE_TTL_MS - 1;
    await expect(service.stats()).resolves.toEqual(expected);
    expect(query).toHaveBeenCalledTimes(2); // counts + paid totals, once

    now += 1; // expiresAt reached
    query.mockImplementation(async (sql: string) =>
      isPaidQuery(sql) ? { rows: [], rowCount: 0 } : { rows: [{ ...row, completed_bounties: '5' }], rowCount: 1 },
    );
    await expect(service.stats()).resolves.toEqual({ ...expected, completedBounties: 5, paidTotals: [] });
    expect(query).toHaveBeenCalledTimes(4);
    // the refreshed value is cached again
    await service.stats();
    expect(query).toHaveBeenCalledTimes(4);
  });

  it('coalesces concurrent calls while the cache is cold into a single computation (no stampede)', async () => {
    const { query, service } = setup();
    const results = await Promise.all([service.stats(), service.stats(), service.stats()]);
    expect(results).toEqual([expected, expected, expected]);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed computation: the next call queries again', async () => {
    const { query, countsSql, service } = setup();
    query.mockRejectedValueOnce(new Error('connection reset'));
    await expect(service.stats()).rejects.toThrow('connection reset');
    await expect(service.stats()).resolves.toEqual(expected);
    expect(countsSql()).toHaveLength(2);
  });
});
