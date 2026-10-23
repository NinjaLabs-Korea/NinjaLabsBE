import { requireGoogleClientSecret, requireJwtSecret, trustProxyHops } from './bootstrap-checks';

describe('bootstrap environment checks', () => {
  const strongSecret = 's'.repeat(32);

  describe('trustProxyHops', () => {
    it('defaults to 0 (no trust) outside production and accepts explicit hop counts', () => {
      expect(trustProxyHops({})).toBe(0);
      expect(trustProxyHops({ TRUST_PROXY: '0' })).toBe(0);
      expect(trustProxyHops({ TRUST_PROXY: '2' })).toBe(2);
      expect(trustProxyHops({ NODE_ENV: 'production', TRUST_PROXY: '1' })).toBe(1);
    });

    it.each([undefined, '0', '', 'abc', '-1', '1.5'])('refuses to start in production when TRUST_PROXY is %p', (value) => {
      expect(() => trustProxyHops({ NODE_ENV: 'production', TRUST_PROXY: value })).toThrow(/TRUST_PROXY must be an integer >= 1 in production/);
    });
  });

  describe('requireJwtSecret', () => {
    it('falls back to the dev secret outside production when unset or the placeholder', () => {
      expect(requireJwtSecret({})).toBe('dev-only-secret');
      expect(requireJwtSecret({ JWT_SECRET: 'change-me-long-random-string' })).toBe('dev-only-secret');
      expect(requireJwtSecret({ JWT_SECRET: 'short' })).toBe('short');
    });

    it('accepts a 32+ byte secret in production', () => {
      expect(requireJwtSecret({ NODE_ENV: 'production', JWT_SECRET: strongSecret })).toBe(strongSecret);
    });

    it.each([
      ['unset', undefined],
      ['the .env.example placeholder', 'change-me-long-random-string'],
      ['31 bytes', 's'.repeat(31)],
      ['empty', ''],
    ])('refuses to start in production when JWT_SECRET is %s', (_label, value) => {
      expect(() => requireJwtSecret({ NODE_ENV: 'production', JWT_SECRET: value })).toThrow(/JWT_SECRET must be set/);
    });
  });

  describe('requireGoogleClientSecret', () => {
    it('is a no-op outside production and when the secret is present', () => {
      expect(() => requireGoogleClientSecret({})).not.toThrow();
      expect(() => requireGoogleClientSecret({ NODE_ENV: 'production', GOOGLE_CLIENT_SECRET: 'x' })).not.toThrow();
    });

    it.each([undefined, '', '   '])('refuses to start in production when GOOGLE_CLIENT_SECRET is %p', (value) => {
      expect(() => requireGoogleClientSecret({ NODE_ENV: 'production', GOOGLE_CLIENT_SECRET: value })).toThrow(/GOOGLE_CLIENT_SECRET must be set in production/);
    });
  });
});
