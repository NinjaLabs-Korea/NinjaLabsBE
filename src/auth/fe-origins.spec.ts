import { authSuccessRedirectUrl, feRedirectAllowlist } from './fe-origins';

const configWith = (values: Record<string, string | undefined>) => ({ get: (key: string) => values[key] });

describe('authSuccessRedirectUrl / feRedirectAllowlist', () => {
  it('falls back to the local FE outside production', () => {
    expect(authSuccessRedirectUrl(configWith({}))).toBe('http://localhost:3000/');
    expect(feRedirectAllowlist(configWith({ NODE_ENV: 'development' })).allows('http://localhost:3000')).toBe(true);
  });

  it('never falls back to localhost in production (boot refuses an unset value — requireProductionAuthUrls)', () => {
    expect(authSuccessRedirectUrl(configWith({ NODE_ENV: 'production' }))).toBe('');
    expect(feRedirectAllowlist(configWith({ NODE_ENV: 'production' })).allows('http://localhost:3000')).toBe(false);
  });

  it('uses the configured value in every environment', () => {
    for (const NODE_ENV of ['production', 'development', undefined]) {
      expect(authSuccessRedirectUrl(configWith({ NODE_ENV, AUTH_SUCCESS_REDIRECT: 'https://fe.example.com/' }))).toBe('https://fe.example.com/');
    }
  });
});
