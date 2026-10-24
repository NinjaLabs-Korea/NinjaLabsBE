import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'crypto';
import { createMockDb } from '../test-support/mock-db';
import { AuthService } from './auth.service';
import { GoogleIdTokenVerifier } from './google-id-token.verifier';

/**
 * AuthService 분기 중 다른 스펙(auth.service.spec / login-code.spec / google-id-token.spec)이 밟지 않는 것들:
 * Google 동의 URL, OAuth state 검증 실패 모양, 로그인 코드 형식 가드, 신규 유저 INSERT, issueSession/revoke, getMe 응답 매핑.
 */
const DEV_SECRET = 'dev-only-secret';
const userId = '11111111-1111-4111-8111-111111111111';
const challenge = 'A'.repeat(43);

function createService(options: {
  query?: jest.Mock;
  txQuery?: jest.Mock;
  config?: Record<string, string>;
  jwt?: { signAsync?: jest.Mock; verifyAsync?: jest.Mock };
  verifier?: Partial<GoogleIdTokenVerifier>;
} = {}) {
  const query = options.query ?? jest.fn(async () => ({ rowCount: 1, rows: [] }));
  const txQuery = options.txQuery ?? jest.fn(async () => ({ rowCount: 0, rows: [] }));
  const { database, db } = createMockDb({ query, txQuery });
  const jwt = { signAsync: jest.fn(async () => 'signed-access'), verifyAsync: jest.fn(), ...options.jwt };
  const config = options.config ?? {};
  const service = new AuthService(
    database,
    jwt as never,
    { get: (key: string) => config[key] } as never,
    DEV_SECRET,
    options.verifier as GoogleIdTokenVerifier | undefined,
  );
  return { service, db, query, txQuery, jwt };
}

describe('AuthService.buildGoogleAuthUrl', () => {
  it('points at the Google consent screen with the configured client, callback, openid email scope, state and select_account', () => {
    const { service } = createService({ config: { GOOGLE_CLIENT_ID: 'cid.apps', GOOGLE_CALLBACK_URL: 'https://api.example/auth/google/callback' } });
    const url = new URL(service.buildGoogleAuthUrl('signed.state.jwt'));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'cid.apps',
      redirect_uri: 'https://api.example/auth/google/callback',
      response_type: 'code',
      scope: 'openid email',
      state: 'signed.state.jwt',
      prompt: 'select_account',
    });
  });

  it('sends an empty redirect_uri when GOOGLE_CALLBACK_URL is unset, and refuses to build a URL without GOOGLE_CLIENT_ID', () => {
    const { service } = createService({ config: { GOOGLE_CLIENT_ID: 'cid.apps' } });
    expect(new URL(service.buildGoogleAuthUrl('s')).searchParams.get('redirect_uri')).toBe('');
    const missing = createService();
    expect(() => missing.service.buildGoogleAuthUrl('s')).toThrow('GOOGLE_CLIENT_ID is not configured');
  });
});

