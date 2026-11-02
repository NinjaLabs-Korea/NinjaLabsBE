import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'crypto';
import { AuthController } from './auth.controller';
import { createMockDb, SqlHandler } from '../test-support/mock-db';
import { legacyAccessTokenCutoff } from './access-token.verifier';
import { AuthService } from './auth.service';
import { decryptGraceToken } from './refresh-grace';

/**
 * 단위 스펙은 입력 검사와 분기(토큰 모양, JWT_REFRESH_TTL 해석, 오류 매핑)만 본다. SQL이 실제로 어떤 행을 바꾸는지
 * (회전, 만료, 정지 유저, 유예 창, 사슬 폐기, 동시 첫 로그인)는 src/test-db/auth.db-spec.ts가 실 DB 행으로 단언한다.
 * DB 대역은 엄격 모드라 등록하지 않은 SQL이 나가면 `Unexpected SQL`로 실패한다.
 */

/** 유닛 스펙은 JWT_SECRET provider(jwt-secret.ts) 대신 고정 시크릿을 직접 주입한다 - grace 사본은 이 값으로 감싸진다 */
const DEV_SECRET = 'dev-only-secret';

describe('AuthService refresh rotation', () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const none = { rowCount: 0, rows: [] };

  /** refresh가 내는 문장들 - `consumed`가 첫 조건부 UPDATE의 결과(회전 성공/실패)이고, 나머지 조회는 빈 결과 */
  function refreshHandlers(consumed: { rowCount: number; rows: unknown[] }, withInsert = true): SqlHandler[] {
    return [
      { match: /^UPDATE auth_session AS s/, reply: () => consumed },
      ...(withInsert ? [{ match: /^INSERT INTO auth_session/, reply: () => ({ rowCount: 1, rows: [] }) }] : []),
      { match: /^SELECT s\.id, s\.user_id, u\.is_admin, s\.grace_refresh_token/, reply: () => none },
      { match: /FROM auth_session\s+WHERE refresh_token_hash = ANY/, reply: () => none },
      { match: /^UPDATE auth_session SET revoked_at/, reply: () => none },
    ];
  }

  function createService(handlers: SqlHandler[], config: Record<string, string> = {}) {
    const mock = createMockDb({ strict: true, handlers });
    const jwt = { signAsync: jest.fn(async () => 'next-access-token') };
    const service = new AuthService(
      mock.database,
      jwt as never,
      { get: jest.fn((key: string) => config[key]) } as never,
      DEV_SECRET,
    );
    return { mock, jwt, service };
  }

  const owner = (isAdmin: boolean) => ({ rowCount: 1, rows: [{ user_id: userId, is_admin: isAdmin }] });

  it('rotates in one transaction: a typed access token for the owner, a 64-char refresh token, the old hash consumed, and only a hash plus a sealed grace copy stored', async () => {
    const { mock, jwt, service } = createService(refreshHandlers(owner(true)));

    const result = await service.refresh('old-refresh-token', '127.0.0.1', 'jest');

    expect(result.accessToken).toBe('next-access-token');
    expect(result.refreshToken).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(mock.db.tx).toHaveBeenCalledTimes(1);
    expect(mock.db.query).not.toHaveBeenCalled();
    expect(jwt.signAsync).toHaveBeenCalledWith({ sub: userId, adm: true, typ: 'access' }, { algorithm: 'HS256' });

    const oldHash = createHash('sha256').update('old-refresh-token').digest('hex');
    expect(mock.txStatements(/^UPDATE auth_session AS s/)[0].params).toEqual([oldHash]);
    const [insert] = mock.txStatements(/^INSERT INTO auth_session/);
    const params = insert.params as string[];
    // the row id is generated up front ($8) because the grace copy is bound to it (AAD)
    const sessionId = params[7];
    expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(params.slice(0, 6)).toEqual([
      userId,
      createHash('sha256').update(result.refreshToken).digest('hex'),
      '127.0.0.1',
      'jest',
      '14 days',
      oldHash,
    ]);
    // The successor row carries an encrypted copy of its own raw token (never the plaintext) for the 30s reuse grace.
    const grace = params[6];
    expect(grace).not.toContain(result.refreshToken);
    expect(decryptGraceToken(DEV_SECRET, sessionId, grace)).toBe(result.refreshToken);
    expect(decryptGraceToken(DEV_SECRET, '00000000-0000-4000-8000-000000000000', grace)).toBeNull();
  });

  it('signs adm=false for a non-admin owner', async () => {
    const { jwt, service } = createService(refreshHandlers(owner(false)));
    await service.refresh('old-refresh-token');
    expect(jwt.signAsync).toHaveBeenCalledWith({ sub: userId, adm: false, typ: 'access' }, { algorithm: 'HS256' });
  });

  it.each([
    ['14d', '14 days'],
    ['15m', '15 minutes'],
    ['2 weeks', '2 weeks'],
    ['12 h', '12 hours'],
    [' 90sec ', '90 seconds'],
    ['60s', '60 seconds'],
    ['1m', '1 minutes'],
    ['90d', '90 days'],
    ['12w', '12 weeks'],
    ['2160h', '2160 hours'],
  ])('normalizes JWT_REFRESH_TTL %s to the Postgres interval %s used in the session INSERT (boundaries included)', async (raw, interval) => {
    const { mock, service } = createService(refreshHandlers(owner(false)), { JWT_REFRESH_TTL: raw });
    await service.refresh('old-refresh-token');
    expect(mock.txStatements(/^INSERT INTO auth_session/)[0].params![4]).toBe(interval);
  });

  it.each([
    '14 dayz',
    '14',
    'days',
    '1.5d',
    '14 months',
    "14'; DROP TABLE auth_session; --",
  ])('fails at construction (boot) for malformed JWT_REFRESH_TTL %p', (raw) => {
    expect(() => createService([], { JWT_REFRESH_TTL: raw })).toThrow(/JWT_REFRESH_TTL/);
  });

  it.each(['0d', '0s', '0 weeks', '59s', '30 seconds', '0m', '91d', '13w', '2161h', '129601 minutes', '7776001s'])(
    'fails at construction (boot) for out-of-range JWT_REFRESH_TTL %p (below 60 seconds or above 90 days)',
    (raw) => {
      expect(() => createService([], { JWT_REFRESH_TTL: raw })).toThrow(/between 60 seconds and 90 days/);
    },
  );

  it('rejects a token that cannot be rotated (expired, consumed, unknown, suspended or deleted owner) with 401 INVALID_REFRESH_TOKEN and never signs or inserts a replacement', async () => {
    // no INSERT handler: strict mode would fail the call if a replacement row were written
    const { mock, jwt, service } = createService(refreshHandlers(none, false));

    const error = await service.refresh('already-used').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UnauthorizedException);
    expect((error as UnauthorizedException).message).toBe('INVALID_REFRESH_TOKEN');
    expect(jwt.signAsync).not.toHaveBeenCalled();
    expect(mock.txStatements(/^INSERT INTO auth_session/)).toHaveLength(0);
    // The chain revocation is committed before the 401 (the tx callback resolves instead of throwing, which would roll it back).
    await expect(mock.db.tx.mock.results[0].value).resolves.toEqual({ reuse: true });
    expect(mock.db.query).not.toHaveBeenCalled();
  });
});

