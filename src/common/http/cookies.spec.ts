import { parseCookies, serializeCookie } from './cookies';

describe('parseCookies', () => {
  it('parses a Cookie header into name → value (trimmed, %-decoded, quotes stripped)', () => {
    expect(parseCookies('a=1; ninja_rt=abc_DEF-123;  theme = dark ; q="x%20y"')).toEqual({ a: '1', ninja_rt: 'abc_DEF-123', theme: 'dark', q: 'x y' });
  });
  it('keeps the first value of a duplicated name (the more specific Path is sent first)', () => {
    expect(parseCookies('ninja_rt=first; ninja_rt=second')).toEqual({ ninja_rt: 'first' });
  });
  it('tolerates junk: no header, segments without "=", empty names, malformed % escapes, arrays', () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('')).toEqual({});
    expect(parseCookies('novalue; =x; a=%E0%A4%A')).toEqual({ a: '%E0%A4%A' });
    expect(parseCookies(['a=1', 'b=2'])).toEqual({ a: '1', b: '2' });
  });
  it('does not let __proto__ pollute the result object', () => {
    const parsed = parseCookies('__proto__=x; a=1');
    expect(parsed.a).toBe('1');
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});

describe('serializeCookie', () => {
  it('writes attributes in the order HttpOnly; Secure; SameSite; Path; Max-Age', () => {
    expect(serializeCookie('ninja_rt', 'tok', { httpOnly: true, secure: true, sameSite: 'Strict', path: '/api/auth', maxAgeSeconds: 60 }))
      .toBe('ninja_rt=tok; HttpOnly; Secure; SameSite=Strict; Path=/api/auth; Max-Age=60');
    expect(serializeCookie('ninja_rt', '', { path: '/', maxAgeSeconds: 0 })).toBe('ninja_rt=; Path=/; Max-Age=0');
  });
  it.each(['a;b', 'a b', 'a,b', 'a"b', 'a\\b', 'a\nb'])('refuses a value that would break the header: %p', (value) => {
    expect(() => serializeCookie('n', value)).toThrow('invalid cookie value');
  });
  it('refuses a bad name or Max-Age', () => {
    expect(() => serializeCookie('a b', 'v')).toThrow('invalid cookie name');
    expect(() => serializeCookie('n', 'v', { maxAgeSeconds: -1 })).toThrow('Max-Age');
    expect(() => serializeCookie('n', 'v', { maxAgeSeconds: 1.5 })).toThrow('Max-Age');
  });
});
