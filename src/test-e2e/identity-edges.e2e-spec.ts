import { createHash } from 'crypto';
import { Wallet } from 'ethers';
import { GoogleVerifierUnavailableError } from '../auth/google-id-token.verifier';
import { describeDb } from '../test-db/describe-db';
import { getInjectiveAddress } from './support/injective-sdk.stub';
import { E2eApp, FE_ORIGIN, randomIp, startApp } from './support/harness';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const unauthorized = (message: string) => ({ statusCode: 401, error: 'Unauthorized', message });
const badRequest = (message: string | string[]) => ({ statusCode: 400, error: 'Bad Request', message });
const fragment = (location: string) => new URL(location).hash;

// HTTP-visible branches of auth / users / wallets that auth.e2e-spec and onboarding.e2e-spec do not drive
describeDb('identity edge cases over HTTP (e2e)', () => {
  let e2e: E2eApp;
  beforeAll(async () => { e2e = await startApp(); });
  afterAll(async () => e2e?.close());

  /** Google → callback → login code (not yet exchanged) */
  async function loginCode(identity: { sub: string; email: string }, ip = randomIp()) {
    const { verifier, challenge } = E2eApp.pkce();
    const { location } = await e2e.oauthCallback(identity, { challenge, ip });
    const code = new URLSearchParams(new URL(location).hash.slice(1)).get('loginCode');
    if (code) { e2e.secrets.add(code); e2e.secrets.add(verifier); }
    return { code, verifier, ip, location };
  }

  describe('OAuth callback and login-code exchange', () => {
    it('a callback with a state but no code, or a code but no state, lands on #error=AUTH_FAILED without calling Google', async () => {
      const start = await e2e.get(`/auth/google?codeChallenge=${E2eApp.pkce().challenge}`);
      const state = new URL(String(start.headers.location)).searchParams.get('state')!;
      const before = e2e.google.tokenRequests.length;
      for (const query of [`state=${encodeURIComponent(state)}`, 'code=4%2Fsome-code']) {
        const res = await e2e.get(`/auth/google/callback?${query}`);
        expect(res.status).toBe(302);
        expect(String(res.headers.location)).toBe(`${FE_ORIGIN}/auth/callback#error=AUTH_FAILED`);
      }
      expect(e2e.google.tokenRequests.length).toBe(before);
    });

    it('a second Google account with the email of an active user → #error=AUTH_FAILED (409 ACCOUNT_CONFLICT inside), no second user row', async () => {
      const email = `shared-${Date.now()}@example.test`;
      const first = await loginCode({ sub: `g-first-${Date.now()}`, email });
      expect(first.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const second = await loginCode({ sub: `g-second-${Date.now()}`, email });
      expect(second.code).toBeNull();
      expect(fragment(second.location)).toBe('#error=AUTH_FAILED');
      const rows = await e2e.db.query(`SELECT 1 FROM "user" WHERE email = $1`, [email]);
      expect(rows.rowCount).toBe(1);
      const failure = e2e.linesFor('AuthController').find((line) => line.includes('oauth.callback.failed') && line.includes('ACCOUNT_CONFLICT'));
      expect(failure).toBeDefined();
    });

    it('Google JWKS unreachable while verifying the id_token → #error=AUTH_FAILED, logged as GOOGLE_UNAVAILABLE (not a token problem)', async () => {
      const verify = jest.spyOn(e2e.google.verifier, 'verify')
        .mockRejectedValueOnce(new GoogleVerifierUnavailableError('Failed to retrieve verification certificates: ECONNRESET'));
      try {
        const { code, location } = await loginCode({ sub: `g-jwks-${Date.now()}`, email: `jwks-${Date.now()}@example.test` });
        expect(code).toBeNull();
        expect(fragment(location)).toBe('#error=AUTH_FAILED');
      } finally {
        verify.mockRestore();
      }
      expect(e2e.linesFor('AuthService').some((line) => line.includes('Google id_token verification unavailable') && line.includes('ECONNRESET'))).toBe(true);
      expect(e2e.linesFor('AuthController').some((line) => line.includes('oauth.callback.failed') && line.includes('GOOGLE_UNAVAILABLE'))).toBe(true);
    });

    it('a returning Google account resolves to the same user and keeps its onboarding progress; an admin row gets adm=true', async () => {
      const sub = `g-return-${Date.now()}`;
      const first = await e2e.login({ sub });
      await e2e.post('/users/me/profile', { nickname: `Ret${Date.now().toString(36)}`, bio: 'b', tags: ['DEV'] }, { token: first.accessToken });
      const again = await e2e.login({ sub });
      expect(again.userId).toBe(first.userId);
      const me = await e2e.get('/auth/me', { token: again.accessToken });
      expect(me.body).toMatchObject({ onboardingStep: 4, isAdmin: false });

      const admin = await e2e.loginAdmin();
      const adminClaims = JSON.parse(Buffer.from(admin.accessToken.split('.')[1], 'base64url').toString('utf8'));
      expect(adminClaims).toMatchObject({ adm: true, typ: 'access', sub: admin.userId });
      expect((await e2e.get('/auth/me', { token: admin.accessToken })).body.isAdmin).toBe(true);
    });

    it('exchange: a malformed body is 400 from the DTO; an expired code and a suspended user\'s code are 401 INVALID_LOGIN_CODE', async () => {
      const malformed = await e2e.post('/auth/exchange', { code: 'short', codeVerifier: 'v'.repeat(43) });
      expect(malformed.status).toBe(400);
      expect(malformed.body).toEqual(badRequest(['code must match /^[A-Za-z0-9_-]{43}$/ regular expression']));
      expect((await e2e.post('/auth/exchange', {})).body.message).toEqual(expect.arrayContaining([expect.stringMatching(/^code must match/), expect.stringMatching(/^codeVerifier must match/)]));

      const expired = await loginCode({ sub: `g-exp-${Date.now()}`, email: `exp-${Date.now()}@example.test` });
      await e2e.db.query(`UPDATE oauth_login_code SET expires_at = now() - interval '1 second' WHERE code_hash = $1`, [sha256(expired.code!)]);
      const late = await e2e.post('/auth/exchange', { code: expired.code, codeVerifier: expired.verifier }, { ip: expired.ip });
      expect(late.status).toBe(401);
      expect(late.body).toEqual(unauthorized('INVALID_LOGIN_CODE'));

      const sub = `g-susp-${Date.now()}`;
      const pending = await loginCode({ sub, email: `${sub}@example.test` });
      await e2e.db.query(`UPDATE "user" SET status = 'SUSPENDED' WHERE google_id = $1`, [sub]);
      const blocked = await e2e.post('/auth/exchange', { code: pending.code, codeVerifier: pending.verifier }, { ip: pending.ip });
      expect(blocked.body).toEqual(unauthorized('INVALID_LOGIN_CODE'));
      const sessions = await e2e.db.query(`SELECT 1 FROM auth_session s JOIN "user" u ON u.id = s.user_id WHERE u.google_id = $1`, [sub]);
      expect(sessions.rowCount).toBe(0);
    });
  });

  describe('refresh / logout', () => {
    it('a refresh token whose session expired is 401 and issues no successor', async () => {
      const session = await e2e.login();
      await e2e.db.query(`UPDATE auth_session SET expires_at = now() - interval '1 second' WHERE refresh_token_hash = $1`, [sha256(session.refreshToken)]);
      const res = await e2e.post('/auth/refresh', { refreshToken: session.refreshToken });
      expect(res.status).toBe(401);
      expect(res.body).toEqual(unauthorized('INVALID_REFRESH_TOKEN'));
      const successors = await e2e.db.query(`SELECT 1 FROM auth_session WHERE prev_refresh_token_hash = $1`, [sha256(session.refreshToken)]);
      expect(successors.rowCount).toBe(0);
    });

    it('cookie-mode logout with a legacy body token AND a cookie revokes both sessions', async () => {
      const legacy = await e2e.login();
      const current = await e2e.login();
      const out = await e2e.post('/auth/logout', { refreshToken: legacy.refreshToken }, {
        headers: { 'x-ninja-session': 'cookie', cookie: `ninja_rt=${current.refreshToken}` },
      });
      expect(out.status).toBe(204);
      const open = await e2e.db.query<{ hash: string }>(
        `SELECT refresh_token_hash AS hash FROM auth_session WHERE refresh_token_hash = ANY($1::varchar[]) AND revoked_at IS NULL`,
        [[sha256(legacy.refreshToken), sha256(current.refreshToken)]]);
      expect(open.rows).toEqual([]);
    });
  });

  describe('wallets', () => {
    it('GET /wallets/me before any wallet is linked → 200 with an empty body (null)', async () => {
      const session = await e2e.login();
      const res = await e2e.get('/wallets/me', { token: session.accessToken });
      expect(res.status).toBe(200);
      expect(res.text).toBe('');
      expect((await e2e.get('/wallets/me')).status).toBe(401);
    });

    it('ADR-36 (inj1…): no publicKey → 401 INVALID_SIGNATURE; an undecodable publicKey → 401 INVALID_SIGNATURE (never a 500); the challenge stays open', async () => {
      const session = await e2e.login();
      const inj = getInjectiveAddress(Wallet.createRandom().address);
      const challenge = await e2e.post('/wallets/challenge', { address: inj }, { token: session.accessToken });
      expect(challenge.status).toBe(201);
      expect(challenge.body.message).toContain(`주소: ${inj}`);

      const noKey = await e2e.post('/wallets/verify', { address: inj, signature: Buffer.alloc(64).toString('base64') }, { token: session.accessToken });
      expect(noKey.status).toBe(401);
      expect(noKey.body).toEqual(unauthorized('INVALID_SIGNATURE'));
      const garbageKey = await e2e.post('/wallets/verify', { address: inj, signature: 'c2ln', publicKey: 'not-a-key' }, { token: session.accessToken });
      expect(garbageKey.status).toBe(401);
      expect(garbageKey.body).toEqual(unauthorized('INVALID_SIGNATURE'));

      const open = await e2e.db.query(`SELECT 1 FROM wallet_verification_challenge WHERE id = $1 AND used_at IS NULL`, [challenge.body.id]);
      expect(open.rowCount).toBe(1);
      expect((await e2e.get('/wallets/me', { token: session.accessToken })).text).toBe('');
      expect(e2e.linesFor('WalletsController').some((line) => line.includes('wallet.verify.requested') && line.includes('"signatureType":"ADR36"'))).toBe(true);
    });

    it('an expired challenge is 400 CHALLENGE_EXPIRED; re-issuing replaces the old challenge, whose signature no longer verifies', async () => {
      const session = await e2e.login();
      const signer = Wallet.createRandom();
      const first = await e2e.post('/wallets/challenge', { address: signer.address }, { token: session.accessToken });
      await e2e.db.query(`UPDATE wallet_verification_challenge SET expires_at = now() - interval '1 second' WHERE id = $1`, [first.body.id]);
      const late = await e2e.post('/wallets/verify', { address: signer.address, signature: await signer.signMessage(first.body.message) }, { token: session.accessToken });
      expect(late.status).toBe(400);
      expect(late.body).toEqual(badRequest('CHALLENGE_EXPIRED'));

      const a = await e2e.post('/wallets/challenge', { address: signer.address }, { token: session.accessToken });
      const b = await e2e.post('/wallets/challenge', { address: signer.address }, { token: session.accessToken });
      expect(b.body.nonce).not.toBe(a.body.nonce);
      const stale = await e2e.post('/wallets/verify', { address: signer.address, signature: await signer.signMessage(a.body.message) }, { token: session.accessToken });
      expect(stale.body).toEqual(unauthorized('INVALID_SIGNATURE'));
      const ok = await e2e.post('/wallets/verify', { address: signer.address, signature: await signer.signMessage(b.body.message) }, { token: session.accessToken });
      expect(ok.status).toBe(201);
    });

    it('the stored public key is the one recovered from the EIP-191 signature, not the publicKey field of the request', async () => {
      const session = await e2e.login();
      const signer = Wallet.createRandom();
      const challenge = await e2e.post('/wallets/challenge', { address: signer.address }, { token: session.accessToken });
      const res = await e2e.post('/wallets/verify', {
        address: signer.address, signature: await signer.signMessage(challenge.body.message), publicKey: `0x02${'ab'.repeat(32)}`,
      }, { token: session.accessToken });
      expect(res.status).toBe(201);
      expect(res.body).not.toHaveProperty('public_key'); // not exposed
      const row = await e2e.db.query<{ public_key: string }>(`SELECT public_key FROM wallet WHERE user_id = $1`, [session.userId]);
      expect(row.rows).toEqual([{ public_key: signer.signingKey.compressedPublicKey }]);
    });
  });

  describe('users', () => {
    it('complete-onboarding is idempotent (the first completion time is kept) and requires a session', async () => {
      const session = await e2e.login();
      expect((await e2e.post('/users/me/complete-onboarding', undefined)).status).toBe(401);
      // before the profile is saved the flag cannot be set (placeholder nickname would be published as "onboarded")
      const early = await e2e.post('/users/me/complete-onboarding', undefined, { token: session.accessToken });
      expect(early.status).toBe(409);
      expect(early.body.message).toBe('PROFILE_REQUIRED');
      await e2e.post('/users/me/profile', { nickname: `Idem_${Date.now().toString(36)}`, bio: 'b', tags: ['DEV'] }, { token: session.accessToken });
      await e2e.post('/users/me/complete-onboarding', undefined, { token: session.accessToken });
      const first = (await e2e.db.query<{ at: Date }>(`SELECT onboarding_completed_at AS at FROM "user" WHERE id = $1`, [session.userId])).rows[0].at;
      await new Promise((resolve) => setTimeout(resolve, 20));
      const again = await e2e.post('/users/me/complete-onboarding', undefined, { token: session.accessToken });
      expect(again.status).toBe(201);
      expect(again.body).toEqual({ ok: true });
      const second = (await e2e.db.query<{ at: Date }>(`SELECT onboarding_completed_at AS at FROM "user" WHERE id = $1`, [session.userId])).rows[0].at;
      expect(second.getTime()).toBe(first.getTime());
    });

    it('profile save requires a session, and a nickname freed by a deleted account is available and savable again', async () => {
      expect((await e2e.post('/users/me/profile', { nickname: 'whoever', bio: 'b', tags: ['DEV'] })).status).toBe(401);
      const holder = await e2e.login();
      const nickname = `Freed${Date.now().toString(36)}`;
      await e2e.post('/users/me/profile', { nickname, bio: 'b', tags: ['DEV'] }, { token: holder.accessToken });
      expect((await e2e.get(`/users/check-nickname?nickname=${nickname}`)).body).toEqual({ available: false });
      await e2e.db.query(`UPDATE "user" SET deleted_at = now() WHERE id = $1`, [holder.userId]);
      expect((await e2e.get(`/users/check-nickname?nickname=${nickname}`)).body).toEqual({ available: true });
      expect((await e2e.get(`/users/${nickname}`)).status).toBe(404);
      const next = await e2e.login();
      expect((await e2e.post('/users/me/profile', { nickname, bio: 'b', tags: ['DEV'] }, { token: next.accessToken })).status).toBe(201);
      // saved but not finished: the public profile stays closed until onboarding is completed
      expect((await e2e.get(`/users/${nickname}`)).status).toBe(404);
      await e2e.db.query(`UPDATE "user" SET onboarding_step = 4, onboarding_completed_at = now() WHERE id = $1`, [next.userId]);
      expect((await e2e.get(`/users/${nickname}`)).body.id).toBe(next.userId);
    });
  });
});
