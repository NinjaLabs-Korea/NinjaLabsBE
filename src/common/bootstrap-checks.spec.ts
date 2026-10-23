import { Logger } from '@nestjs/common';
import { requireGoogleClientSecret, requireJwtSecret, trustProxyHops } from './bootstrap-checks';

describe('bootstrap environment checks', () => {
  const strongSecret = 's'.repeat(32);
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('trustProxyHops', () => {
    it('defaults to 0 (no trust) outside production and accepts explicit hop counts', () => {
      expect(trustProxyHops({})).toBe(0);
      expect(trustProxyHops({ TRUST_PROXY: '0' })).toBe(0);
      expect(trustProxyHops({ TRUST_PROXY: '2' })).toBe(2);
      expect(trustProxyHops({ NODE_ENV: 'production', TRUST_PROXY: '1' })).toBe(1);
      expect(trustProxyHops({ NODE_ENV: 'production', TRUST_PROXY: ' 2 ' })).toBe(2);
      expect(warn).not.toHaveBeenCalled();
    });

    it.each([undefined, '', '   '])('defaults to 1 hop with a warning in production when TRUST_PROXY is %p (Railway is always behind one proxy)', (value) => {
      expect(trustProxyHops({ NODE_ENV: 'production', TRUST_PROXY: value })).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('TRUST_PROXY is not set — assuming 1 reverse-proxy hop in production'));
    });

    it.each(['0', 'abc', '-1', '1.5'])('still refuses to start in production when TRUST_PROXY is explicitly %p', (value) => {
      expect(() => trustProxyHops({ NODE_ENV: 'production', TRUST_PROXY: value })).toThrow(/must be an integer >= 1 in production/);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('requireJwtSecret', () => {
    it('falls back to the dev secret outside production when unset or the placeholder', () => {
      expect(requireJwtSecret({})).toBe('dev-only-secret');
      expect(requireJwtSecret({ JWT_SECRET: 'change-me-long-random-string' })).toBe('dev-only-secret');
      expect(requireJwtSecret({ JWT_SECRET: 'short' })).toBe('short');
      expect(error).not.toHaveBeenCalled();
    });

    it('accepts a 32+ byte secret in production without logging', () => {
      expect(requireJwtSecret({ NODE_ENV: 'production', JWT_SECRET: strongSecret })).toBe(strongSecret);
      expect(error).not.toHaveBeenCalled();
    });

    it.each([
      ['unset', undefined],
      ['the .env.example placeholder', 'change-me-long-random-string'],
      ['empty', ''],
    ])('refuses to start in production when JWT_SECRET is %s', (_label, value) => {
      expect(() => requireJwtSecret({ NODE_ENV: 'production', JWT_SECRET: value })).toThrow(/JWT_SECRET must be set to a random value in production/);
    });

    it('boots in production with a secret shorter than 32 bytes but logs an error asking for rotation', () => {
      const weak = 's'.repeat(31);
      expect(requireJwtSecret({ NODE_ENV: 'production', JWT_SECRET: weak })).toBe(weak);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('JWT_SECRET is only 31 bytes — production requires at least 32 random bytes'));
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
