import { withParamsCheck } from '../test-support/expect-params-match';
import { HighlightsService, STATS_CACHE_TTL_MS } from './highlights.service';

describe('HighlightsService stats', () => {
  const row = { completed_bounties: '2', builders: '3', completion_nfts: '4', sponsors: '1' };
  const expected = { completedBounties: 2, builders: 3, completionNfts: 4, sponsors: 1 };

  function setup() {
    const query = jest.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [row], rowCount: 1 }));
    return { query, service: new HighlightsService({ query: withParamsCheck(query) } as never) };
  }

  afterEach(() => jest.restoreAllMocks());

  it('excludes soft-deleted bounties from every aggregate', async () => {
    const { query, service } = setup();
    await expect(service.stats()).resolves.toEqual(expected);

    const sql = query.mock.calls[0][0];
    const subqueries = sql.split(/\(SELECT/).slice(1);
    expect(subqueries).toHaveLength(4);
    for (const subquery of subqueries) expect(subquery).toMatch(/deleted_at IS NULL/);
  });

  it('counts agent submitters as builders (submitter_user_id is NULL for agent submissions)', async () => {
    const { query, service } = setup();
    await service.stats();

    const sql: string = query.mock.calls[0][0];
    expect(sql).toContain('count(DISTINCT COALESCE(s.submitter_user_id, s.agent_id))');
    expect(sql).not.toContain('count(DISTINCT s.submitter_user_id)');
  });

  it('serves repeated calls from a 60 s in-memory cache and recomputes once the TTL has passed', async () => {
    const { query, service } = setup();
    let now = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);

    await expect(service.stats()).resolves.toEqual(expected);
    now += STATS_CACHE_TTL_MS - 1;
    await expect(service.stats()).resolves.toEqual(expected);
    expect(query).toHaveBeenCalledTimes(1);

    now += 1; // expiresAt reached
    query.mockResolvedValueOnce({ rows: [{ ...row, completed_bounties: '5' }], rowCount: 1 });
    await expect(service.stats()).resolves.toEqual({ ...expected, completedBounties: 5 });
    expect(query).toHaveBeenCalledTimes(2);
    // the refreshed value is cached again
    await service.stats();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent calls while the cache is cold into a single query (no stampede)', async () => {
    const { query, service } = setup();
    const results = await Promise.all([service.stats(), service.stats(), service.stats()]);
    expect(results).toEqual([expected, expected, expected]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed computation: the next call queries again', async () => {
    const { query, service } = setup();
    query.mockRejectedValueOnce(new Error('connection reset'));
    await expect(service.stats()).rejects.toThrow('connection reset');
    await expect(service.stats()).resolves.toEqual(expected);
    expect(query).toHaveBeenCalledTimes(2);
  });
});
