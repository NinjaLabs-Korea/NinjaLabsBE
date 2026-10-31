import { UnauthorizedException } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { normalizeRefreshTtl, refreshTtlSeconds } from './refresh-ttl';

const COOKIE = { 'x-ninja-session': 'cookie' };
const CLEARED = 'ninja_rt=; HttpOnly; Secure; SameSite=Strict; Path=/api/auth; Max-Age=0';
const issued = (token: string) => `ninja_rt=${token}; HttpOnly; Secure; SameSite=Strict; Path=/api/auth; Max-Age=1209600`;

/** what AuthService.sessionUserOf (= getMe for the access token's owner) answers in these tests */
const ME = { id: 'u1', nickname: 'ryan', onboardingStep: 4, onboardingCompleted: true };

function setup() {
  const auth = {
    refreshTtlSeconds: 1_209_600,
    sessionUserOf: jest.fn(async (_accessToken: string): Promise<unknown> => ME),
    exchangeLoginCode: jest.fn(async () => ({ accessToken: 'access', refreshToken: 'new-refresh' })),
    refresh: jest.fn(async () => ({ accessToken: 'access', refreshToken: 'rotated' })),
    revoke: jest.fn(async () => undefined),
  };
  const controller = new AuthController(auth as never, { get: () => undefined } as never, { enabled: false } as never);
  const res = { append: jest.fn() };
  const req = (headers: Record<string, string> = {}) => ({ headers, ip: '10.0.0.1' }) as never;
  const setCookies = () => res.append.mock.calls.filter(([name]) => name === 'Set-Cookie').map(([, value]) => value);
  return { auth, controller, res, req, setCookies };
}