describe('AuthService access token type binding', () => {
  const userId = '11111111-1111-4111-8111-111111111111';

  function createService(verifyAsync: jest.Mock) {
    // token verification never touches the database: strict mode with no handlers fails on any statement
    const { database, db } = createMockDb({ strict: true });
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
      createMockDb({ strict: true }).database,
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
  const found = { rowCount: 1, rows: [{ id: userId, is_admin: false }] };
  const none = { rowCount: 0, rows: [] };
  const unique = (constraint?: string) => Object.assign(new Error('duplicate key'), { code: '23505', constraint });

  /** `lookups`는 google_id 조회의 연속 응답(마지막 값이 반복), `insert`는 INSERT의 응답이나 오류 */
  function createService(lookups: Array<typeof found>, insert?: () => never) {
    const queue = [...lookups];
    const mock = createMockDb({
      strict: true,
      handlers: [
        { match: /^SELECT id, is_admin, onboarding_step, onboarding_completed_at FROM "user" WHERE google_id = \$1/, reply: () => (queue.length > 1 ? queue.shift()! : queue[0]) },
        ...(insert ? [{ match: /^INSERT INTO "user"/, reply: insert }] : []),
      ],
    });
    const service = new AuthService(
      mock.database,
      { signAsync: jest.fn(), verifyAsync: jest.fn() } as never,
      { get: jest.fn() } as never,
      DEV_SECRET,
    );
    return { mock, service };
  }

  it.each(['uq_user_email', 'uq_user_google_id'])('maps a unique violation on %s at insert to 409 ACCOUNT_CONFLICT instead of a 500 when no row for the google id appears', async (constraint) => {
    const { service } = createService([none], () => { throw unique(constraint); });
    const error = await service.upsertGoogleUser('google', 'a@example.com').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).message).toBe('ACCOUNT_CONFLICT');
  });

  it('a concurrent first login of the same Google account signs in as the row the other callback just created (no 409)', async () => {
    const { mock, service } = createService([none, found], () => { throw unique('uq_user_google_id'); });
    await expect(service.upsertGoogleUser('google', 'a@example.com')).resolves.toMatchObject({ id: userId });
    expect(mock.statements(/^SELECT id, is_admin/)).toHaveLength(2);
  });

  it.each([
    ['the temporary nickname index', 'uq_user_nickname_active'],
    ['no constraint name', undefined],
  ])('rethrows a unique violation from %s unchanged (not an account conflict, no re-lookup)', async (_what, constraint) => {
    const boom = unique(constraint);
    const { mock, service } = createService([none], () => { throw boom; });
    await expect(service.upsertGoogleUser('google', 'a@example.com')).rejects.toBe(boom);
    expect(mock.statements(/^SELECT id, is_admin/)).toHaveLength(1);
  });

  it('propagates other insert errors unchanged', async () => {
    const { service } = createService([none], () => { throw new Error('connection reset'); });
    await expect(service.upsertGoogleUser('google', 'a@example.com')).rejects.toThrow('connection reset');
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