describe('AuthService OAuth state', () => {
  it('drops a trace id that is not [a-zA-Z0-9-]{1,64} instead of signing it into the state', async () => {
    const { service, jwt } = createService();
    for (const trace of ['has space', 'a'.repeat(65), 'line\nbreak', '']) {
      await service.issueOauthState(trace, 'https://app.example/', challenge);
      expect(jwt.signAsync).toHaveBeenLastCalledWith({ p: 'gstate', t: undefined, r: 'https://app.example/', c: challenge }, { expiresIn: '10m' });
    }
    await service.issueOauthState('trace-01', 'https://app.example/', challenge);
    expect(jwt.signAsync).toHaveBeenLastCalledWith({ p: 'gstate', t: 'trace-01', r: 'https://app.example/', c: challenge }, { expiresIn: '10m' });
  });

  it.each([
    ['a 42-char challenge', 'A'.repeat(42)],
    ['a 44-char challenge', 'A'.repeat(44)],
    ['a challenge with base64 padding/plus', `${'A'.repeat(42)}+`],
  ])('refuses %s with 401 INVALID_CODE_CHALLENGE and signs nothing', async (_label, bad) => {
    const { service, jwt } = createService();
    await expect(service.issueOauthState(undefined, 'https://app.example/', bad)).rejects.toMatchObject({ status: 401, message: 'INVALID_CODE_CHALLENGE' });
    expect(jwt.signAsync).not.toHaveBeenCalled();
  });

  it('returns trace, redirect and challenge from a valid state', async () => {
    const verifyAsync = jest.fn(async () => ({ p: 'gstate', t: 'trace-1', r: 'https://app.example/', c: challenge }));
    const { service } = createService({ jwt: { verifyAsync } });
    await expect(service.verifyOauthState('state')).resolves.toEqual({ traceId: 'trace-1', redirectUrl: 'https://app.example/', codeChallenge: challenge });
    expect(verifyAsync).toHaveBeenCalledWith('state');
  });

  it.each([
    ['an access token (wrong purpose)', { sub: userId, typ: 'access' }],
    ['a state with a malformed challenge', { p: 'gstate', c: 'short' }],
    ['a state with a challenge of the wrong alphabet', { p: 'gstate', c: `${'A'.repeat(42)}=` }],
  ])('rejects %s with 401 INVALID_OAUTH_STATE', async (_label, payload) => {
    const { service } = createService({ jwt: { verifyAsync: jest.fn(async () => payload) } });
    await expect(service.verifyOauthState('state')).rejects.toMatchObject({ status: 401, message: 'INVALID_OAUTH_STATE' });
  });

  it('maps an expired or forged state (verifyAsync throws) to the same 401 INVALID_OAUTH_STATE', async () => {
    const { service } = createService({ jwt: { verifyAsync: jest.fn(async () => { throw new Error('jwt expired'); }) } });
    const error = await service.verifyOauthState('state').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnauthorizedException);
    expect((error as UnauthorizedException).message).toBe('INVALID_OAUTH_STATE');
  });
});

describe('AuthService.exchangeGoogleCode — token endpoint and claim edge cases', () => {
  const clientId = 'cid.apps.googleusercontent.com';
  const claims = { iss: 'https://accounts.google.com', aud: clientId, sub: 'google-sub', email: 'a@b.com', email_verified: true };
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  function setup(verify: jest.Mock, body: unknown = { id_token: 'id.token' }) {
    const fetchMock = jest.fn(async (_url: string, _init: RequestInit) => ({ ok: true, json: async () => body }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const { service } = createService({
      config: { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_CALLBACK_URL: 'https://api.example/cb' },
      verifier: { verify } as never,
    });
    return { service, fetchMock };
  }

  it('posts the code with client id/secret/callback as a form to the Google token endpoint', async () => {
    const { service, fetchMock } = setup(jest.fn(async () => claims));
    await service.exchangeGoogleCode('4/the-code');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/x-www-form-urlencoded' });
    expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({
      code: '4/the-code', client_id: clientId, client_secret: 'secret', redirect_uri: 'https://api.example/cb', grant_type: 'authorization_code',
    });
  });

  it('a 200 without an id_token is 401 GOOGLE_CODE_EXCHANGE_FAILED and the verifier is never called', async () => {
    const verify = jest.fn();
    const { service } = setup(verify, { access_token: 'ya29' });
    await expect(service.exchangeGoogleCode('c')).rejects.toMatchObject({ status: 401, message: 'GOOGLE_CODE_EXCHANGE_FAILED' });
    expect(verify).not.toHaveBeenCalled();
  });

  it('accepts the bare issuer "accounts.google.com" and a token without email_verified (only an explicit false is refused)', async () => {
    const bare = setup(jest.fn(async () => ({ ...claims, iss: 'accounts.google.com' })));
    await expect(bare.service.exchangeGoogleCode('c')).resolves.toEqual({ googleId: 'google-sub', email: 'a@b.com' });
    const { email_verified: _ignored, ...withoutFlag } = claims;
    const absent = setup(jest.fn(async () => withoutFlag));
    await expect(absent.service.exchangeGoogleCode('c')).resolves.toEqual({ googleId: 'google-sub', email: 'a@b.com' });
  });

  it.each([
    ['an empty email', { email: '' }],
    ['a missing email', { email: undefined }],
    ['an empty subject', { sub: '' }],
    ['an http:// issuer lookalike', { iss: 'http://accounts.google.com' }],
  ])('refuses %s with 401 INVALID_GOOGLE_ID_TOKEN', async (_label, override) => {
    const { service } = setup(jest.fn(async () => ({ ...claims, ...override })));
    await expect(service.exchangeGoogleCode('c')).rejects.toMatchObject({ status: 401, message: 'INVALID_GOOGLE_ID_TOKEN' });
  });
});

describe('AuthService.upsertGoogleUser — first login', () => {
  it('creates the user at onboarding step 2 with a temporary user_<8 hex> nickname and returns the inserted row', async () => {
    const created = { id: userId, is_admin: false, onboarding_step: 2, onboarding_completed_at: null };
    const query = jest.fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [created] });
    const { service } = createService({ query });
    await expect(service.upsertGoogleUser('google-1', 'new@example.com')).resolves.toBe(created);
    const [sql, params] = query.mock.calls[1];
    expect(sql).toContain('INSERT INTO "user" (google_id, email, nickname, bio, onboarding_step)');
    expect(sql).toContain("VALUES ($1, $2, $3, '', 2)");
    expect(sql).toContain('RETURNING id, is_admin, onboarding_step, onboarding_completed_at');
    expect(params).toEqual(['google-1', 'new@example.com', expect.stringMatching(/^user_[0-9a-f]{8}$/)]);
    expect(query.mock.calls[0][1]).toEqual(['google-1']);
  });
});