describe('AuthController cookie mode (X-Ninja-Session: cookie)', () => {
  const login = { code: 'c'.repeat(43), codeVerifier: 'v'.repeat(43) };

  it('exchange: body mode returns both tokens and sets nothing; cookie mode moves the refresh token into ninja_rt', async () => {
    const body = setup();
    await expect(body.controller.exchange(login, body.req(), body.res as never)).resolves.toEqual({ accessToken: 'access', refreshToken: 'new-refresh' });
    expect(body.setCookies()).toEqual([]);
    expect(body.auth.sessionUserOf).not.toHaveBeenCalled(); // body mode (deprecated) is unchanged: no user

    const cookie = setup();
    await expect(cookie.controller.exchange(login, cookie.req(COOKIE), cookie.res as never)).resolves.toEqual({ accessToken: 'access', user: ME });
    expect(cookie.auth.sessionUserOf).toHaveBeenCalledWith('access');
    expect(cookie.setCookies()).toEqual([issued('new-refresh')]);
  });

  it('refresh: cookie mode reads ninja_rt, rotates and re-sets it; body mode ignores the cookie', async () => {
    const s = setup();
    await expect(s.controller.refresh({}, s.req({ ...COOKIE, cookie: 'ninja_rt=old' }), s.res as never)).resolves.toEqual({ accessToken: 'access', user: ME });
    expect(s.auth.refresh).toHaveBeenCalledWith('old', '10.0.0.1', undefined);
    expect(s.auth.sessionUserOf).toHaveBeenCalledWith('access');
    expect(s.setCookies()).toEqual([issued('rotated')]);

    const b = setup();
    await expect(b.controller.refresh({}, b.req({ cookie: 'ninja_rt=old' }), b.res as never)).rejects.toMatchObject({
      status: 400, response: { message: ['refreshToken should not be empty', 'refreshToken must be a string'] },
    });
    expect(b.auth.refresh).not.toHaveBeenCalled();
  });

  it('refresh/exchange: a failed user lookup after the rotation drops only `user`, still 200, the rotated cookie is still set (FE falls back to /auth/me)', async () => {
    const s = setup();
    s.auth.sessionUserOf.mockRejectedValue(new Error('connection terminated'));
    await expect(s.controller.refresh({}, s.req({ ...COOKIE, cookie: 'ninja_rt=old' }), s.res as never)).resolves.toEqual({ accessToken: 'access' });
    expect(s.setCookies()).toEqual([issued('rotated')]);

    const e = setup();
    e.auth.sessionUserOf.mockRejectedValue(new Error('USER_NOT_FOUND'));
    await expect(e.controller.exchange(login, e.req(COOKIE), e.res as never)).resolves.toEqual({ accessToken: 'access' });
    expect(e.setCookies()).toEqual([issued('new-refresh')]);
  });

  it('refresh: a rejected rotation never looks the user up', async () => {
    const s = setup();
    s.auth.refresh.mockRejectedValue(new UnauthorizedException('INVALID_REFRESH_TOKEN'));
    await expect(s.controller.refresh({}, s.req({ ...COOKIE, cookie: 'ninja_rt=dead' }), s.res as never)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(s.auth.sessionUserOf).not.toHaveBeenCalled();
  });

  it('refresh: a body token with the header (legacy migration) wins over the cookie and is moved into the cookie', async () => {
    const s = setup();
    await s.controller.refresh({ refreshToken: 'legacy' }, s.req({ ...COOKIE, cookie: 'ninja_rt=stale' }), s.res as never);
    expect(s.auth.refresh).toHaveBeenCalledWith('legacy', '10.0.0.1', undefined);
    expect(s.setCookies()).toEqual([issued('rotated')]);
  });

  it('refresh: cookie mode without a cookie → 401 INVALID_REFRESH_TOKEN, nothing set', async () => {
    const s = setup();
    await expect(s.controller.refresh({}, s.req(COOKIE), s.res as never)).rejects.toMatchObject({ status: 401, message: 'INVALID_REFRESH_TOKEN' });
    expect(s.auth.refresh).not.toHaveBeenCalled();
    expect(s.setCookies()).toEqual([]);
  });

  it('refresh: a 401 for a cookie token clears the cookie; a 401 for a migrated body token leaves the cookie alone', async () => {
    const s = setup();
    s.auth.refresh.mockRejectedValue(new UnauthorizedException('INVALID_REFRESH_TOKEN'));
    await expect(s.controller.refresh({}, s.req({ ...COOKIE, cookie: 'ninja_rt=dead' }), s.res as never)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(s.setCookies()).toEqual([CLEARED]);

    const m = setup();
    m.auth.refresh.mockRejectedValue(new UnauthorizedException('INVALID_REFRESH_TOKEN'));
    await expect(m.controller.refresh({ refreshToken: 'legacy' }, m.req({ ...COOKIE, cookie: 'ninja_rt=live' }), m.res as never)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(m.setCookies()).toEqual([]);
  });

  it('logout: cookie mode revokes every presented token (cookie + body) and clears the cookie; body mode needs the body token', async () => {
    const s = setup();
    await s.controller.logout({ refreshToken: 'legacy' }, s.req({ ...COOKIE, cookie: 'ninja_rt=current' }), s.res as never);
    expect(s.auth.revoke.mock.calls).toEqual([['legacy'], ['current']]);
    expect(s.setCookies()).toEqual([CLEARED]);

    const empty = setup();
    await empty.controller.logout({}, empty.req(COOKIE), empty.res as never);
    expect(empty.auth.revoke).not.toHaveBeenCalled();
    expect(empty.setCookies()).toEqual([CLEARED]);

    const body = setup();
    await expect(body.controller.logout({}, body.req({ cookie: 'ninja_rt=current' }), body.res as never)).rejects.toMatchObject({ status: 400 });
    await body.controller.logout({ refreshToken: 'tok' }, body.req({ cookie: 'ninja_rt=current' }), body.res as never);
    expect(body.auth.revoke.mock.calls).toEqual([['tok']]);
    expect(body.setCookies()).toEqual([]);
  });
});

describe('refreshTtlSeconds (cookie Max-Age)', () => {
  it.each([['14d', 1_209_600], ['15m', 900], ['2 weeks', 1_209_600], ['12h', 43_200], ['60s', 60]])('%s → %i s', (raw, seconds) => {
    expect(refreshTtlSeconds(normalizeRefreshTtl(raw))).toBe(seconds);
  });
  it('rejects a value that is not normalized', () => {
    expect(() => refreshTtlSeconds('14d')).toThrow('not a normalized refresh TTL');
  });
});
