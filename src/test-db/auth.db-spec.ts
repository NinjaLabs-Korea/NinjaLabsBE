import { JwtService } from '@nestjs/jwt';
import { createHash, randomUUID } from 'crypto';
import { MAX_REVOKE_CHAIN_HOPS } from '../auth/auth-sessions';
import { AuthService } from '../auth/auth.service';
import { encryptGraceToken } from '../auth/refresh-grace';
import { DatabaseService } from '../common/database/database.service';
import { describeDb } from './describe-db';
import { createDb, createUser, TEST_JWT_SECRET, testConfig, unique } from './harness';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

describeDb('auth sessions on a real database', () => {
  let db: DatabaseService;
  let auth: AuthService;

  beforeAll(() => {
    db = createDb();
    auth = new AuthService(
      db,
      new JwtService({ secret: TEST_JWT_SECRET, signOptions: { expiresIn: '15m' } }),
      testConfig(),
      TEST_JWT_SECRET,
    );
  });
  afterAll(async () => db.onApplicationShutdown());

  async function sessionRows(userId: string) {
    const r = await db.query<{
      refresh_token_hash: string; prev_refresh_token_hash: string | null; prev_rotated_at: Date | null;
      grace_refresh_token: string | null; revoked_at: Date | null; expires_at: Date;
    }>(
      `SELECT refresh_token_hash, prev_refresh_token_hash, prev_rotated_at, grace_refresh_token, revoked_at, expires_at
         FROM auth_session WHERE user_id = $1 ORDER BY created_at`,
      [userId],
    );
    return r.rows;
  }

  it('the grace copy is bound to its session row id (AAD): a copy written for another row is "no grace" → 401 + chain revoked', async () => {
    const user = await auth.upsertGoogleUser(unique('google-'), `${unique()}@example.test`);
    const first = await auth.issueSession(user.id, false);
    const second = await auth.refresh(first.refreshToken);
    const [successor] = (await sessionRows(user.id)).filter((row) => row.prev_refresh_token_hash === sha256(first.refreshToken));
    expect(successor.grace_refresh_token).not.toBeNull();
    // same secret, same plaintext — but sealed for a different row id
    await db.query(`UPDATE auth_session SET grace_refresh_token = $2 WHERE refresh_token_hash = $1`,
      [sha256(second.refreshToken), encryptGraceToken(TEST_JWT_SECRET, randomUUID(), second.refreshToken)]);
    await expect(auth.refresh(first.refreshToken)).rejects.toMatchObject({ message: 'INVALID_REFRESH_TOKEN' });
    await expect(auth.refresh(second.refreshToken)).rejects.toMatchObject({ message: 'INVALID_REFRESH_TOKEN' });
  });

  it('upsertGoogleUser → issueSession → refresh → grace reuse within the window → reuse after the window is 401 + chain revoked', async () => {
    const googleId = unique('google-');
    const email = `${unique()}@example.test`;
    const user = await auth.upsertGoogleUser(googleId, email);
    expect(user.onboarding_step).toBe(2);
    // second login finds the same active row
    await expect(auth.upsertGoogleUser(googleId, email)).resolves.toMatchObject({ id: user.id });

    // saveSession through the pool — both $6 references of the INSERT must deduce one type (42P08 otherwise)
    const first = await auth.issueSession(user.id, false, '127.0.0.1', 'jest');
    expect(first.refreshToken).toMatch(/^[A-Za-z0-9_-]{64}$/);
    await expect(auth.verifyAccessToken(first.accessToken)).resolves.toEqual({ userId: user.id, isAdmin: false });

    let rows = await sessionRows(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ refresh_token_hash: sha256(first.refreshToken), prev_refresh_token_hash: null, prev_rotated_at: null, grace_refresh_token: null, revoked_at: null });
    expect(rows[0].expires_at.getTime() - Date.now()).toBeGreaterThan(13 * 86_400_000);

    // rotation: saveSession inside the tx with prevHash + grace copy
    const second = await auth.refresh(first.refreshToken, '127.0.0.1', 'jest');
    expect(second.refreshToken).not.toBe(first.refreshToken);
    rows = await sessionRows(user.id);
    expect(rows).toHaveLength(2);
    expect(rows[0].revoked_at).not.toBeNull();
    expect(rows[1]).toMatchObject({ refresh_token_hash: sha256(second.refreshToken), prev_refresh_token_hash: sha256(first.refreshToken), revoked_at: null });
    expect(rows[1].prev_rotated_at).not.toBeNull();
    expect(rows[1].grace_refresh_token).not.toBeNull();
    expect(rows[1].grace_refresh_token).not.toContain(second.refreshToken);

    // grace: the old token presented again within 30s yields the SAME successor pair, no new row
    const graced = await auth.refresh(first.refreshToken);
    expect(graced.refreshToken).toBe(second.refreshToken);
    await expect(auth.verifyAccessToken(graced.accessToken)).resolves.toEqual({ userId: user.id, isAdmin: false });
    expect(await sessionRows(user.id)).toHaveLength(2);

    // push the rotation outside the window → the same reuse is now reuse detection
    await db.query(`UPDATE auth_session SET prev_rotated_at = now() - interval '31 seconds' WHERE prev_refresh_token_hash = $1`, [sha256(first.refreshToken)]);
    await expect(auth.refresh(first.refreshToken)).rejects.toMatchObject({ message: 'INVALID_REFRESH_TOKEN' });
    // the successor (and anything derived from it) is revoked with the chain
    await expect(auth.refresh(second.refreshToken)).rejects.toMatchObject({ message: 'INVALID_REFRESH_TOKEN' });
    rows = await sessionRows(user.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.revoked_at !== null && row.grace_refresh_token === null)).toBe(true);
  });

  it('a session whose expires_at has passed is rejected by the SQL predicate (expires_at > now()): 401, no successor row, old row consumed', async () => {
    const user = await auth.upsertGoogleUser(unique('google-'), `${unique()}@example.test`);
    const session = await auth.issueSession(user.id, false);
    // the row is otherwise perfectly valid (not revoked, ACTIVE user) — only the expiry moved into the past
    await db.query(`UPDATE auth_session SET expires_at = now() - interval '1 second' WHERE refresh_token_hash = $1`, [sha256(session.refreshToken)]);
    await expect(auth.refresh(session.refreshToken)).rejects.toMatchObject({ message: 'INVALID_REFRESH_TOKEN' });
    const rows = await sessionRows(user.id);
    expect(rows).toHaveLength(1); // nothing was rotated in
    expect(rows[0].revoked_at).not.toBeNull(); // the replay path consumed the expired row (chain revoke), so it cannot be retried either

    // boundary: a session that expires in the future still rotates
    const live = await auth.issueSession(user.id, false);
    await db.query(`UPDATE auth_session SET expires_at = now() + interval '1 minute' WHERE refresh_token_hash = $1`, [sha256(live.refreshToken)]);
    await expect(auth.refresh(live.refreshToken)).resolves.toMatchObject({ refreshToken: expect.any(String) });
  });

  /** Inserts a hand-built chain of `length` sessions s1→s2→… (each successor names its predecessor's hash), rotated long ago. Returns the raw tokens. */
  async function insertChain(userId: string, length: number): Promise<string[]> {
    const tokens = Array.from({ length }, (_, i) => unique(`chain${i + 1}-`));
    for (let i = 0; i < length; i++) {
      await db.query(
        `INSERT INTO auth_session (user_id, refresh_token_hash, expires_at, revoked_at, prev_refresh_token_hash, prev_rotated_at)
         VALUES ($1, $2, now() + interval '14 days', CASE WHEN $4::boolean THEN NULL ELSE now() END, $3, now() - interval '1 hour')`,
        [userId, sha256(tokens[i]), i ? sha256(tokens[i - 1]) : null, i === length - 1],
      );
    }
    return tokens;
  }

  it(`revokeChain is bounded at ${MAX_REVOKE_CHAIN_HOPS} hops: a longer chain revokes every open session of the user; a chain at the bound leaves unrelated sessions alone`, async () => {
    const warn = jest.spyOn(auth['logger'], 'warn').mockImplementation(() => undefined);

    // (1) chain longer than the bound: the replay of its first token revokes the chain AND an unrelated open session of the same user
    const longUser = await auth.upsertGoogleUser(unique('google-'), `${unique()}@example.test`);
    const unrelatedLong = await auth.issueSession(longUser.id, false);
    const longChain = await insertChain(longUser.id, MAX_REVOKE_CHAIN_HOPS + 8);
    await expect(auth.refresh(longChain[0])).rejects.toMatchObject({ message: 'INVALID_REFRESH_TOKEN' });
    const openAfterLong = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM auth_session WHERE user_id = $1 AND revoked_at IS NULL`, [longUser.id]);
    expect(openAfterLong.rows[0].n).toBe(0);
    await expect(auth.refresh(unrelatedLong.refreshToken)).rejects.toMatchObject({ message: 'INVALID_REFRESH_TOKEN' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`exceeds ${MAX_REVOKE_CHAIN_HOPS} hops`));
    warn.mockClear();

    // (2) chain exactly at the bound: walked to the end, only the chain is revoked, the unrelated session keeps working
    const boundUser = await auth.upsertGoogleUser(unique('google-'), `${unique()}@example.test`);
    const unrelatedBound = await auth.issueSession(boundUser.id, false);
    const boundChain = await insertChain(boundUser.id, MAX_REVOKE_CHAIN_HOPS);
    await expect(auth.refresh(boundChain[0])).rejects.toMatchObject({ message: 'INVALID_REFRESH_TOKEN' });
    const tip = await db.query<{ revoked_at: Date | null }>(`SELECT revoked_at FROM auth_session WHERE refresh_token_hash = $1`, [sha256(boundChain.at(-1)!)]);
    expect(tip.rows[0].revoked_at).not.toBeNull();
    await expect(auth.refresh(unrelatedBound.refreshToken)).resolves.toMatchObject({ refreshToken: expect.any(String) });
    expect(warn).not.toHaveBeenCalled();
  });

  it('a chain of three rotations is revoked end to end when the first token is replayed late', async () => {
    const user = await auth.upsertGoogleUser(unique('google-'), `${unique()}@example.test`);
    const t1 = await auth.issueSession(user.id, false);
    const t2 = await auth.refresh(t1.refreshToken);
    const t3 = await auth.refresh(t2.refreshToken);
    await db.query(`UPDATE auth_session SET prev_rotated_at = now() - interval '1 minute' WHERE user_id = $1`, [user.id]);
    await expect(auth.refresh(t1.refreshToken)).rejects.toMatchObject({ message: 'INVALID_REFRESH_TOKEN' });
    const open = await db.query<{ open: number }>(`SELECT count(*)::int AS open FROM auth_session WHERE user_id = $1 AND revoked_at IS NULL`, [user.id]);
    expect(open.rows[0].open).toBe(0);
    await expect(auth.refresh(t3.refreshToken)).rejects.toMatchObject({ message: 'INVALID_REFRESH_TOKEN' });
  });

  it('a late replay of T1 while the owner is mid-rotation of T2 (uncommitted) still revokes the successor S3 once that rotation commits', async () => {
    // Reviewer scenario: a single recursive-CTE UPDATE only sees its statement snapshot — S3 (inserted by the uncommitted rotation)
    // is invisible and S2 is skipped after the lock wait (already revoked), so S3 used to survive. revokeChain now walks the chain
    // hop by hop under FOR UPDATE: it waits on S2's row lock and the next hop's fresh snapshot sees the committed S3.
    const user = await auth.upsertGoogleUser(unique('google-'), `${unique()}@example.test`);
    const t1 = await auth.issueSession(user.id, false);
    const t2 = await auth.refresh(t1.refreshToken);
    await db.query(`UPDATE auth_session SET prev_rotated_at = now() - interval '1 minute' WHERE user_id = $1`, [user.id]);

    // X: the legitimate owner's refresh of T2, held open after its conditional UPDATE (locks S2) and the INSERT of S3
    const t3 = unique('t3-');
    const s3Id = randomUUID();
    let commitX!: () => void;
    const xMayCommit = new Promise<void>((resolve) => { commitX = resolve; });
    const x = db.tx(async (client) => {
      const consumed = await client.query(
        `UPDATE auth_session SET revoked_at = now(), grace_refresh_token = NULL WHERE refresh_token_hash = $1 AND revoked_at IS NULL`,
        [sha256(t2.refreshToken)]);
      expect(consumed.rowCount).toBe(1);
      await client.query(
        `INSERT INTO auth_session (id, user_id, refresh_token_hash, expires_at, prev_refresh_token_hash, prev_rotated_at, grace_refresh_token)
         VALUES ($5, $1, $2, now() + interval '14 days', $3, now(), $4)`,
        [user.id, sha256(t3), sha256(t2.refreshToken), encryptGraceToken(TEST_JWT_SECRET, s3Id, t3), s3Id]);
      await xMayCommit;
    });

    // attacker replays T1 (outside the grace window) while X is still open — it must block on S2's row lock
    const attack = auth.refresh(t1.refreshToken).then(() => 'ok' as const, (err: Error) => err.message);
    const deadline = Date.now() + 10_000;
    for (;;) {
      const waiting = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`);
      if (waiting.rows[0].n > 0) break;
      if (Date.now() > deadline) throw new Error('the replay never blocked on the in-flight rotation');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    commitX();
    await x;

    await expect(attack).resolves.toBe('INVALID_REFRESH_TOKEN');
    const rows = await sessionRows(user.id);
    expect(rows).toHaveLength(3);
    const s3 = rows.find((row) => row.refresh_token_hash === sha256(t3))!;
    expect(s3.revoked_at).not.toBeNull();
    expect(s3.grace_refresh_token).toBeNull();
    expect(rows.every((row) => row.revoked_at !== null)).toBe(true);
    await expect(auth.refresh(t3)).rejects.toMatchObject({ message: 'INVALID_REFRESH_TOKEN' });
  });

  it('issueLoginCode → exchangeLoginCode (PKCE) issues a session inside the transaction and burns the code', async () => {
    const user = await auth.upsertGoogleUser(unique('google-'), `${unique()}@example.test`);
    const verifier = unique().padEnd(43, 'v');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const code = await auth.issueLoginCode(user.id, challenge);
    const stored = await db.query(`SELECT user_id FROM oauth_login_code WHERE code_hash = $1`, [sha256(code)]);
    expect(stored.rowCount).toBe(1);

    const tokens = await auth.exchangeLoginCode(code, verifier, '10.0.0.1', 'jest');
    await expect(auth.verifyAccessToken(tokens.accessToken)).resolves.toEqual({ userId: user.id, isAdmin: false });
    const session = await db.query(`SELECT host(ip_address) AS ip, user_agent FROM auth_session WHERE refresh_token_hash = $1`, [sha256(tokens.refreshToken)]);
    expect(session.rows[0]).toEqual({ ip: '10.0.0.1', user_agent: 'jest' });
    // single use
    await expect(auth.exchangeLoginCode(code, verifier)).rejects.toMatchObject({ message: 'INVALID_LOGIN_CODE' });
    // wrong verifier never consumes a code
    const code2 = await auth.issueLoginCode(user.id, challenge);
    await expect(auth.exchangeLoginCode(code2, 'x'.repeat(43))).rejects.toMatchObject({ message: 'INVALID_LOGIN_CODE' });
    await expect(auth.exchangeLoginCode(code2, verifier)).resolves.toMatchObject({ accessToken: expect.any(String) });
  });

  it('revoke (logout) closes the session and a refresh of a suspended user is rejected and consumed', async () => {
    const user = await auth.upsertGoogleUser(unique('google-'), `${unique()}@example.test`);
    const session = await auth.issueSession(user.id, false);
    await auth.revoke(session.refreshToken);
    await expect(auth.refresh(session.refreshToken)).rejects.toMatchObject({ message: 'INVALID_REFRESH_TOKEN' });

    const other = await auth.issueSession(user.id, false);
    await db.query(`UPDATE "user" SET status = 'SUSPENDED' WHERE id = $1`, [user.id]);
    await expect(auth.refresh(other.refreshToken)).rejects.toMatchObject({ message: 'INVALID_REFRESH_TOKEN' });
    const rows = await sessionRows(user.id);
    expect(rows.every((row) => row.revoked_at !== null)).toBe(true);
  });

  it('revoke with a token that was just rotated (logout racing another tab\'s refresh) closes the successor too; after the grace window it leaves the successor alone', async () => {
    const user = await auth.upsertGoogleUser(unique('google-'), `${unique()}@example.test`);
    const first = await auth.issueSession(user.id, false);
    const second = await auth.refresh(first.refreshToken);
    await auth.revoke(first.refreshToken);
    expect((await sessionRows(user.id)).every((row) => row.revoked_at !== null && row.grace_refresh_token === null)).toBe(true);
    await expect(auth.refresh(second.refreshToken)).rejects.toMatchObject({ message: 'INVALID_REFRESH_TOKEN' });

    const lateUser = await auth.upsertGoogleUser(unique('google-'), `${unique()}@example.test`);
    const a = await auth.issueSession(lateUser.id, false);
    const b = await auth.refresh(a.refreshToken);
    await db.query(`UPDATE auth_session SET prev_rotated_at = now() - interval '31 seconds' WHERE prev_refresh_token_hash = $1`, [sha256(a.refreshToken)]);
    await auth.revoke(a.refreshToken);
    await expect(auth.refresh(b.refreshToken)).resolves.toMatchObject({ refreshToken: expect.any(String) });
  });

  it('getMe reflects wallet and parent NFT state', async () => {
    const userId = await createUser(db);
    await expect(auth.getMe(userId)).resolves.toMatchObject({ id: userId, wallet: null, nft: null, onboardingCompleted: false, tags: [] });
  });
});
