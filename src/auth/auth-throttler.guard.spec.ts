import { createHash } from 'crypto';
import 'reflect-metadata';
import { AUTH_PROXIED_ROUTE_IP_THROTTLE, AuthTokenThrottlerGuard } from './auth-throttler.guard';
import { AuthController } from './auth.controller';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const ctx = (handler: string) => ({ getHandler: () => ({ name: handler }) }) as never;

describe('AuthTokenThrottlerGuard tracker', () => {
  const guard = new AuthTokenThrottlerGuard({} as never, {} as never, {} as never);
  const tracker = (req: Record<string, unknown>, handler: string) =>
    (guard as unknown as { getTracker(r: unknown, c: unknown): Promise<string> }).getTracker({ ip: '10.0.0.1', headers: {}, ...req }, ctx(handler));

  it('/auth/refresh is keyed by the sha256 of the body refresh token (never the raw token)', async () => {
    const key = await tracker({ body: { refreshToken: 'secret-token' } }, 'refresh');
    expect(key).toBe(`refresh:${sha256('secret-token')}`);
    expect(key).not.toContain('secret-token');
  });

  it('cookie mode keys by the ninja_rt cookie; without the header the cookie is ignored (falls back to IP)', async () => {
    const headers = { cookie: 'ninja_rt=cookie-token', 'x-ninja-session': 'cookie' };
    expect(await tracker({ headers, body: {} }, 'refresh')).toBe(`refresh:${sha256('cookie-token')}`);
    expect(await tracker({ headers: { cookie: 'ninja_rt=cookie-token' }, body: {} }, 'refresh')).toBe('ip:10.0.0.1');
  });

  it('two different tokens from one IP get different buckets', async () => {
    const a = await tracker({ body: { refreshToken: 'a' } }, 'refresh');
    const b = await tracker({ body: { refreshToken: 'b' } }, 'refresh');
    expect(a).not.toBe(b);
  });

  it('/auth/exchange is keyed by the login-code hash (the IP key is only the unreachable fallback - such requests are skipped)', async () => {
    expect(await tracker({ body: { code: 'c'.repeat(43) } }, 'exchange')).toBe(`code:${sha256('c'.repeat(43))}`);
    expect(await tracker({ body: { code: 42 } }, 'exchange')).toBe('ip:10.0.0.1');
    expect(await tracker({ body: undefined }, 'exchange')).toBe('ip:10.0.0.1');
  });

  it('/auth/logout is keyed like refresh: the body token, or the ninja_rt cookie in cookie mode (sha256, never raw)', async () => {
    expect(await tracker({ body: { refreshToken: 'secret-token' } }, 'logout')).toBe(`refresh:${sha256('secret-token')}`);
    const headers = { cookie: 'ninja_rt=cookie-token', 'x-ninja-session': 'cookie' };
    expect(await tracker({ headers, body: {} }, 'logout')).toBe(`refresh:${sha256('cookie-token')}`);
  });
});

describe('AuthTokenThrottlerGuard.shouldSkip', () => {
  const guard = new AuthTokenThrottlerGuard({} as never, {} as never, {} as never);
  const skip = (handler: string, req: Record<string, unknown>) =>
    (guard as unknown as { shouldSkip(c: unknown): Promise<boolean> }).shouldSkip({
      getHandler: () => ({ name: handler }),
      switchToHttp: () => ({ getRequest: () => ({ ip: '10.0.0.1', headers: {}, body: {}, ...req }) }),
    });

  it('skips the token-hash limit for any request that presents no credential (the IP bucket would be shared by every user behind one egress IP)', async () => {
    expect(await skip('logout', {})).toBe(true);
    expect(await skip('logout', { headers: { cookie: 'ninja_rt=t' } })).toBe(true); // cookie without the header is ignored
    expect(await skip('refresh', {})).toBe(true);
    expect(await skip('refresh', { body: { refreshToken: 42 } })).toBe(true);
    expect(await skip('exchange', {})).toBe(true);
    expect(await skip('exchange', { body: { code: 42 } })).toBe(true);
    expect(await skip('exchange', { body: undefined })).toBe(true);
  });

  it('keeps the limit for requests that do present a credential', async () => {
    expect(await skip('logout', { body: { refreshToken: 't' } })).toBe(false);
    expect(await skip('logout', { headers: { cookie: 'ninja_rt=t', 'x-ninja-session': 'cookie' } })).toBe(false);
    expect(await skip('refresh', { body: { refreshToken: 't' } })).toBe(false);
    expect(await skip('exchange', { body: { code: 'c'.repeat(43) } })).toBe(false);
  });
});

describe('proxied auth routes (Vercel rewrite /api/auth/*)', () => {
  it.each(['exchange', 'refresh', 'logout'] as const)('%s raises the per-IP limit to 600/min and adds the token-hash guard', (handler) => {
    const method = AuthController.prototype[handler] as object;
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', method)).toBe(AUTH_PROXIED_ROUTE_IP_THROTTLE.default.limit);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', method)).toBe(AUTH_PROXIED_ROUTE_IP_THROTTLE.default.ttl);
    expect(Reflect.getMetadata('__guards__', method)).toEqual([AuthTokenThrottlerGuard]);
  });
});
