import { authSuccessRedirectUrl, feRedirectAllowlist } from './fe-origins';

const configWith = (values: Record<string, string | undefined>) => ({ get: (key: string) => values[key] });

describe('authSuccessRedirectUrl / feRedirectAllowlist', () => {
  it('falls back to the local FE outside production', () => {
    expect(authSuccessRedirectUrl(configWith({}))).toBe('http://localhost:3000/');
    expect(feRedirectAllowlist(configWith({ NODE_ENV: 'development' })).allows('http://localhost:3000')).toBe(true);
  });

  it('never falls back to localhost in production (boot refuses an unset value - requireProductionAuthUrls)', () => {
    expect(authSuccessRedirectUrl(configWith({ NODE_ENV: 'production' }))).toBe('');
    expect(feRedirectAllowlist(configWith({ NODE_ENV: 'production' })).allows('http://localhost:3000')).toBe(false);
  });

  it('uses the configured value in every environment', () => {
    for (const NODE_ENV of ['production', 'development', undefined]) {
      expect(authSuccessRedirectUrl(configWith({ NODE_ENV, AUTH_SUCCESS_REDIRECT: 'https://fe.example.com/' }))).toBe('https://fe.example.com/');
    }
  });

  it('drops loopback AUTH_ALLOWED_REDIRECT_ORIGINS entries in production (CORS_ORIGINS does the same) but keeps them locally', () => {
    const AUTH_ALLOWED_REDIRECT_ORIGINS = 'http://localhost:3000, http://127.0.0.1:3001, https://fe-two.example.com';
    const prod = feRedirectAllowlist(configWith({ NODE_ENV: 'production', AUTH_SUCCESS_REDIRECT: 'https://fe.example.com/', AUTH_ALLOWED_REDIRECT_ORIGINS }));
    expect(prod.allows('http://localhost:3000')).toBe(false);
    expect(prod.allows('http://127.0.0.1:3001')).toBe(false);
    expect(prod.allows('https://fe-two.example.com')).toBe(true);
    expect(prod.allows('https://fe.example.com')).toBe(true);
    // the Turnstile hostname check shares this list - a localhost-hosted widget token must not pass in production either
    expect(prod.allowsHostname('localhost')).toBe(false);
    const dev = feRedirectAllowlist(configWith({ NODE_ENV: 'development', AUTH_ALLOWED_REDIRECT_ORIGINS }));
    expect(dev.allows('http://localhost:3000')).toBe(true);
    expect(dev.allows('http://127.0.0.1:3001')).toBe(true);
  });
});
