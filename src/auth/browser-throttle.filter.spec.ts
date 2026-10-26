import { ArgumentsHost } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { BrowserNavigationThrottleFilter } from './browser-throttle.filter';

const configWith = (values: Record<string, string | undefined>) => ({ get: (key: string) => values[key] }) as never;

function run(config: Record<string, string | undefined>, query: Record<string, unknown>) {
  const res = { setHeader: jest.fn(), redirect: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
  const host = { switchToHttp: () => ({ getRequest: () => ({ query }), getResponse: () => res }) } as unknown as ArgumentsHost;
  new BrowserNavigationThrottleFilter(configWith(config)).catch(new ThrottlerException(), host);
  return res;
}

describe('BrowserNavigationThrottleFilter', () => {
  const env = { AUTH_SUCCESS_REDIRECT: 'https://fe.example.com/', AUTH_ALLOWED_REDIRECT_ORIGINS: 'https://preview.example.com' };

  it('redirects a throttled start to the FE callback with TOO_MANY_REQUESTS instead of a JSON 429', () => {
    const res = run(env, {});
    expect(res.redirect).toHaveBeenCalledWith('https://fe.example.com/auth/callback#error=TOO_MANY_REQUESTS');
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '60');
    expect(res.json).not.toHaveBeenCalled();
  });

  it('returns to the FE origin that started the login when returnTo is allowed, and ignores a foreign returnTo', () => {
    expect(run(env, { returnTo: 'https://preview.example.com/x' }).redirect).toHaveBeenCalledWith('https://preview.example.com/auth/callback#error=TOO_MANY_REQUESTS');
    expect(run(env, { returnTo: 'https://evil.example.net/' }).redirect).toHaveBeenCalledWith('https://fe.example.com/auth/callback#error=TOO_MANY_REQUESTS');
    expect(run(env, { returnTo: ['https://preview.example.com'] }).redirect).toHaveBeenCalledWith('https://fe.example.com/auth/callback#error=TOO_MANY_REQUESTS');
  });

  it('falls back to the JSON 429 when no FE URL can be built', () => {
    const res = run({ NODE_ENV: 'production' }, {});
    expect(res.redirect).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
  });
});
