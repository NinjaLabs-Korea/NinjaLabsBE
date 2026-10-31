import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'crypto';
import { AuthController } from './auth.controller';
import { withParamsCheck } from '../test-support/expect-params-match';
import { createMockDb } from '../test-support/mock-db';
import { legacyAccessTokenCutoff } from './access-token.verifier';
import { MAX_REVOKE_CHAIN_HOPS } from './auth-sessions';
import { AuthService } from './auth.service';
import { decryptGraceToken } from './refresh-grace';

/** 유닛 스펙은 JWT_SECRET provider(jwt-secret.ts) 대신 고정 시크릿을 직접 주입한다 - grace 사본은 이 값으로 감싸진다 */
const DEV_SECRET = 'dev-only-secret';

describe('AuthService refresh rotation', () => {
  const userId = '11111111-1111-4111-8111-111111111111';

  function createService(
    txQuery: jest.Mock,
    signAsync: jest.Mock = jest.fn(async () => 'next-access-token'),
    config: Record<string, string> = {},
  ) {
    // Every statement issued through the tx is checked for parameter-count drift ($n vs params.length).
    const { database, db } = createMockDb({ txQuery });
    const jwt = { signAsync };
    const service = new AuthService(
      database,
      jwt as never,
      { get: jest.fn((key: string) => config[key]) } as never,
      DEV_SECRET,
    );
    return { db, jwt, service };
  }

  it('binds every $n placeholder of the session INSERT exactly once per cast position', async () => {
    // $6 is referenced twice (value + CASE) - both references must carry the same cast; a bare/cast mix is 42P08 on Postgres.
    const txQuery = jest
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ user_id: userId, is_admin: false }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const { service } = createService(txQuery);
    await service.refresh('old-refresh-token');
    const [sql, params] = txQuery.mock.calls[1];
    const sixes = (sql as string).match(/\$6(::\w+)?/g)!;
    expect(sixes).toHaveLength(2);
    expect(new Set(sixes).size).toBe(1);
    expect(sixes[0]).toBe('$6::varchar');
    expect(params).toHaveLength(8); // $8 = the pre-generated row id the grace copy is bound to
  });

  it('revokes the old token and inserts its replacement in one transaction', async () => {
    const txQuery = jest
      .fn()
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ user_id: userId, is_admin: true }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const { db, jwt, service } = createService(txQuery);

    const result = await service.refresh('old-refresh-token', '127.0.0.1', 'jest');

    expect(result.accessToken).toBe('next-access-token');
    expect(result.refreshToken).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(db.tx).toHaveBeenCalledTimes(1);
    expect(db.query).not.toHaveBeenCalled();
    expect(jwt.signAsync).toHaveBeenCalledWith({ sub: userId, adm: true, typ: 'access' }, { algorithm: 'HS256' });

    const oldHash = createHash('sha256').update('old-refresh-token').digest('hex');
    const consumeCall = txQuery.mock.calls[0];
    expect(consumeCall[0]).toContain('UPDATE auth_session AS s');
    expect(consumeCall[0]).toContain('s.revoked_at IS NULL');
    // Expiry is decided by the SQL predicate inside the same conditional UPDATE (auth.db-spec drives it on a real expired row).
    expect(consumeCall[0]).toContain('AND s.expires_at > now()');
    // The consumed row drops its own grace copy the moment it is rotated.
    expect(consumeCall[0]).toContain('SET revoked_at = now(), grace_refresh_token = NULL');
    // Rotation is only granted to an ACTIVE, non-deleted owner - the join is part of the conditional UPDATE itself.
    expect(consumeCall[0]).toContain("u.status = 'ACTIVE'");
    expect(consumeCall[0]).toContain('u.deleted_at IS NULL');
    expect(consumeCall[0]).toContain('RETURNING s.user_id, u.is_admin');
    expect(consumeCall[1]).toEqual([oldHash]);

    const insertCall = txQuery.mock.calls[1];
    expect(insertCall[0]).toContain('INSERT INTO auth_session');
    expect(insertCall[0]).toContain('now() + $5::interval');
    expect(insertCall[0]).toContain('prev_refresh_token_hash, prev_rotated_at, grace_refresh_token');
    // the row id is generated up front ($8) because the grace copy is bound to it (AAD)
    const sessionId = insertCall[1][7] as string;
    expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(insertCall[0]).toContain('VALUES ($8::uuid, $1, $2');
    expect(insertCall[1].slice(0, 6)).toEqual([
      userId,
      createHash('sha256').update(result.refreshToken).digest('hex'),
      '127.0.0.1',
      'jest',
      '14 days',
      oldHash,
    ]);
    // The successor row carries an encrypted copy of its own raw token (never the plaintext) for the 30s reuse grace.
    const grace = insertCall[1][6] as string;
    expect(grace).not.toContain(result.refreshToken);
    expect(decryptGraceToken(DEV_SECRET, sessionId, grace)).toBe(result.refreshToken);
    expect(decryptGraceToken(DEV_SECRET, '00000000-0000-4000-8000-000000000000', grace)).toBeNull();
  });

  it.each([
    ['14d', '14 days'],
    ['15m', '15 minutes'],
    ['2 weeks', '2 weeks'],
    ['12 h', '12 hours'],
    [' 90sec ', '90 seconds'],
  ])('normalizes JWT_REFRESH_TTL %s to the Postgres interval %s used in the session INSERT', async (raw, interval) => {
    const txQuery = jest
      .fn()
      .mockResolvedValue({ rowCount: 1, rows: [{ user_id: userId, is_admin: false }] });
    const { service } = createService(txQuery, undefined, { JWT_REFRESH_TTL: raw });
    await service.refresh('old-refresh-token');
    expect(txQuery.mock.calls[1][1][4]).toBe(interval);
  });

  it.each([
    '14 dayz',
    '14',
    'days',
    '1.5d',
    '14 months',
    "14'; DROP TABLE auth_session; --",
  ])('fails at construction (boot) for malformed JWT_REFRESH_TTL %p', (raw) => {
    expect(() => createService(jest.fn(), undefined, { JWT_REFRESH_TTL: raw })).toThrow(/JWT_REFRESH_TTL/);
  });

  it.each(['0d', '0s', '0 weeks', '59s', '30 seconds', '0m', '91d', '13w', '2161h', '129601 minutes', '7776001s'])(
    'fails at construction (boot) for out-of-range JWT_REFRESH_TTL %p (below 60 seconds or above 90 days)',
    (raw) => {
      expect(() => createService(jest.fn(), undefined, { JWT_REFRESH_TTL: raw })).toThrow(/between 60 seconds and 90 days/);
    },
  );

  it.each([
    ['60s', '60 seconds'],
    ['1m', '1 minutes'],
    ['90d', '90 days'],
    ['12w', '12 weeks'],
    ['2160h', '2160 hours'],
  ])('accepts the boundary JWT_REFRESH_TTL %s as %s', async (raw, interval) => {
    const txQuery = jest.fn().mockResolvedValue({ rowCount: 1, rows: [{ user_id: userId, is_admin: false }] });
    const { service } = createService(txQuery, undefined, { JWT_REFRESH_TTL: raw });
    await service.refresh('old-refresh-token');
    expect(txQuery.mock.calls[1][1][4]).toBe(interval);
  });

  it('rejects an expired or already consumed refresh token without issuing a replacement', async () => {
    const txQuery = jest.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    const { jwt, service } = createService(txQuery);

    await expect(service.refresh('already-used')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(jwt.signAsync).not.toHaveBeenCalled();
    expect(txQuery.mock.calls.some(([sql]) => sql.includes('INSERT INTO auth_session'))).toBe(false);
  });

  it('decides expiry in SQL: the consume UPDATE carries expires_at > now() in its WHERE clause (no JS-side expiry check exists to fall back on)', async () => {
    const txQuery = jest.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    const { service } = createService(txQuery);
    await expect(service.refresh('expired-token')).rejects.toMatchObject({ message: 'INVALID_REFRESH_TOKEN' });
    const [consume] = txQuery.mock.calls;
    expect(consume[0]).toMatch(/UPDATE auth_session AS s[\s\S]*WHERE s\.refresh_token_hash = \$1[\s\S]*AND s\.expires_at > now\(\)[\s\S]*RETURNING s\.user_id/);
    // the grace lookup is fenced the same way, so an expired successor never hands out its pair either
    expect(txQuery.mock.calls[1][0]).toContain('AND s.expires_at > now()');
  });

  it('refuses to rotate a session whose user is suspended or deleted, and still consumes the old token', async () => {
    // The conditional UPDATE matches nothing because the join requires status='ACTIVE' AND deleted_at IS NULL.
    const txQuery = jest.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    const { db, jwt, service } = createService(txQuery);

    const error = await service.refresh('suspended-user-token').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnauthorizedException);
    expect((error as UnauthorizedException).message).toBe('INVALID_REFRESH_TOKEN');
    expect(jwt.signAsync).not.toHaveBeenCalled();
    // The transaction that revoked the chain resolved (committed); the 401 is thrown afterwards, not inside it (which would roll it back).
    await expect(db.tx.mock.results[0].value).resolves.toEqual({ reuse: true });

    const hash = createHash('sha256').update('suspended-user-token').digest('hex');
    const [attempt, grace, hop, revoke] = txQuery.mock.calls;
    expect(attempt[0]).toContain("u.status = 'ACTIVE'");
    expect(attempt[0]).toContain('u.deleted_at IS NULL');
    // The grace lookup also requires an ACTIVE, non-deleted owner, so a suspended user never gets the successor pair.
    expect(grace[0]).toContain('s.prev_refresh_token_hash = $1');
    expect(grace[0]).toContain("u.status = 'ACTIVE'");
    // Chain revocation locks the tip (and successors) hop by hop, then revokes what it collected.
    expect(hop[0]).toContain('FOR UPDATE');
    expect(hop[1]).toEqual([[hash]]);
    expect(revoke[0]).toContain('UPDATE auth_session SET revoked_at = now(), grace_refresh_token = NULL');
    expect(revoke[0]).toContain('WHERE id = ANY($1::uuid[]) AND revoked_at IS NULL');
    expect(txQuery).toHaveBeenCalledTimes(4);
  });

  /**
   * Simulated auth_session state machine for the reuse-grace tests: the first conditional UPDATE wins,
   * later ones see 0 rows; the grace SELECT returns the successor row (with its encrypted copy) only while
   * `successorAlive` is true and the caller says the window is still open.
   */
  function reuseScenario(options: { withinWindow: boolean; successorAlive?: boolean; corruptGrace?: boolean }) {
    let consumed = false;
    let graceToken: string | null = null;
    let successorId: string | null = null;
    // Like a row lock: the loser's conditional UPDATE only returns (0 rows) once the winner's session INSERT is in.
    let winnerCommitted!: () => void;
    const committed = new Promise<void>((resolve) => { winnerCommitted = resolve; });
    const txQuery = jest.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('UPDATE auth_session AS s')) {
        if (consumed) {
          await committed;
          return { rowCount: 0, rows: [] };
        }
        consumed = true;
        await Promise.resolve();
        return { rowCount: 1, rows: [{ user_id: userId, is_admin: false }] };
      }
      if (sql.includes('INSERT INTO auth_session')) {
        graceToken = params![6] as string;
        successorId = params![7] as string;
        winnerCommitted();
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('s.prev_refresh_token_hash = $1')) {
        const alive = options.withinWindow && (options.successorAlive ?? true) && graceToken;
        return alive
          ? { rowCount: 1, rows: [{ id: successorId, user_id: userId, is_admin: false, grace_refresh_token: options.corruptGrace ? 'x.y.z' : graceToken }] }
          : { rowCount: 0, rows: [] };
      }
      if (sql.includes('FOR UPDATE') || sql.includes('id = ANY($1::uuid[])')) return { rowCount: 0, rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    });
    return { txQuery, ...createService(txQuery) };
  }

  it('two concurrent rotations of the same token: one rotates, the other receives the SAME successor pair without rotating again', async () => {
    const { txQuery, jwt, service } = reuseScenario({ withinWindow: true });

    const results = await Promise.allSettled([
      service.refresh('shared-refresh-token'),
      service.refresh('shared-refresh-token'),
    ]);

    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    const [first, second] = results.map((result) => (result as PromiseFulfilledResult<{ accessToken: string; refreshToken: string }>).value);
    expect(second.refreshToken).toBe(first.refreshToken);
    expect(second.accessToken).toBe('next-access-token');
    // Exactly one new session row; the loser re-signs an access token for the same user but never inserts or revokes.
    expect(txQuery.mock.calls.filter(([sql]) => sql.includes('INSERT INTO auth_session'))).toHaveLength(1);
    expect(txQuery.mock.calls.some(([sql]) => sql.includes('id = ANY($1::uuid[])'))).toBe(false);
    expect(jwt.signAsync).toHaveBeenCalledTimes(2);
    expect(jwt.signAsync).toHaveBeenLastCalledWith({ sub: userId, adm: false, typ: 'access' }, { algorithm: 'HS256' });
    const grace = txQuery.mock.calls.find(([sql]) => sql.includes('s.prev_refresh_token_hash = $1'))!;
    expect(grace[0]).toContain("s.prev_rotated_at > now() - interval '30 seconds'");
    expect(grace[0]).toContain('s.grace_refresh_token IS NOT NULL');
    expect(grace[0]).toContain('s.revoked_at IS NULL');
    expect(grace[1]).toEqual([createHash('sha256').update('shared-refresh-token').digest('hex')]);
  });

  it('reuse after the 30s window is reuse detection: 401 and the successor chain is revoked', async () => {
    const { txQuery, jwt, service, db } = reuseScenario({ withinWindow: false });
    await service.refresh('old-token');
    jwt.signAsync.mockClear();

    const error = await service.refresh('old-token').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnauthorizedException);
    expect((error as UnauthorizedException).message).toBe('INVALID_REFRESH_TOKEN');
    expect(jwt.signAsync).not.toHaveBeenCalled();
    // chain revocation is committed before the 401 (the tx callback resolves instead of throwing)
    await expect(db.tx.mock.results[1].value).resolves.toEqual({ reuse: true });
    // Base case is the reused token's own row; each hop locks it and follows prev_refresh_token_hash forward to its successors.
    const hop = txQuery.mock.calls.find(([sql]) => sql.includes('FOR UPDATE'))!;
    expect(hop[0]).toContain('WHERE refresh_token_hash = ANY($1::varchar[]) OR prev_refresh_token_hash = ANY($1::varchar[])');
    expect(hop[1]).toEqual([[createHash('sha256').update('old-token').digest('hex')]]);
    const revoke = txQuery.mock.calls.find(([sql]) => sql.includes('id = ANY($1::uuid[])'))!;
    expect(revoke[0]).toContain('UPDATE auth_session SET revoked_at = now(), grace_refresh_token = NULL');
  });

  it('revokeChain follows the chain hop by hop under row locks and revokes every collected row once', async () => {
    const hops: Record<string, Array<{ id: string; refresh_token_hash: string }>> = {
      // tip + its successor; the successor's own successor only becomes visible on the next hop (new snapshot after the lock wait)
      h1: [{ id: 's1', refresh_token_hash: 'h1' }, { id: 's2', refresh_token_hash: 'h2' }],
      h2: [{ id: 's2', refresh_token_hash: 'h2' }, { id: 's3', refresh_token_hash: 'h3' }],
      h3: [{ id: 's3', refresh_token_hash: 'h3' }],
    };
    const txQuery = jest.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FOR UPDATE')) {
        const rows = (params![0] as string[]).flatMap((h) => hops[h] ?? []);
        return { rowCount: rows.length, rows };
      }
      return { rowCount: 0, rows: [] };
    });
    const { service } = createService(txQuery);
    await service['sessions'].revokeChain({ query: txQuery }, 'h1');

    const locks = txQuery.mock.calls.filter(([sql]) => sql.includes('FOR UPDATE')).map(([, params]) => params![0]);
    expect(locks).toEqual([['h1'], ['h2'], ['h3']]);
    const revoke = txQuery.mock.calls.find(([sql]) => sql.includes('id = ANY($1::uuid[])'))!;
    expect(revoke[1]).toEqual([['s1', 's2', 's3']]);
  });

  /** A chain of `length` sessions s1→s2→…: hop i (locking h_i) reveals s_i and its successor s_(i+1); the last one has no successor */
  function chainedTxQuery(length: number) {
    return jest.fn(withParamsCheck(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FOR UPDATE')) {
        const rows = (params![0] as string[]).flatMap((h) => {
          const n = Number(h.slice(1));
          if (n < 1 || n > length) return [];
          const self = { id: `s${n}`, user_id: userId, refresh_token_hash: `h${n}` };
          return n < length ? [self, { id: `s${n + 1}`, user_id: userId, refresh_token_hash: `h${n + 1}` }] : [self];
        });
        return { rowCount: rows.length, rows };
      }
      return { rowCount: 0, rows: [] };
    }));
  }

  it(`walks a chain of exactly ${MAX_REVOKE_CHAIN_HOPS} hops to its end and revokes just those rows (no user-wide fallback)`, async () => {
    const txQuery = chainedTxQuery(MAX_REVOKE_CHAIN_HOPS);
    const { service } = createService(txQuery);
    const warn = jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    await service['sessions'].revokeChain({ query: txQuery }, 'h1');

    expect(txQuery.mock.calls.filter(([sql]) => sql.includes('FOR UPDATE'))).toHaveLength(MAX_REVOKE_CHAIN_HOPS);
    const revoke = txQuery.mock.calls.find(([sql]) => sql.includes('id = ANY($1::uuid[])'))!;
    expect(revoke[1]).toEqual([Array.from({ length: MAX_REVOKE_CHAIN_HOPS }, (_, i) => `s${i + 1}`)]);
    expect(txQuery.mock.calls.some(([sql]) => sql.includes('WHERE user_id = $1 AND revoked_at IS NULL'))).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it(`stops after ${MAX_REVOKE_CHAIN_HOPS} hops on a longer (corrupt or forged) chain and revokes every open session of that user instead, with a warning`, async () => {
    const txQuery = chainedTxQuery(MAX_REVOKE_CHAIN_HOPS + 5);
    const { service } = createService(txQuery);
    const warn = jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    await service['sessions'].revokeChain({ query: txQuery }, 'h1');

    // the walk is bounded: exactly MAX hops were locked, then the user-wide revoke replaced the per-id one
    expect(txQuery.mock.calls.filter(([sql]) => sql.includes('FOR UPDATE'))).toHaveLength(MAX_REVOKE_CHAIN_HOPS);
    expect(txQuery.mock.calls.some(([sql]) => sql.includes('id = ANY($1::uuid[])'))).toBe(false);
    const fallback = txQuery.mock.calls.at(-1)!;
    expect(fallback[0]).toContain('UPDATE auth_session SET revoked_at = now(), grace_refresh_token = NULL');
    expect(fallback[0]).toContain('WHERE user_id = $1 AND revoked_at IS NULL');
    expect(fallback[1]).toEqual([userId]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`exceeds ${MAX_REVOKE_CHAIN_HOPS} hops`));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`revoking every open session of user ${userId}`));
  });

  it('reuse within the window but after the successor itself was rotated or revoked is still 401 + chain revoke', async () => {
    const { txQuery, service } = reuseScenario({ withinWindow: true, successorAlive: false });
    await service.refresh('old-token');
    await expect(service.refresh('old-token')).rejects.toMatchObject({ message: 'INVALID_REFRESH_TOKEN' });
    expect(txQuery.mock.calls.some(([sql]) => sql.includes('id = ANY($1::uuid[])'))).toBe(true);
  });

  it('falls back to 401 + chain revoke when the stored grace copy cannot be decrypted', async () => {
    const { txQuery, service } = reuseScenario({ withinWindow: true, corruptGrace: true });
    await service.refresh('old-token');
    await expect(service.refresh('old-token')).rejects.toMatchObject({ message: 'INVALID_REFRESH_TOKEN' });
    expect(txQuery.mock.calls.some(([sql]) => sql.includes('id = ANY($1::uuid[])'))).toBe(true);
  });
});

