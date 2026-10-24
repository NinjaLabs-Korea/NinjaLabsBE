import { Logger } from '@nestjs/common';
import {
  corsOriginsValue,
  requireGoogleClientSecret,
  requireJwtSecret,
  requireProductionAuthUrls,
  trustProxyHops,
} from './bootstrap-checks';

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

  describe('corsOriginsValue', () => {
    it('falls back to the local FE only outside production (an explicit empty value stays empty)', () => {
      expect(corsOriginsValue({})).toBe('http://localhost:3000');
      expect(corsOriginsValue({ NODE_ENV: 'development', CORS_ORIGINS: 'http://localhost:3000,http://127.0.0.1:3001' })).toBe('http://localhost:3000,http://127.0.0.1:3001');
      expect(corsOriginsValue({ NODE_ENV: 'test', CORS_ORIGINS: '' })).toBe('');
      expect(error).not.toHaveBeenCalled();
    });

    it('passes production origins through untouched when none is loopback', () => {
      expect(corsOriginsValue({ NODE_ENV: 'production', CORS_ORIGINS: 'https://ninjalabsfe.vercel.app, https://preview.ninjalabs.xyz' }))
        .toBe('https://ninjalabsfe.vercel.app,https://preview.ninjalabs.xyz');
      expect(error).not.toHaveBeenCalled();
    });

    it.each([undefined, '', '  ', ' , '])('refuses to start in production when CORS_ORIGINS is %p (no silent localhost fallback)', (value) => {
      expect(() => corsOriginsValue({ NODE_ENV: 'production', CORS_ORIGINS: value })).toThrow(/CORS_ORIGINS must be set in production/);
    });

    it('drops loopback entries in production with an error log instead of crash-looping (old main railway.ts listed http://localhost:3000)', () => {
      expect(corsOriginsValue({ NODE_ENV: 'production', CORS_ORIGINS: 'https://ninjalabsfe.vercel.app,http://localhost:3000,http://127.0.0.1:3001,http://app.localhost' }))
        .toBe('https://ninjalabsfe.vercel.app');
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('"http://localhost:3000", "http://127.0.0.1:3001", "http://app.localhost" — IGNORED in production'));
    });

    it('refuses to start in production when every entry is loopback', () => {
      expect(() => corsOriginsValue({ NODE_ENV: 'production', CORS_ORIGINS: 'http://localhost:3000,http://[::1]:3000' })).toThrow(/lists only loopback origins/);
    });
  });

  describe('requireProductionAuthUrls', () => {
    const prod = {
      NODE_ENV: 'production',
      GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com',
      GOOGLE_CALLBACK_URL: 'https://api.ninjalabs.xyz/auth/google/callback',
      AUTH_SUCCESS_REDIRECT: 'https://ninjalabs.xyz/',
    };

    it('is a no-op outside production (local defaults stay usable) and accepts complete production values', () => {
      expect(() => requireProductionAuthUrls({})).not.toThrow();
      expect(() => requireProductionAuthUrls({ NODE_ENV: 'development', AUTH_SUCCESS_REDIRECT: 'http://localhost:3000/' })).not.toThrow();
      expect(() => requireProductionAuthUrls(prod)).not.toThrow();
    });

    it.each(['GOOGLE_CLIENT_ID', 'GOOGLE_CALLBACK_URL', 'AUTH_SUCCESS_REDIRECT'])('refuses to start in production when %s is unset or blank', (key) => {
      expect(() => requireProductionAuthUrls({ ...prod, [key]: undefined })).toThrow(new RegExp(`FATAL: ${key} must be set in production`));
      expect(() => requireProductionAuthUrls({ ...prod, [key]: '  ' })).toThrow(new RegExp(`FATAL: ${key} must be set in production`));
    });

    it('names every missing key at once', () => {
      expect(() => requireProductionAuthUrls({ NODE_ENV: 'production' })).toThrow('FATAL: GOOGLE_CLIENT_ID, GOOGLE_CALLBACK_URL, AUTH_SUCCESS_REDIRECT must be set in production');
    });

    it.each([
      ['AUTH_SUCCESS_REDIRECT', 'http://localhost:3000/'],
      ['AUTH_SUCCESS_REDIRECT', 'http://127.0.0.1:3000/'],
      ['AUTH_SUCCESS_REDIRECT', 'ninjalabs.xyz'],
      ['AUTH_SUCCESS_REDIRECT', 'javascript:alert(1)'],
      ['GOOGLE_CALLBACK_URL', 'http://localhost:4000/auth/google/callback'],
      ['GOOGLE_CALLBACK_URL', 'http://[::1]:4000/auth/google/callback'],
    ])('refuses to start in production when %s=%p (not a public http(s) URL)', (key, value) => {
      expect(() => requireProductionAuthUrls({ ...prod, [key]: value })).toThrow(new RegExp(`FATAL: ${key}=.*must be a public http\\(s\\) URL in production`));
    });
  });
});
