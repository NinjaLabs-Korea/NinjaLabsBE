import { clearRefreshCookie, isCookieMode, presentedRefreshToken, readRefreshCookie, setRefreshCookie } from './session-cookie';

const req = (headers: Record<string, string> = {}, body?: unknown) => ({ headers, body }) as never;

describe('session cookie mode', () => {
  it.each([['cookie', true], ['Cookie', true], [' COOKIE ', true], ['body', false], ['', false], ['cookies', false]])(
    'X-Ninja-Session: %p → cookie mode %p', (value, expected) => {
      expect(isCookieMode(req({ 'x-ninja-session': value }))).toBe(expected);
    });
  it('no header → body mode', () => expect(isCookieMode(req())).toBe(false));

  it('reads ninja_rt from the Cookie header (other cookies ignored, empty → undefined)', () => {
    expect(readRefreshCookie(req({ cookie: 'theme=dark; ninja_rt=abc' }))).toBe('abc');
    expect(readRefreshCookie(req({ cookie: 'ninja_rt=' }))).toBeUndefined();
    expect(readRefreshCookie(req())).toBeUndefined();
  });

  it('sets and clears the cookie with HttpOnly; Secure; SameSite=Strict; Path=/api/auth and no Domain', () => {
    const res = { append: jest.fn() };
    setRefreshCookie(res as never, 'tok_EN-1', 1_209_600);
    clearRefreshCookie(res as never);
    expect(res.append.mock.calls).toEqual([
      ['Set-Cookie', 'ninja_rt=tok_EN-1; HttpOnly; Secure; SameSite=Strict; Path=/api/auth; Max-Age=1209600'],
      ['Set-Cookie', 'ninja_rt=; HttpOnly; Secure; SameSite=Strict; Path=/api/auth; Max-Age=0'],
    ]);
  });

  it('presentedRefreshToken: body mode uses only the body; cookie mode prefers the body token (migration) then the cookie', () => {
    const cookie = 'ninja_rt=from-cookie';
    expect(presentedRefreshToken(req({ cookie }, { refreshToken: 'from-body' }))).toBe('from-body');
    expect(presentedRefreshToken(req({ cookie }, {}))).toBeUndefined(); // header missing → cookie ignored
    expect(presentedRefreshToken(req({ cookie, 'x-ninja-session': 'cookie' }, {}))).toBe('from-cookie');
    expect(presentedRefreshToken(req({ cookie, 'x-ninja-session': 'cookie' }, undefined))).toBe('from-cookie');
    expect(presentedRefreshToken(req({ cookie, 'x-ninja-session': 'cookie' }, { refreshToken: 'from-body' }))).toBe('from-body');
    expect(presentedRefreshToken(req({ 'x-ninja-session': 'cookie' }, { refreshToken: 123 }))).toBeUndefined();
  });
});
