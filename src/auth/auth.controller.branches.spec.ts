import { Logger, NotFoundException } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { GoogleIdTokenVerifier } from './google-id-token.verifier';
import { decryptGraceToken, encryptGraceToken } from './refresh-grace';

/** AuthController 분기 중 auth.controller.spec / login-code.spec / google-id-token.spec가 밟지 않는 것 */
const userId = '11111111-1111-4111-8111-111111111111';
const challenge = 'c'.repeat(43);

function logs() {
  const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  const events = (spy: jest.SpyInstance) => spy.mock.calls.map(([line]) => JSON.parse(String(line).replace('[onboarding] ', '')));
  return { log, error, logged: () => events(log), errored: () => events(error), warned: () => events(warn) };
}

afterEach(() => jest.restoreAllMocks());

describe('AuthController.googleCallback — rejected before touching Google', () => {
  function setup(config: Record<string, string> = { AUTH_SUCCESS_REDIRECT: 'https://app.example/' }) {
    const auth = { verifyOauthState: jest.fn(), exchangeGoogleCode: jest.fn(), upsertGoogleUser: jest.fn(), issueLoginCode: jest.fn() };
    const controller = new AuthController(auth as never, { get: (key: string) => config[key] } as never, { enabled: false } as never);
    const res = { redirect: jest.fn() };
    return { auth, controller, res };
  }

  it.each([
    ['a provider error (user denied consent)', 'code', 'state', 'access_denied'],
    ['a missing code', undefined, 'state', undefined],
    ['a missing state', 'code', undefined, undefined],
  ])('%s → #error=AUTH_FAILED on AUTH_SUCCESS_REDIRECT, state never verified', async (_label, code, state, providerError) => {
    const { log } = logs();
    const { auth, controller, res } = setup();
    await controller.googleCallback(code, state, providerError, { headers: {} } as never, res as never);
    expect(res.redirect).toHaveBeenCalledWith('https://app.example/auth/callback#error=AUTH_FAILED');
    expect(auth.verifyOauthState).not.toHaveBeenCalled();
    expect(auth.exchangeGoogleCode).not.toHaveBeenCalled();
    const rejected = log.mock.calls.map(([line]) => String(line)).find((line) => line.includes('oauth.callback.rejected'))!;
    expect(rejected).toContain(`"reason":"${providerError ?? 'MISSING_CODE_OR_STATE'}"`);
  });

  it('a database outage during the callback is #error=DATABASE_UNAVAILABLE (retryable copy), any other failure stays AUTH_FAILED', async () => {
    logs();
    const { auth, controller, res } = setup();
    auth.verifyOauthState.mockResolvedValue({ redirectUrl: 'https://app.example/', codeChallenge: challenge });
    auth.exchangeGoogleCode.mockResolvedValue({ googleId: 'g', email: 'e@example.com' });
    auth.upsertGoogleUser.mockRejectedValueOnce(new Error('Connection terminated due to connection timeout'));
    await controller.googleCallback('code', 'state', undefined, { headers: {} } as never, res as never);
    expect(res.redirect).toHaveBeenLastCalledWith('https://app.example/auth/callback#error=DATABASE_UNAVAILABLE');
    auth.upsertGoogleUser.mockRejectedValueOnce(new Error('something else'));
    await controller.googleCallback('code', 'state', undefined, { headers: {} } as never, res as never);
    expect(res.redirect).toHaveBeenLastCalledWith('https://app.example/auth/callback#error=AUTH_FAILED');
  });

  it('falls back to http://localhost:3000/ when AUTH_SUCCESS_REDIRECT is unset', async () => {
    logs();
    const { controller, res } = setup({});
    await controller.googleCallback(undefined, undefined, undefined, { headers: {} } as never, res as never);
    expect(res.redirect).toHaveBeenCalledWith('http://localhost:3000/auth/callback#error=AUTH_FAILED');
  });

  it('a state whose redirect is no longer allowlisted lands the login code on AUTH_SUCCESS_REDIRECT, not on the signed origin', async () => {
    logs();
    const { auth, controller, res } = setup();
    auth.verifyOauthState.mockResolvedValue({ redirectUrl: 'https://evil.example/', codeChallenge: challenge });
    auth.exchangeGoogleCode.mockResolvedValue({ googleId: 'g', email: 'e@example.com' });
    auth.upsertGoogleUser.mockResolvedValue({ id: userId, onboarding_step: 2, onboarding_completed_at: null });
    auth.issueLoginCode.mockResolvedValue('L'.repeat(43));
    await controller.googleCallback('code', 'state', undefined, { headers: {} } as never, res as never);
    expect(res.redirect).toHaveBeenCalledWith(`https://app.example/auth/callback#loginCode=${'L'.repeat(43)}`);
    expect(auth.issueLoginCode).toHaveBeenCalledWith(userId, challenge);
  });
});

