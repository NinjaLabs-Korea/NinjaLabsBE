import { withParamsCheck } from '../../test-support/expect-params-match';
import { PgThrottlerStorage, THROTTLER_INCREMENT_SQL } from './pg-throttler-storage';

describe('PgThrottlerStorage', () => {
  function setup(row = { hits: 3, time_to_expire: 42, is_blocked: false, time_to_block_expire: 0 }) {
    const query = jest.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [row] }));
    const storage = new PgThrottlerStorage({ query: withParamsCheck(query) });
    const error = jest.spyOn(storage['logger'], 'error').mockImplementation(() => undefined);
    return { storage, query, error };
  }

  it('counts with one upsert keyed by throttler name, binding integer ms ttl/limit/blockDuration', async () => {
    const { storage, query } = setup();
    const record = await storage.increment('abc', 60_000, 120, 60_000, 'default');
    expect(record).toEqual({ totalHits: 3, timeToExpire: 42, isBlocked: false, timeToBlockExpire: 0 });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(THROTTLER_INCREMENT_SQL, ['default:abc', 60_000, 120, 60_000]);
  });

  it('is a single atomic INSERT … ON CONFLICT DO UPDATE using the database clock', () => {
    expect(THROTTLER_INCREMENT_SQL).toMatch(/^\s*INSERT INTO throttler_storage AS t/);
    expect(THROTTLER_INCREMENT_SQL).toContain('ON CONFLICT (key) DO UPDATE SET');
    expect(THROTTLER_INCREMENT_SQL.split(';').length).toBe(1);
    expect(THROTTLER_INCREMENT_SQL).toContain('now()');
  });

  it('maps a blocked row to isBlocked with the block expiry (guard sets Retry-After from it)', async () => {
    const { storage } = setup({ hits: 11, time_to_expire: 30, is_blocked: true, time_to_block_expire: 55 });
    await expect(storage.increment('k', 60_000, 10, 60_000, 'auth-token'))
      .resolves.toEqual({ totalHits: 11, timeToExpire: 30, isBlocked: true, timeToBlockExpire: 55 });
  });

  it('fails open on a database error and logs at most once a minute', async () => {
    const { storage, query, error } = setup();
    query.mockRejectedValue(new Error('connection refused\nforged line'));
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      await expect(storage.increment('k', 60_000, 10, 60_000, 'default'))
        .resolves.toEqual({ totalHits: 0, timeToExpire: 60, isBlocked: false, timeToBlockExpire: 0 });
      await storage.increment('k', 60_000, 10, 60_000, 'default');
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0][0]).toContain('connection refused\\nforged line');
      now.mockReturnValue(1_060_000);
      await storage.increment('k', 60_000, 10, 60_000, 'default');
      expect(error).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  it.each(['timeout exceeded when trying to connect', 'Connection terminated due to connection timeout', 'Query read timeout'])(
    'fails open when the pool times out (%s) — a stalled DB never blocks or 500s the throttled request',
    async (message) => {
      const { storage, query } = setup();
      query.mockRejectedValue(new Error(message));
      await expect(storage.increment('k', 30_000, 5, 0, 'default'))
        .resolves.toEqual({ totalHits: 0, timeToExpire: 30, isBlocked: false, timeToBlockExpire: 0 });
    },
  );
});
