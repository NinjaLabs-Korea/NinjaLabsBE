import { DatabaseService } from '../common/database/database.service';
import { MaintenanceService } from '../common/maintenance/maintenance.service';
import { describeDb } from './describe-db';
import { createDb, createUser, unique } from './harness';

describeDb('maintenance sweep on a real database', () => {
  let db: DatabaseService;
  beforeAll(() => { db = createDb(); });
  afterAll(async () => db.onModuleDestroy());

  it('deletes stale challenges, old sessions and expired login codes hourly, and clears grace tokens past the 30s window in the 5-minute cron', async () => {
    const userId = await createUser(db);
    const address = `inj1${unique()}`;
    const challenge = (expires: string) => db.query<{ id: string }>(
      `INSERT INTO wallet_verification_challenge (user_id, wallet_address, nonce, message, expires_at)
       VALUES ($1, $2, $3, 'm', now() + $4::interval) RETURNING id`,
      [userId, address, unique(), expires],
    );
    const staleChallenge = (await challenge('-2 days')).rows[0].id;
    const recentlyExpiredChallenge = (await challenge('-1 hour')).rows[0].id; // inside the 1-day grace for CHALLENGE_EXPIRED
    const openChallenge = (await challenge('5 minutes')).rows[0].id;

    const session = (columns: string, values: string) => db.query<{ id: string }>(
      `INSERT INTO auth_session (user_id, refresh_token_hash, expires_at${columns})
       VALUES ($1, $2, ${values}) RETURNING id`,
      [userId, unique('hash-')],
    );
    const revokedLongAgo = (await session(', revoked_at', `now() + interval '10 days', now() - interval '31 days'`)).rows[0].id;
    const expiredLongAgo = (await session('', `now() - interval '31 days'`)).rows[0].id;
    const revokedRecently = (await session(', revoked_at', `now() + interval '10 days', now() - interval '1 day'`)).rows[0].id;
    const active = (await session('', `now() + interval '10 days'`)).rows[0].id;
    const staleGrace = (await session(', prev_refresh_token_hash, prev_rotated_at, grace_refresh_token',
      `now() + interval '10 days', 'prev', now() - interval '31 seconds', 'enc'`)).rows[0].id;
    const freshGrace = (await session(', prev_refresh_token_hash, prev_rotated_at, grace_refresh_token',
      `now() + interval '10 days', 'prev2', now() - interval '5 seconds', 'enc'`)).rows[0].id;

    const expiredCode = unique().padEnd(64, '0');
    const liveCode = unique().padEnd(64, '1');
    await db.query(`INSERT INTO oauth_login_code (code_hash, user_id, code_challenge, expires_at) VALUES ($1, $2, 'c', now() - interval '1 second')`, [expiredCode, userId]);
    await db.query(`INSERT INTO oauth_login_code (code_hash, user_id, code_challenge) VALUES ($1, $2, 'c')`, [liveCode, userId]);

    const service = new MaintenanceService(db);
    const log = jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    await service.sweep();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^maintenance sweep: challenges=\d+ sessions=\d+ login_codes=\d+$/));
    // the hourly sweep leaves grace copies to the 5-minute cron
    expect((await db.query(`SELECT grace_refresh_token FROM auth_session WHERE id = $1`, [staleGrace])).rows[0].grace_refresh_token).toBe('enc');
    await service.clearGraceCopies();

    const ids = async (sql: string, params: unknown[]) => (await db.query<{ id: string }>(sql, params)).rows.map((row) => row.id).sort();
    expect(await ids(`SELECT id FROM wallet_verification_challenge WHERE user_id = $1`, [userId]))
      .toEqual([recentlyExpiredChallenge, openChallenge].sort());
    expect(staleChallenge).toBeDefined();

    expect(await ids(`SELECT id FROM auth_session WHERE user_id = $1`, [userId]))
      .toEqual([revokedRecently, active, staleGrace, freshGrace].sort());
    expect([revokedLongAgo, expiredLongAgo]).toHaveLength(2);

    const grace = await db.query<{ id: string; grace_refresh_token: string | null }>(
      `SELECT id, grace_refresh_token FROM auth_session WHERE id = ANY($1::uuid[]) ORDER BY id`, [[staleGrace, freshGrace]]);
    expect(Object.fromEntries(grace.rows.map((row) => [row.id, row.grace_refresh_token])))
      .toEqual({ [staleGrace]: null, [freshGrace]: 'enc' });

    expect(await ids(`SELECT code_hash AS id FROM oauth_login_code WHERE user_id = $1`, [userId])).toEqual([liveCode]);
  });
});
