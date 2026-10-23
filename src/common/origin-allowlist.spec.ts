import { Logger } from '@nestjs/common';
import { isSharedHostingWildcard, OriginAllowlist, SHARED_HOSTING_SUFFIXES } from './origin-allowlist';

describe('OriginAllowlist', () => {
  // Wildcards are only honoured on domains the team controls; shared hosting previews use exact branch aliases.
  const allowlist = OriginAllowlist.fromEnv(
    ' https://ninjalabs.xyz , https://ninjalabsfe-*-team.preview.ninjalabs.xyz,http://localhost:3000, https://ninjalabsfe-git-develop-team.vercel.app ',
  );

  it('matches exact entries and trims whitespace around commas', () => {
    expect(allowlist.allows('https://ninjalabs.xyz')).toBe(true);
    expect(allowlist.allows('http://localhost:3000')).toBe(true);
    expect(allowlist.allows('https://ninjalabs.xyz:443')).toBe(true);
    expect(allowlist.allows('https://other.xyz')).toBe(false);
  });

  it('matches a single * wildcard inside one host label on a private domain', () => {
    expect(allowlist.allows('https://ninjalabsfe-abc123-team.preview.ninjalabs.xyz')).toBe(true);
    expect(allowlist.allows('https://ninjalabsfe--team.preview.ninjalabs.xyz')).toBe(true);
    expect(allowlist.allows('https://ninjalabsfe-team.preview.ninjalabs.xyz')).toBe(false);
    expect(allowlist.allows('https://ninjalabsfe-abc123-evil.preview.ninjalabs.xyz')).toBe(false);
  });

  it('matches the Vercel branch alias only exactly', () => {
    expect(allowlist.allows('https://ninjalabsfe-git-develop-team.vercel.app')).toBe(true);
    expect(allowlist.allows('https://ninjalabsfe-abc123-team.vercel.app')).toBe(false);
    expect(allowlist.allows('https://ninjalabsfe-git-develop-team.vercel.app.evil.com')).toBe(false);
  });

  it('anchors the wildcard to the full host and never crosses a dot', () => {
    expect(allowlist.allows('https://ninjalabsfe-a-team.preview.ninjalabs.xyz.evil.com')).toBe(false);
    expect(allowlist.allows('https://evil.ninjalabsfe-a-team.preview.ninjalabs.xyz')).toBe(false);
    expect(allowlist.allows('https://ninjalabsfe-a.b-team.preview.ninjalabs.xyz')).toBe(false);
    expect(allowlist.allows('https://evil.com/?x=https://ninjalabsfe-a-team.preview.ninjalabs.xyz')).toBe(false);
    expect(allowlist.allows('https://evil.com#https://ninjalabsfe-a-team.preview.ninjalabs.xyz')).toBe(false);
  });

  it('requires the same scheme and port', () => {
    expect(allowlist.allows('http://ninjalabsfe-a-team.preview.ninjalabs.xyz')).toBe(false);
    expect(allowlist.allows('https://ninjalabsfe-a-team.preview.ninjalabs.xyz:8443')).toBe(false);
    expect(allowlist.allows('https://localhost:3000')).toBe(false);
    expect(allowlist.allows('http://localhost:3001')).toBe(false);
  });

  it('rejects empty, malformed and credentialed origins', () => {
    expect(allowlist.allows(undefined)).toBe(false);
    expect(allowlist.allows('')).toBe(false);
    expect(allowlist.allows('not a url')).toBe(false);
    expect(allowlist.allows('https://user@ninjalabs.xyz')).toBe(false);
  });

  it('ignores entries with more than one wildcard or no literal host part', () => {
    const loose = OriginAllowlist.fromEnv('https://*-*.example.com,https://*,https://*.example.com');
    expect(loose.size).toBe(1);
    expect(loose.allows('https://anything.example.com')).toBe(true);
    expect(loose.allows('https://anything.example.org')).toBe(false);
  });

  it('tolerates a trailing path on an entry (AUTH_SUCCESS_REDIRECT style)', () => {
    const list = new OriginAllowlist(['https://app.example/']);
    expect(list.allows('https://app.example')).toBe(true);
  });

  describe('shared hosting wildcard rejection', () => {
    let error: jest.SpyInstance;
    let warn: jest.SpyInstance;
    beforeEach(() => {
      error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => jest.restoreAllMocks());

    it('rejects (logs error, never matches) every wildcard entry whose registrable domain is a shared hosting suffix, wherever * sits', () => {
      const list = OriginAllowlist.fromEnv(
        'https://ninjalabsfe-*-team.vercel.app, https://ninjalabsfe-*.vercel.app, https://preview-*.netlify.app, https://*.vercel.app, https://ninjalabs.xyz',
      );
      expect(error).toHaveBeenCalledTimes(4);
      expect(warn).not.toHaveBeenCalled();
      expect(error.mock.calls[0][0]).toContain('"https://ninjalabsfe-*-team.vercel.app"');
      expect(error.mock.calls[0][0]).toContain('REJECTED');
      expect(error.mock.calls[0][0]).toContain('https://ninjalabsfe-git-develop-<team>.vercel.app');
      expect(error.mock.calls[0][0]).toContain('custom preview domain');
      expect(error.mock.calls[2][0]).toContain('"https://preview-*.netlify.app"');
      expect(error.mock.calls[3][0]).toContain('"https://*.vercel.app"');
      // Only the exact entry survives — the open patterns are dropped from the list entirely.
      expect(list.size).toBe(1);
      // The "team-scoped" pattern is exactly what an attacker project named ninjalabsfe-evil-team would match.
      expect(list.allows('https://ninjalabsfe-evil-team.vercel.app')).toBe(false);
      expect(list.allows('https://ninjalabsfe-abc123-team.vercel.app')).toBe(false);
      expect(list.allows('https://ninjalabsfe-evil.vercel.app')).toBe(false);
      expect(list.allows('https://preview-x.netlify.app')).toBe(false);
      expect(list.allows('https://ninjalabs.xyz')).toBe(true);
    });

    it.each([
      'https://app-*.pages.dev', 'https://docs-*.github.io', 'https://api-*.railway.app', 'https://x-*.herokuapp.com',
      'https://x-*.onrender.com', 'https://x-*.fly.dev', 'https://x-*.web.app', 'https://x-*.firebaseapp.com',
      'https://*-team.pages.dev', 'https://a-*-b.vercel.app', 'https://*.ninjalabs.vercel.app',
    ])('rejects %s (every shared hosting suffix, any wildcard position)', (entry) => {
      const list = OriginAllowlist.fromEnv(entry);
      expect(list.size).toBe(0);
      expect(error).toHaveBeenCalledTimes(1);
    });

    it.each([
      'https://ninjalabsfe-*-team.VERCEL.APP', 'https://ninjalabsfe-*-team.vercel.app.', 'https://ninjalabsfe-*-team.vercel.app:443',
      'https://ninjalabsfe-*-team.Vercel.App.:8443',
    ])('matches the suffix case-insensitively, ignoring a trailing dot and the port: %s', (entry) => {
      const list = OriginAllowlist.fromEnv(entry);
      expect(list.size).toBe(0);
      expect(error).toHaveBeenCalledTimes(1);
    });

    it('still accepts exact shared-hosting origins (branch aliases) and wildcards on private domains', () => {
      const list = OriginAllowlist.fromEnv(
        'https://ninjalabsfe-git-develop-team.vercel.app,https://ninjalabsfe.vercel.app,https://preview-*.ninjalabs.xyz,https://ninjalabs.xyz',
      );
      expect(error).not.toHaveBeenCalled();
      expect(list.size).toBe(4);
      expect(list.allows('https://ninjalabsfe-git-develop-team.vercel.app')).toBe(true);
      expect(list.allows('https://ninjalabsfe.vercel.app')).toBe(true);
      expect(list.allows('https://ninjalabsfe-abc123-team.vercel.app')).toBe(false);
      expect(list.allows('https://preview-42.ninjalabs.xyz')).toBe(true);
    });

    it('isSharedHostingWildcard covers every listed suffix and only wildcard hosts', () => {
      for (const suffix of SHARED_HOSTING_SUFFIXES) {
        expect(isSharedHostingWildcard(`app-*-team.${suffix}`)).toBe(true);
        expect(isSharedHostingWildcard(`app-team.${suffix}`)).toBe(false);
      }
      expect(isSharedHostingWildcard('preview-*.ninjalabs.xyz')).toBe(false);
      expect(isSharedHostingWildcard('*.vercel.app.evil.com')).toBe(false);
    });
  });
});