describe('AuthService.exchangeLoginCode — format guard', () => {
  const good = { code: 'c'.repeat(43), verifier: 'v'.repeat(43) };
  it.each([
    ['a 42-char code', 'c'.repeat(42), good.verifier],
    ['a 44-char code', 'c'.repeat(44), good.verifier],
    ['a code with "."', `${'c'.repeat(42)}.`, good.verifier],
    ['a 42-char verifier', good.code, 'v'.repeat(42)],
    ['a 129-char verifier', good.code, 'v'.repeat(129)],
    ['a verifier with "+"', good.code, `${'v'.repeat(42)}+`],
  ])('rejects %s with 401 INVALID_LOGIN_CODE before opening a transaction', async (_label, code, verifier) => {
    const { service, db } = createService();
    await expect(service.exchangeLoginCode(code, verifier)).rejects.toMatchObject({ status: 401, message: 'INVALID_LOGIN_CODE' });
    expect(db.tx).not.toHaveBeenCalled();
  });

  it('accepts the RFC 7636 unreserved set (. _ ~ -) in a 128-char verifier and binds sha256(code) + S256(verifier)', async () => {
    const verifier = `${'v'.repeat(124)}._~-`;
    const txQuery = jest.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ user_id: userId, is_admin: true }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const { service, jwt } = createService({ txQuery });
    await expect(service.exchangeLoginCode(good.code, verifier, '10.0.0.9', 'ua/1')).resolves.toMatchObject({ accessToken: 'signed-access' });
    expect(txQuery.mock.calls[0][1]).toEqual([
      createHash('sha256').update(good.code).digest('hex'),
      createHash('sha256').update(verifier).digest('base64url'),
    ]);
    expect(jwt.signAsync).toHaveBeenCalledWith({ sub: userId, adm: true, typ: 'access' });
    // ip / user agent reach the session row
    expect(txQuery.mock.calls[1][1].slice(2, 4)).toEqual(['10.0.0.9', 'ua/1']);
  });
});