describe('AuthController.googleRedirect', () => {
  it('builds the returnTo allowlist once — a rejected shared-hosting wildcard is reported once, not on every login', async () => {
    const { error } = logs();
    const auth = { issueOauthState: jest.fn(async () => 'state'), buildGoogleAuthUrl: jest.fn(() => 'https://accounts.google.com/') };
    const config: Record<string, string> = {
      AUTH_SUCCESS_REDIRECT: 'https://app.example/',
      AUTH_ALLOWED_REDIRECT_ORIGINS: 'https://ninjalabsfe-*-team.vercel.app',
    };
    const controller = new AuthController(auth as never, { get: (key: string) => config[key] } as never, { enabled: false } as never);
    for (let i = 0; i < 3; i++) {
      await controller.googleRedirect(undefined, 'https://app.example/', challenge, undefined, { ip: '1.2.3.4' } as never, { redirect: jest.fn() } as never);
    }
    expect(error.mock.calls.filter(([line]) => String(line).includes('REJECTED'))).toHaveLength(1);
  });

  it('an unparseable AUTH_SUCCESS_REDIRECT is still the fallback for any returnTo (the allowlist cannot be built)', async () => {
    logs();
    const auth = { issueOauthState: jest.fn(async () => 'state'), buildGoogleAuthUrl: jest.fn((state: string) => `https://accounts.google.com/?state=${state}`) };
    const controller = new AuthController(auth as never, { get: (key: string) => (key === 'AUTH_SUCCESS_REDIRECT' ? 'not a url' : undefined) } as never, { enabled: false } as never);
    const res = { redirect: jest.fn() };
    await controller.googleRedirect('trace-1', 'https://app.example/x', challenge, undefined, { ip: '1.2.3.4' } as never, res as never);
    expect(auth.issueOauthState).toHaveBeenCalledWith('trace-1', 'not a url', challenge);
    expect(res.redirect).toHaveBeenCalledWith('https://accounts.google.com/?state=state');
  });

  it('logs the requested/selected origins only (null for garbage), never the full returnTo, and passes an absent challenge as ""', async () => {
    const { logged } = logs();
    const auth = { issueOauthState: jest.fn(async () => 'state'), buildGoogleAuthUrl: jest.fn(() => 'https://accounts.google.com/') };
    const controller = new AuthController(auth as never, { get: (key: string) => (key === 'AUTH_SUCCESS_REDIRECT' ? 'https://app.example/' : undefined) } as never, { enabled: false } as never);
    await controller.googleRedirect(undefined, 'garbage?secret=1', undefined, undefined, { ip: '1.2.3.4' } as never, { redirect: jest.fn() } as never);
    expect(auth.issueOauthState).toHaveBeenCalledWith(undefined, 'https://app.example/', '');
    expect(logged()[0]).toEqual({ event: 'oauth.redirect.requested', requestedReturnOrigin: null, selectedReturnOrigin: 'https://app.example' });
  });
});

