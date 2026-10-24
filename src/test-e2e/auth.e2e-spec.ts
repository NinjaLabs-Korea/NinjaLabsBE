import { JwtService } from '@nestjs/jwt';
import { createHash } from 'crypto';
import { describeDb } from '../test-db/describe-db';
import { E2eApp, FE_ORIGIN, PREVIEW_ORIGIN, randomIp, startApp } from './support/harness';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
const unauthorized = (message: string) => ({ statusCode: 401, error: 'Unauthorized', message });

// b. auth — Google OAuth (faked at the network edge) → login code → PKCE exchange → JWT sessions
describeDb('auth over HTTP (e2e)', () => {
  let e2e: E2eApp;
  beforeAll(async () => { e2e = await startApp(); });
  afterAll(async () => e2e?.close());

  it('GET /auth/google without codeChallenge → 401 INVALID_CODE_CHALLENGE (no redirect)', async () => {
    const res = await e2e.get(`/auth/google?returnTo=${encodeURIComponent(FE_ORIGIN)}`);
    expect(res.status).toBe(401);
    expect(res.body).toEqual(unauthorized('INVALID_CODE_CHALLENGE'));
    expect(res.headers.location).toBeUndefined();
  });

  it('full login: Google consent URL → callback redirect carries only #loginCode → wrong verifier 401 → right verifier tokens with typ → /auth/me', async () => {
    const { verifier, challenge } = E2eApp.pkce();
    const sub = `g-${Date.now()}`;
    const ip = randomIp();
    const { googleUrl, callback, location } = await e2e.oauthCallback({ sub, email: `${sub}@example.test` }, { challenge, ip });

    expect(googleUrl.origin + googleUrl.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(googleUrl.searchParams)).toMatchObject({
      client_id: 'e2e-client.apps.googleusercontent.com', redirect_uri: 'http://127.0.0.1/auth/google/callback',
      response_type: 'code', scope: 'openid email', prompt: 'select_account',
    });
    // the backend exchanged the code server-side with its client secret
    const tokenRequest = e2e.google.tokenRequests[e2e.google.tokenRequests.length - 1];
    expect(tokenRequest.get('grant_type')).toBe('authorization_code');
    expect(tokenRequest.get('client_secret')).toBe('e2e-google-client-secret-GOCSPX-zzzz');

    expect(callback.status).toBe(302);
    expect(callback.headers['cache-control']).toBe('no-store');
    expect(callback.headers['referrer-policy']).toBe('no-referrer');
    const url = new URL(location);
    expect(url.origin + url.pathname).toBe(`${FE_ORIGIN}/auth/callback`);
    expect(url.search).toBe('');
    const fragment = new URLSearchParams(url.hash.slice(1));
    expect([...fragment.keys()]).toEqual(['loginCode']);
    const loginCode = fragment.get('loginCode')!;
    expect(loginCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(location).not.toMatch(/accessToken|refreshToken|eyJ/);
    e2e.secrets.add(loginCode);

    const wrong = await e2e.post('/auth/exchange', { code: loginCode, codeVerifier: E2eApp.pkce().verifier }, { ip });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual(unauthorized('INVALID_LOGIN_CODE'));

    const ok = await e2e.post('/auth/exchange', { code: loginCode, codeVerifier: verifier }, { ip });
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store, private');
    expect(Object.keys(ok.body).sort()).toEqual(['accessToken', 'refreshToken']);
    e2e.trackTokens(ok.body);
    expect(claims(ok.body.accessToken)).toMatchObject({ typ: 'access', adm: false, sub: expect.any(String) });
    expect(ok.body.refreshToken).toMatch(/^[A-Za-z0-9_-]{64}$/);

    // single use
    const replay = await e2e.post('/auth/exchange', { code: loginCode, codeVerifier: verifier }, { ip });
    expect(replay.status).toBe(401);

    const me = await e2e.get('/auth/me', { token: ok.body.accessToken });
    expect(me.status).toBe(200);
    expect(me.headers['cache-control']).toBe('no-store, private');
    // exactly the FE MeResponse (NinjaLabsFE/src/lib/api/me.ts)
    expect(Object.keys(me.body).sort()).toEqual(
      ['bio', 'email', 'id', 'isAdmin', 'isMember', 'nft', 'nickname', 'onboardingCompleted', 'onboardingStep', 'tags', 'wallet'].sort());
    expect(me.body).toMatchObject({
      id: claims(ok.body.accessToken).sub, email: `${sub}@example.test`, bio: '', tags: [], onboardingStep: 2,
      onboardingCompleted: false, isAdmin: false, isMember: false, wallet: null, nft: null,
    });
    expect(me.body.nickname).toMatch(/^user_[0-9a-f]{8}$/);

    const session = await e2e.db.query<{ ip_address: string }>(`SELECT host(ip_address) AS ip_address FROM auth_session WHERE refresh_token_hash = $1`, [sha256(ok.body.refreshToken)]);
    expect(session.rows[0].ip_address).toBe(ip); // trust proxy 1 → X-Forwarded-For is the client IP
  });

  describe('returnTo allowlist', () => {
    async function landing(returnTo: string) {
      const { location } = await e2e.oauthCallback({ sub: `g-${Math.random()}`, email: `${Math.random()}@example.test` }, { challenge: E2eApp.pkce().challenge, returnTo });
      return new URL(location).origin;
    }

    it('an exact AUTH_ALLOWED_REDIRECT_ORIGINS entry is honoured (origin only, path dropped)', async () => {
      expect(await landing(`${PREVIEW_ORIGIN}/en/bounties?x=1`)).toBe(PREVIEW_ORIGIN);
    });

    it.each([
      ['the rejected shared-hosting wildcard', 'https://ninjalabsfe-evil-team.vercel.app'],
      ['an unknown origin', 'https://evil.example'],
      ['a scheme downgrade', 'http://ninjalabsfe-git-develop-team.vercel.app'],
      ['garbage', 'not a url'],
    ])('%s falls back to AUTH_SUCCESS_REDIRECT', async (_label, returnTo) => {
      expect(await landing(returnTo)).toBe(FE_ORIGIN);
    });
  });

  it('Google failures land on #error=AUTH_FAILED (unverified email, failed code exchange)', async () => {
    const unverified = await e2e.oauthCallback({ sub: 'g-unverified', email: 'u@example.test', emailVerified: false }, { challenge: E2eApp.pkce().challenge });
    expect(new URL(unverified.location).hash).toBe('#error=AUTH_FAILED');

    const start = await e2e.get(`/auth/google?codeChallenge=${E2eApp.pkce().challenge}`);
    const state = new URL(String(start.headers.location)).searchParams.get('state')!;
    const badCode = await e2e.get(`/auth/google/callback?code=never-issued&state=${encodeURIComponent(state)}`);
    expect(new URL(String(badCode.headers.location)).hash).toBe('#error=AUTH_FAILED');

    const tampered = await e2e.get(`/auth/google/callback?code=x&state=${encodeURIComponent(state)}x`);
    expect(new URL(String(tampered.headers.location)).hash).toBe('#error=AUTH_FAILED');
    const missing = await e2e.get('/auth/google/callback?error=access_denied');
    expect(String(missing.headers.location)).toBe(`${FE_ORIGIN}/auth/callback#error=AUTH_FAILED`);
  });

  describe('refresh rotation', () => {
    it('rotates; the old token inside 30 s returns the winner\'s pair; after the window it is 401 and the whole chain is revoked', async () => {
      const session = await e2e.login();
      const ip = randomIp();
      const rotated = await e2e.post('/auth/refresh', { refreshToken: session.refreshToken }, { ip });
      expect(rotated.status).toBe(200);
      expect(Object.keys(rotated.body).sort()).toEqual(['accessToken', 'refreshToken']);
      e2e.trackTokens(rotated.body);
      expect(rotated.body.refreshToken).not.toBe(session.refreshToken);
      expect(claims(rotated.body.accessToken)).toMatchObject({ sub: session.userId, typ: 'access' });

      // a second tab replays the old token within the grace window → the SAME successor refresh token (no second rotation)
      const graced = await e2e.post('/auth/refresh', { refreshToken: session.refreshToken }, { ip });
      expect(graced.status).toBe(200);
      e2e.trackTokens(graced.body);
      expect(graced.body.refreshToken).toBe(rotated.body.refreshToken);
      // the access token is re-signed (iat may differ by a second) but carries the same identity and purpose
      const { iat: _a, exp: _b, ...gracedClaims } = claims(graced.body.accessToken);
      const { iat: _c, exp: _d, ...rotatedClaims } = claims(rotated.body.accessToken);
      expect(gracedClaims).toEqual(rotatedClaims);
      const open = await e2e.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM auth_session WHERE user_id = $1 AND revoked_at IS NULL`, [session.userId]);
      expect(open.rows[0].n).toBe(1);

      // the system clock for this check is Postgres now(): move the rotation 31 s into the past
      await e2e.db.query(`UPDATE auth_session SET prev_rotated_at = now() - interval '31 seconds' WHERE prev_refresh_token_hash = $1`, [sha256(session.refreshToken)]);
      const late = await e2e.post('/auth/refresh', { refreshToken: session.refreshToken }, { ip });
      expect(late.status).toBe(401);
      expect(late.body).toEqual(unauthorized('INVALID_REFRESH_TOKEN'));
      // reuse detection revoked the successor as well
      const successor = await e2e.post('/auth/refresh', { refreshToken: rotated.body.refreshToken }, { ip });
      expect(successor.status).toBe(401);
      const stillOpen = await e2e.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM auth_session WHERE user_id = $1 AND revoked_at IS NULL`, [session.userId]);
      expect(stillOpen.rows[0].n).toBe(0);
    });

    it('two tabs refreshing the same token at once both get the same successor refresh token', async () => {
      const session = await e2e.login();
      const ip = randomIp();
      const [a, b] = await Promise.all([
        e2e.post('/auth/refresh', { refreshToken: session.refreshToken }, { ip }),
        e2e.post('/auth/refresh', { refreshToken: session.refreshToken }, { ip }),
      ]);
      e2e.trackTokens(a.body); e2e.trackTokens(b.body);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(a.body.refreshToken).toBe(b.body.refreshToken);
    });

    it('a suspended user cannot refresh (401) and the token stays dead after reactivation', async () => {
      const session = await e2e.login();
      await e2e.db.query(`UPDATE "user" SET status = 'SUSPENDED' WHERE id = $1`, [session.userId]);
      const res = await e2e.post('/auth/refresh', { refreshToken: session.refreshToken });
      expect(res.status).toBe(401);
      expect(res.body).toEqual(unauthorized('INVALID_REFRESH_TOKEN'));
      await e2e.db.query(`UPDATE "user" SET status = 'ACTIVE' WHERE id = $1`, [session.userId]);
      expect((await e2e.post('/auth/refresh', { refreshToken: session.refreshToken })).status).toBe(401);
    });

    it('missing / unknown refresh tokens: 400 for a missing field, 401 for an unknown token', async () => {
      const missing = await e2e.post('/auth/refresh', {});
      expect(missing.status).toBe(400);
      expect(missing.body).toEqual({ statusCode: 400, error: 'Bad Request', message: ['refreshToken should not be empty', 'refreshToken must be a string'] });
      expect((await e2e.post('/auth/refresh', { refreshToken: 'nope' })).status).toBe(401);
    });
  });

  it('POST /auth/logout → 204 with an empty body; the refresh token is dead afterwards', async () => {
    const session = await e2e.login();
    const res = await e2e.post('/auth/logout', { refreshToken: session.refreshToken });
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect((await e2e.post('/auth/refresh', { refreshToken: session.refreshToken })).status).toBe(401);
    // idempotent for unknown tokens
    expect((await e2e.post('/auth/logout', { refreshToken: 'unknown' })).status).toBe(204);
  });

  describe('bearer tokens', () => {
    it('an OAuth state JWT (same secret, p:"gstate") is not an access token → 401', async () => {
      const start = await e2e.get(`/auth/google?codeChallenge=${E2eApp.pkce().challenge}`);
      const state = new URL(String(start.headers.location)).searchParams.get('state')!;
      expect(claims(state)).toMatchObject({ p: 'gstate' });
      const res = await e2e.get('/auth/me', { token: state });
      expect(res.status).toBe(401);
      expect(res.body).toEqual(unauthorized('INVALID_ACCESS_TOKEN'));
    });

    it('a legacy typ-less access token (issued before the typ claim) is still accepted during the transition', async () => {
      const session = await e2e.login();
      const legacy = e2e.app.get(JwtService).sign({ sub: session.userId, adm: false });
      e2e.secrets.add(legacy);
      expect(claims(legacy).typ).toBeUndefined();
      const res = await e2e.get('/auth/me', { token: legacy });
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(session.userId);
    });

    it('missing, malformed and foreign-signed tokens → 401 with distinct codes', async () => {
      expect((await e2e.get('/auth/me')).body).toEqual(unauthorized('MISSING_BEARER_TOKEN'));
      expect((await e2e.get('/auth/me', { headers: { authorization: 'Basic abc' } })).body).toEqual(unauthorized('MISSING_BEARER_TOKEN'));
      const forged = new JwtService({ secret: 'another-secret-entirely-xxxxxxxxxxxxxxx' }).sign({ sub: 'x', typ: 'access' });
      expect((await e2e.get('/auth/me', { token: forged })).body).toEqual(unauthorized('INVALID_ACCESS_TOKEN'));
    });
  });
});