describe('AuthService.issueSession / revoke', () => {
  it('issueSession signs a typed access token and stores only the refresh hash (autocommit, no rotation fields)', async () => {
    const query = jest.fn(async () => ({ rowCount: 1, rows: [] }));
    const { service, jwt, db } = createService({ query });
    const session = await service.issueSession(userId, false, '10.1.1.1', 'agent');
    expect(session).toEqual({ accessToken: 'signed-access', refreshToken: expect.stringMatching(/^[A-Za-z0-9_-]{64}$/) });
    expect(jwt.signAsync).toHaveBeenCalledWith({ sub: userId, adm: false, typ: 'access' });
    expect(db.tx).not.toHaveBeenCalled();
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('INSERT INTO auth_session');
    expect(params.slice(0, 7)).toEqual([
      userId, createHash('sha256').update(session.refreshToken).digest('hex'), '10.1.1.1', 'agent', '14 days', null, null,
    ]);
    expect(JSON.stringify(params)).not.toContain(session.refreshToken);
  });

  it('issueSession stores null ip / user agent when the request has none', async () => {
    const query = jest.fn(async () => ({ rowCount: 1, rows: [] }));
    const { service } = createService({ query });
    await service.issueSession(userId, true);
    const params = (query.mock.calls[0] as unknown as [string, unknown[]])[1];
    expect(params.slice(2, 4)).toEqual([null, null]);
  });

  it('revoke closes only the open session of sha256(token) and drops its grace copy', async () => {
    const query = jest.fn(async () => ({ rowCount: 1, rows: [] }));
    const { service } = createService({ query });
    await service.revoke('raw-refresh');
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('SET revoked_at = now(), grace_refresh_token = NULL');
    expect(sql).toContain('WHERE refresh_token_hash = $1 AND revoked_at IS NULL');
    expect(params).toEqual([createHash('sha256').update('raw-refresh').digest('hex')]);
  });
});

describe('AuthService.getMe', () => {
  function meQuery(user: Record<string, unknown> | null, wallet: Record<string, unknown> | null, nft: Record<string, unknown> | null) {
    return jest.fn(async (sql: string) => {
      if (sql.includes('FROM "user" u')) return user ? { rowCount: 1, rows: [user] } : { rowCount: 0, rows: [] };
      if (sql.includes('FROM wallet')) return wallet ? { rowCount: 1, rows: [wallet] } : { rowCount: 0, rows: [] };
      if (sql.includes('FROM nft')) return nft ? { rowCount: 1, rows: [nft] } : { rowCount: 0, rows: [] };
      throw new Error(`unexpected ${sql}`);
    });
  }
  const row = {
    id: userId, nickname: 'ninja', email: 'n@example.com', bio: 'hi', onboarding_step: 4,
    onboarding_completed_at: new Date('2026-10-01T00:00:00Z'), is_admin: true, is_member: false, tags: ['DEV'],
  };

  it('maps the user row to the FE MeResponse with wallet and parent NFT', async () => {
    const verifiedAt = new Date('2026-10-02T00:00:00Z');
    const query = meQuery(row, { address: 'inj1abc', verified_at: verifiedAt }, { status: 'MINTED', token_id: '7' });
    const { service } = createService({ query });
    await expect(service.getMe(userId)).resolves.toEqual({
      id: userId, nickname: 'ninja', email: 'n@example.com', bio: 'hi', tags: ['DEV'], onboardingStep: 4,
      onboardingCompleted: true, isAdmin: true, isMember: false,
      wallet: { address: 'inj1abc', verifiedAt }, nft: { status: 'MINTED', tokenId: '7' },
    });
    for (const [, params] of query.mock.calls as unknown as Array<[string, unknown[]]>) expect(params).toEqual([userId]);
    const [walletSql, nftSql] = (query.mock.calls as unknown as Array<[string]>).slice(1).map(([sql]) => sql);
    expect(walletSql).toContain('is_primary = true AND disconnected_at IS NULL');
    expect(nftSql).toContain("nft_type = 'NINJA_PARENT'");
  });

  it('reports onboardingCompleted=false, wallet=null and nft=null for a fresh user', async () => {
    const { service } = createService({ query: meQuery({ ...row, onboarding_completed_at: null, is_admin: false }, null, null) });
    await expect(service.getMe(userId)).resolves.toMatchObject({ onboardingCompleted: false, isAdmin: false, wallet: null, nft: null });
  });

  it('404 USER_NOT_FOUND for a deleted or unknown user, without reading wallet/nft', async () => {
    const query = meQuery(null, null, null);
    const { service } = createService({ query });
    const error = await service.getMe(userId).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).message).toBe('USER_NOT_FOUND');
    expect(query).toHaveBeenCalledTimes(1);
    expect((query.mock.calls[0] as unknown as [string])[0]).toContain('u.deleted_at IS NULL');
  });
});