describe('AuthController.refresh / me', () => {
  it('body mode returns the rotated pair as-is and sets no cookie', async () => {
    logs();
    const auth = { refreshTtlSeconds: 60, refresh: jest.fn(async () => ({ accessToken: 'a', refreshToken: 'r2' })) };
    const controller = new AuthController(auth as never, { get: () => undefined } as never, { enabled: false } as never);
    const res = { append: jest.fn() };
    await expect(controller.refresh({ refreshToken: 'r1' }, { headers: { 'user-agent': 'ua' }, ip: '1.2.3.4' } as never, res as never))
      .resolves.toEqual({ accessToken: 'a', refreshToken: 'r2' });
    expect(auth.refresh).toHaveBeenCalledWith('r1', '1.2.3.4', 'ua');
    expect(res.append).not.toHaveBeenCalled();
  });

  it('a non-401 failure (e.g. the database is down) on a cookie token keeps the cookie — the session may still be alive', async () => {
    logs();
    const outage = new Error('connection terminated');
    const auth = { refreshTtlSeconds: 60, refresh: jest.fn(async () => { throw outage; }) };
    const controller = new AuthController(auth as never, { get: () => undefined } as never, { enabled: false } as never);
    const res = { append: jest.fn() };
    const req = { headers: { 'x-ninja-session': 'cookie', cookie: 'ninja_rt=live' } } as never;
    await expect(controller.refresh({}, req, res as never)).rejects.toBe(outage);
    expect(res.append).not.toHaveBeenCalled();
  });

  it('GET /auth/me returns the service payload and logs wallet/nft flags; a failure is logged with its code and rethrown', async () => {
    const { logged, errored, warned } = logs();
    const me = { onboardingStep: 3, onboardingCompleted: false, wallet: { address: 'inj1x' }, nft: { status: 'PENDING' } };
    const auth = { getMe: jest.fn(async () => me) };
    const controller = new AuthController(auth as never, { get: () => undefined } as never, { enabled: false } as never);
    const req = { headers: { 'x-onboarding-trace-id': 'trace-9' }, requestId: 'req-id-1234', user: { userId, isAdmin: false } } as never;
    await expect(controller.me(req)).resolves.toBe(me);
    expect(auth.getMe).toHaveBeenCalledWith(userId);
    expect(logged().find((line) => line.event === 'session.me.succeeded')).toEqual({
      event: 'session.me.succeeded', rid: 'req-id-1234', traceId: 'trace-9', userId, onboardingStep: 3, onboardingCompleted: false, walletLinked: true, nftStatus: 'PENDING',
    });

    auth.getMe.mockResolvedValueOnce({ ...me, wallet: null, nft: null } as never);
    await controller.me(req);
    expect(logged().filter((line) => line.event === 'session.me.succeeded').at(-1)).toMatchObject({ walletLinked: false, nftStatus: null });

    const gone = new NotFoundException('USER_NOT_FOUND');
    auth.getMe.mockRejectedValueOnce(gone);
    await expect(controller.me(req)).rejects.toBe(gone);
    // an expected 404 is a warn with the request id, not an error
    expect(warned().at(-1)).toEqual({ event: 'session.me.failed', rid: 'req-id-1234', traceId: 'trace-9', userId, errorCode: 'USER_NOT_FOUND' });
    expect(errored()).toEqual([]);
  });
});

describe('GoogleIdTokenVerifier.verify success path', () => {
  it('returns the ticket payload of a verified token, verifying against the given audience', async () => {
    const verifier = new GoogleIdTokenVerifier();
    const payload = { iss: 'https://accounts.google.com', aud: 'aud', sub: 's', email: 'e@x', email_verified: true };
    const verifyIdToken = jest.fn(async () => ({ getPayload: () => payload }));
    (verifier['client'] as unknown as { verifyIdToken: unknown }).verifyIdToken = verifyIdToken;
    await expect(verifier.verify('id.token', 'aud')).resolves.toBe(payload);
    expect(verifyIdToken).toHaveBeenCalledWith({ idToken: 'id.token', audience: 'aud' });
  });

  it('a non-Error throwable from the client is rethrown as-is (verification failure, not 503)', async () => {
    const verifier = new GoogleIdTokenVerifier();
    (verifier['client'] as unknown as { verifyIdToken: unknown }).verifyIdToken = jest.fn(async () => { throw 'boom'; });
    await expect(verifier.verify('t', 'aud')).rejects.toBe('boom');
  });
});

describe('refresh grace envelope — truncated copies', () => {
  const secret = 's'.repeat(32);
  const sessionId = '11111111-1111-4111-8111-111111111111';
  it('a copy missing its tag or ciphertext part (two or one segments) is "no grace" (null), never a throw', () => {
    const [iv, ciphertext] = encryptGraceToken(secret, sessionId, 'r'.repeat(64)).split('.');
    expect(decryptGraceToken(secret, sessionId, `${iv}.${ciphertext}`)).toBeNull();
    expect(decryptGraceToken(secret, sessionId, iv)).toBeNull();
    // a valid IV and tag around an empty ciphertext fails authentication too
    expect(decryptGraceToken(secret, sessionId, `${iv}..${Buffer.alloc(16).toString('base64url')}`)).toBeNull();
  });
});