describe('AuthService access token type binding', () => {
  const userId = '11111111-1111-4111-8111-111111111111';

  function createService(verifyAsync: jest.Mock) {
    const { database, db } = createMockDb();
    const service = new AuthService(
      database,
      { signAsync: jest.fn(), verifyAsync } as never,
      { get: jest.fn() } as never,
      DEV_SECRET,
    );
    return { service, db };
  }

  it('accepts a signed token carrying typ=access and a string sub', async () => {
    const { service } = createService(jest.fn(async () => ({ sub: userId, adm: true, typ: 'access' })));
    await expect(service.verifyAccessToken('t')).resolves.toEqual({ userId, isAdmin: true });
  });

  // TODO(remove after 2026-11-30): together with the legacy branch in verifyAccessToken
  it('accepts a legacy access token (no typ, no p, string sub) only if it was issued before this process started', async () => {
    const beforeStart = Math.floor(performance.timeOrigin / 1000) - 60;
    const { service } = createService(jest.fn(async () => ({ sub: userId, adm: false, iat: beforeStart })));
    await expect(service.verifyAccessToken('t')).resolves.toEqual({ userId, isAdmin: false });
  });

  it.each([
    ['issued after this process started', { sub: userId, iat: Math.ceil(Date.now() / 1000) + 1 }],
    ['without an iat', { sub: userId }],
    ['with a non-numeric iat', { sub: userId, iat: '0' }],
  ])('rejects a typ-less token %s', async (_label, payload) => {
    const { service } = createService(jest.fn(async () => payload));
    await expect(service.verifyAccessToken('t')).rejects.toMatchObject({ message: 'INVALID_ACCESS_TOKEN' });
  });

  it('LEGACY_ACCESS_TOKEN_CUTOFF moves the cutoff; an unparseable value fails at boot', async () => {
    expect(legacyAccessTokenCutoff(undefined, 1_234.9)).toBe(1_234);
    expect(legacyAccessTokenCutoff('  ', 99)).toBe(99);
    expect(legacyAccessTokenCutoff('2026-10-24T00:00:00Z')).toBe(Date.parse('2026-10-24T00:00:00Z'));
    expect(() => legacyAccessTokenCutoff('yesterday')).toThrow('LEGACY_ACCESS_TOKEN_CUTOFF must be an ISO 8601 timestamp');

    const iat = Math.floor(Date.parse('2026-10-23T00:00:00Z') / 1000);
    const service = new AuthService(
      createMockDb().database,
      { verifyAsync: jest.fn(async () => ({ sub: userId, iat })) } as never,
      { get: (key: string) => (key === 'LEGACY_ACCESS_TOKEN_CUTOFF' ? '2026-10-22T00:00:00Z' : undefined) } as never,
      DEV_SECRET,
    );
    await expect(service.verifyAccessToken('t')).rejects.toMatchObject({ message: 'INVALID_ACCESS_TOKEN' });
  });

  it.each([
    ['an OAuth state JWT (p=gstate, no typ/sub)', { p: 'gstate', c: 'c'.repeat(43), r: 'https://app.example' }],
    ['an OAuth state JWT that somehow carries a sub', { p: 'gstate', sub: userId, c: 'c'.repeat(43) }],
    ['a legacy-shaped token with any p claim', { sub: userId, p: 'other' }],
    ['a token with a different typ', { sub: userId, typ: 'refresh' }],
    ['a token with a null typ', { sub: userId, typ: null }],
    ['a token whose sub is not a string', { sub: 42, typ: 'access' }],
    ['a legacy-shaped token whose sub is not a string', { sub: 42 }],
    ['a token with an empty sub', { sub: '', typ: 'access' }],
  ])('rejects %s even though the signature verifies', async (_label, payload) => {
    const { service } = createService(jest.fn(async () => payload));
    await expect(service.verifyAccessToken('t')).rejects.toMatchObject({ message: 'INVALID_ACCESS_TOKEN' });
  });

  it('rejects a token whose signature or expiry fails', async () => {
    const { service } = createService(jest.fn(async () => { throw new Error('jwt expired'); }));
    await expect(service.verifyAccessToken('t')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('sessionUserOf (the `user` of a cookie-mode refresh/exchange) is getMe for the verified token\'s sub, never a second serializer', async () => {
    const { service } = createService(jest.fn(async () => ({ sub: userId, adm: false, typ: 'access' })));
    const me = { id: userId, nickname: 'ryan' };
    const getMe = jest.spyOn(service, 'getMe').mockResolvedValue(me as never);
    await expect(service.sessionUserOf('t')).resolves.toBe(me);
    expect(getMe).toHaveBeenCalledWith(userId);

    const { service: forged } = createService(jest.fn(async () => ({ p: 'gstate' })));
    const neverRead = jest.spyOn(forged, 'getMe');
    await expect(forged.sessionUserOf('t')).rejects.toMatchObject({ message: 'INVALID_ACCESS_TOKEN' });
    expect(neverRead).not.toHaveBeenCalled();
  });
});

describe('AuthService upsertGoogleUser', () => {
  const userId = '11111111-1111-4111-8111-111111111111';

  function createService(query: jest.Mock) {
    return new AuthService(
      // every upsert statement is checked for $n/params drift; assertions still read the original mock's calls
      createMockDb({ query }).database,
      { signAsync: jest.fn(), verifyAsync: jest.fn() } as never,
      { get: jest.fn() } as never,
      DEV_SECRET,
    );
  }

  it('returns the existing active user without inserting', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rowCount: 1, rows: [{ id: userId, is_admin: false }] });
    await expect(createService(query).upsertGoogleUser('google', 'a@example.com')).resolves.toMatchObject({ id: userId });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('deleted_at IS NULL');
  });

  it.each(['uq_user_email', 'uq_user_google_id'])('maps a unique violation on %s at insert to 409 ACCOUNT_CONFLICT instead of a 500', async (constraint) => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505', constraint }))
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }); // re-check by google_id: nobody - the conflict is the email of another account
    const error = await createService(query).upsertGoogleUser('google', 'a@example.com').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).message).toBe('ACCOUNT_CONFLICT');
  });

  it('a concurrent first login of the same Google account signs in as the row the other callback just created (no 409)', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'uq_user_google_id' }))
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: userId, is_admin: false }] });
    await expect(createService(query).upsertGoogleUser('google', 'a@example.com')).resolves.toMatchObject({ id: userId });
    expect(query).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['the temporary nickname index', 'uq_user_nickname_active'],
    ['no constraint name', undefined],
  ])('rethrows a unique violation from %s unchanged (not an account conflict, no re-lookup)', async (_what, constraint) => {
    const boom = Object.assign(new Error('duplicate key'), { code: '23505', constraint });
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockRejectedValueOnce(boom);
    await expect(createService(query).upsertGoogleUser('google', 'a@example.com')).rejects.toBe(boom);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('propagates other insert errors unchanged', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockRejectedValueOnce(new Error('connection reset'));
    await expect(createService(query).upsertGoogleUser('google', 'a@example.com')).rejects.toThrow('connection reset');
  });

  it('redirects the OAuth callback to #error=AUTH_FAILED when the upsert conflicts', async () => {
    const auth = {
      verifyOauthState: jest.fn(async () => ({ codeChallenge: 'c'.repeat(43) })),
      exchangeGoogleCode: jest.fn(async () => ({ googleId: 'google', email: 'a@example.com' })),
      upsertGoogleUser: jest.fn(async () => { throw new ConflictException('ACCOUNT_CONFLICT'); }),
      issueLoginCode: jest.fn(),
    };
    const controller = new AuthController(auth as never, { get: () => 'https://app.example/' } as never, { enabled: false } as never);
    const res = { redirect: jest.fn() };
    await controller.googleCallback('google-code', 'state', undefined, { headers: {} } as never, res as never);
    expect(res.redirect).toHaveBeenCalledWith('https://app.example/auth/callback#error=AUTH_FAILED');
    expect(auth.issueLoginCode).not.toHaveBeenCalled();
  });
});
