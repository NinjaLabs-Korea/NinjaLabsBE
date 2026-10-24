import { createHash } from 'crypto';
import { AuthTokenThrottlerGuard } from './auth-throttler.guard';

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

  it('/auth/exchange is keyed by the login-code hash, IP when the code is missing or not a string', async () => {
    expect(await tracker({ body: { code: 'c'.repeat(43) } }, 'exchange')).toBe(`code:${sha256('c'.repeat(43))}`);
    expect(await tracker({ body: { code: 42 } }, 'exchange')).toBe('ip:10.0.0.1');
    expect(await tracker({ body: undefined }, 'exchange')).toBe('ip:10.0.0.1');
  });
});
