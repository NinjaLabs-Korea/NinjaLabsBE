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

  it('GET /auth/google without codeChallenge → 302 back to the FE callback with #error=AUTH_FAILED (a browser navigation never lands on raw JSON; no Google redirect)', async () => {
    const res = await e2e.get(`/auth/google?returnTo=${encodeURIComponent(FE_ORIGIN)}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${FE_ORIGIN}/auth/callback#error=AUTH_FAILED`);
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

  describe('refresh token in an HttpOnly cookie (X-Ninja-Session: cookie)', () => {
    const COOKIE_MODE = { 'x-ninja-session': 'cookie' };
    const TTL_SECONDS = 14 * 86_400; // JWT_REFRESH_TTL=14d in the e2e env
    const COOKIE_RE = /^ninja_rt=([A-Za-z0-9_-]{64}); HttpOnly; Secure; SameSite=Strict; Path=\/api\/auth; Max-Age=(\d+)$/;
    const CLEARED = 'ninja_rt=; HttpOnly; Secure; SameSite=Strict; Path=/api/auth; Max-Age=0';

    function setCookies(res: { headers: Record<string, unknown> }): string[] {
      const raw = res.headers['set-cookie'];
      return Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
    }
    /** the single ninja_rt Set-Cookie, checked attribute-for-attribute; returns the token */
    function issuedCookie(res: { headers: Record<string, unknown> }): string {
      const cookies = setCookies(res);
      expect(cookies).toHaveLength(1);
      const match = COOKIE_RE.exec(cookies[0]);
      expect(match).not.toBeNull();
      expect(Number(match![2])).toBe(TTL_SECONDS);
      expect(cookies[0]).not.toMatch(/Domain=/i);
      e2e.secrets.add(match![1]);
      return match![1];
    }
    const withCookie = (token: string, ip?: string) => ({ ip, headers: { ...COOKIE_MODE, cookie: `theme=dark; ninja_rt=${token}` } });

    /** Google → login code → POST /auth/exchange in cookie mode */
    async function cookieLogin(ip = randomIp()) {
      const sub = `g-cookie-${Math.random().toString(36).slice(2)}`;
      const { verifier, challenge } = E2eApp.pkce();
      const { location } = await e2e.oauthCallback({ sub, email: `${sub}@example.test` }, { challenge, ip });
      const code = new URLSearchParams(new URL(location).hash.slice(1)).get('loginCode')!;
      e2e.secrets.add(code); e2e.secrets.add(verifier);
      const res = await e2e.post('/auth/exchange', { code, codeVerifier: verifier }, { ip, headers: COOKIE_MODE });
      e2e.trackTokens(res.body);
      return { res, ip };
    }
    const openSessions = async (hash: string) =>
      (await e2e.db.query<{ revoked: boolean }>(`SELECT revoked_at IS NOT NULL AS revoked FROM auth_session WHERE refresh_token_hash = $1`, [hash])).rows;

    it('exchange sets ninja_rt with the exact attributes (HttpOnly; Secure; SameSite=Strict; Path=/api/auth; Max-Age=<refresh TTL>, no Domain) and the body has no refreshToken', async () => {
      const { res } = await cookieLogin();
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store, private');
      expect(Object.keys(res.body)).toEqual(['accessToken']);
      expect(claims(res.body.accessToken)).toMatchObject({ typ: 'access' });
      const token = issuedCookie(res);
      expect(await openSessions(sha256(token))).toEqual([{ revoked: false }]);
      expect((await e2e.get('/auth/me', { token: res.body.accessToken })).status).toBe(200);
    });

    it('refresh reads the cookie (body {} or no body at all), rotates, re-sets the cookie and returns only the access token', async () => {
      const { res, ip } = await cookieLogin();
      const first = issuedCookie(res);
      const rotated = await e2e.post('/auth/refresh', {}, withCookie(first, ip));
      expect(rotated.status).toBe(200);
      expect(rotated.headers['cache-control']).toBe('no-store, private');
      expect(Object.keys(rotated.body)).toEqual(['accessToken']);
      e2e.trackTokens(rotated.body);
      const second = issuedCookie(rotated);
      expect(second).not.toBe(first);
      expect(await openSessions(sha256(first))).toEqual([{ revoked: true }]);
      expect(await openSessions(sha256(second))).toEqual([{ revoked: false }]);

      const noBody = await e2e.request('POST', '/auth/refresh', withCookie(second, ip));
      expect(noBody.status).toBe(200);
      e2e.trackTokens(noBody.body);
      expect(issuedCookie(noBody)).not.toBe(second);
    });

    it('grace reuse works in cookie mode: the old cookie within 30 s gets the winner\'s cookie (no second rotation)', async () => {
      const { res, ip } = await cookieLogin();
      const old = issuedCookie(res);
      const winner = await e2e.post('/auth/refresh', {}, withCookie(old, ip));
      e2e.trackTokens(winner.body);
      const successor = issuedCookie(winner);
      const graced = await e2e.post('/auth/refresh', {}, withCookie(old, ip)); // a second tab still holding the old cookie
      expect(graced.status).toBe(200);
      e2e.trackTokens(graced.body);
      expect(Object.keys(graced.body)).toEqual(['accessToken']);
      expect(issuedCookie(graced)).toBe(successor);
      const open = await e2e.db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM auth_session WHERE user_id = (SELECT user_id FROM auth_session WHERE refresh_token_hash = $1) AND revoked_at IS NULL`, [sha256(successor)]);
      expect(open.rows[0].n).toBe(1);
    });

    it('without the header the cookie is ignored (CSRF): body mode as before — 400 for an empty body, a body token answers in the body with no Set-Cookie', async () => {
      const { res, ip } = await cookieLogin();
      const token = issuedCookie(res);
      const noHeader = await e2e.post('/auth/refresh', {}, { ip, headers: { cookie: `ninja_rt=${token}` } });
      expect(noHeader.status).toBe(400);
      expect(noHeader.body).toEqual({ statusCode: 400, error: 'Bad Request', message: ['refreshToken should not be empty', 'refreshToken must be a string'] });
      expect(setCookies(noHeader)).toEqual([]);
      const otherValue = await e2e.post('/auth/refresh', {}, { ip, headers: { 'x-ninja-session': 'body', cookie: `ninja_rt=${token}` } });
      expect(otherValue.status).toBe(400);
      expect(await openSessions(sha256(token))).toEqual([{ revoked: false }]); // the cookie was never used

      const legacy = await e2e.login();
      const bodyMode = await e2e.post('/auth/refresh', { refreshToken: legacy.refreshToken }, { headers: { cookie: `ninja_rt=${token}` } });
      expect(bodyMode.status).toBe(200);
      e2e.trackTokens(bodyMode.body);
      expect(Object.keys(bodyMode.body).sort()).toEqual(['accessToken', 'refreshToken']);
      expect(setCookies(bodyMode)).toEqual([]);
      // logout without the header still needs the body token and leaves the cookie alone
      expect((await e2e.post('/auth/logout', {}, { headers: { cookie: `ninja_rt=${token}` } })).status).toBe(400);
      expect(await openSessions(sha256(token))).toEqual([{ revoked: false }]);
    });

    it('logout revokes the cookie\'s session and clears it (Max-Age=0, same Path/attributes); 204', async () => {
      const { res, ip } = await cookieLogin();
      const token = issuedCookie(res);
      const out = await e2e.post('/auth/logout', {}, withCookie(token, ip));
      expect(out.status).toBe(204);
      expect(out.text).toBe('');
      expect(setCookies(out)).toEqual([CLEARED]);
      expect(await openSessions(sha256(token))).toEqual([{ revoked: true }]);
      // no cookie at all: still 204 and cleared
      const bare = await e2e.post('/auth/logout', {}, { headers: COOKIE_MODE });
      expect(bare.status).toBe(204);
      expect(setCookies(bare)).toEqual([CLEARED]);
    });

    it('legacy localStorage token migration: header + body refreshToken uses the body token and sets the cookie', async () => {
      const legacy = await e2e.login(); // body-mode session as an old tab has it
      const migrated = await e2e.post('/auth/refresh', { refreshToken: legacy.refreshToken }, { headers: { ...COOKIE_MODE, cookie: 'ninja_rt=stale-cookie-value' } });
      expect(migrated.status).toBe(200);
      expect(Object.keys(migrated.body)).toEqual(['accessToken']);
      e2e.trackTokens(migrated.body);
      const cookie = issuedCookie(migrated);
      expect(await openSessions(sha256(legacy.refreshToken))).toEqual([{ revoked: true }]);
      // from now on the cookie alone refreshes
      const next = await e2e.post('/auth/refresh', {}, withCookie(cookie));
      expect(next.status).toBe(200);
      e2e.trackTokens(next.body);
      issuedCookie(next);
    });

    it('CSRF: a cross-origin page cannot send X-Ninja-Session — the preflight from a non-allowlisted origin gets no ACAO (the FE origin does)', async () => {
      const preflight = (origin: string) => e2e.request('OPTIONS', '/auth/refresh', {
        headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-ninja-session' },
      });
      const evil = await preflight('https://evil.example');
      expect(evil.headers['access-control-allow-origin']).toBeUndefined();
      const fe = await preflight(FE_ORIGIN);
      expect(fe.headers['access-control-allow-origin']).toBe(FE_ORIGIN);
      expect(String(fe.headers['access-control-allow-headers'])).toMatch(/x-ninja-session/i);
    });

    it('cookie mode without a cookie is 401 INVALID_REFRESH_TOKEN (nothing set); a dead cookie is 401 and gets cleared', async () => {
      const none = await e2e.post('/auth/refresh', {}, { headers: COOKIE_MODE });
      expect(none.status).toBe(401);
      expect(none.body).toEqual(unauthorized('INVALID_REFRESH_TOKEN'));
      expect(setCookies(none)).toEqual([]);

      const dead = await e2e.post('/auth/refresh', {}, withCookie('never-issued-token'));
      expect(dead.status).toBe(401);
      expect(dead.body).toEqual(unauthorized('INVALID_REFRESH_TOKEN'));
      expect(setCookies(dead)).toEqual([CLEARED]);
    });
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

    it('a legacy typ-less access token is accepted only if issued before this process started (LEGACY_ACCESS_TOKEN_CUTOFF default)', async () => {
      const session = await e2e.login();
      const jwt = e2e.app.get(JwtService);
      const legacy = jwt.sign({ sub: session.userId, adm: false, iat: Math.floor(performance.timeOrigin / 1000) - 60 });
      const forgedLater = jwt.sign({ sub: session.userId, adm: true });
      e2e.secrets.add(legacy); e2e.secrets.add(forgedLater);
      expect(claims(legacy).typ).toBeUndefined();
      const res = await e2e.get('/auth/me', { token: legacy });
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(session.userId);
      expect((await e2e.get('/auth/me', { token: forgedLater })).body).toEqual(unauthorized('INVALID_ACCESS_TOKEN'));
    });

    it('a still-valid access token of a suspended or deleted user → 401 INVALID_ACCESS_TOKEN once the 30 s status cache lapses (was accepted until expiry)', async () => {
      const suspended = await e2e.login(); // login() itself calls /auth/me → the ACTIVE status is now cached
      const deleted = await e2e.login();
      const active = await e2e.login();
      await e2e.db.query(`UPDATE "user" SET status = 'SUSPENDED' WHERE id = $1`, [suspended.userId]);
      await e2e.db.query(`UPDATE "user" SET deleted_at = now() WHERE id = $1`, [deleted.userId]);
      // documented window: up to 30 s per process
      expect((await e2e.get('/auth/me', { token: suspended.accessToken })).status).toBe(200);

      const realNow = Date.now();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(realNow + 31_000);
      try {
        expect((await e2e.get('/auth/me', { token: suspended.accessToken })).body).toEqual(unauthorized('INVALID_ACCESS_TOKEN'));
        expect((await e2e.post('/users/me/profile', { nickname: 'suspendedx', bio: 'b', tags: ['DEV'] }, { token: suspended.accessToken })).status).toBe(401);
        expect((await e2e.get('/auth/me', { token: deleted.accessToken })).body).toEqual(unauthorized('INVALID_ACCESS_TOKEN'));
        expect((await e2e.get('/auth/me', { token: active.accessToken })).status).toBe(200);
      } finally {
        clock.mockRestore();
      }
    });

    it('missing, malformed and foreign-signed tokens → 401 with distinct codes', async () => {
      expect((await e2e.get('/auth/me')).body).toEqual(unauthorized('MISSING_BEARER_TOKEN'));
      expect((await e2e.get('/auth/me', { headers: { authorization: 'Basic abc' } })).body).toEqual(unauthorized('MISSING_BEARER_TOKEN'));
      const forged = new JwtService({ secret: 'another-secret-entirely-xxxxxxxxxxxxxxx' }).sign({ sub: 'x', typ: 'access' });
      expect((await e2e.get('/auth/me', { token: forged })).body).toEqual(unauthorized('INVALID_ACCESS_TOKEN'));
    });
  });
});
