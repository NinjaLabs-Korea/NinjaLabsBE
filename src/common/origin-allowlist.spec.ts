import { readFileSync } from 'fs';
import { join } from 'path';
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

    it('.env.example lists every rejected shared hosting suffix', () => {
      const example = readFileSync(join(__dirname, '..', '..', '.env.example'), 'utf8');
      const listed = /# 대상 접미사: (.*)\./.exec(example)?.[1].split(' ') ?? [];
      expect([...SHARED_HOSTING_SUFFIXES].sort()).toEqual([...listed].sort());
    });

    it.each([
      'https://app-*.pages.dev', 'https://docs-*.github.io', 'https://api-*.railway.app', 'https://x-*.herokuapp.com',
      'https://x-*.onrender.com', 'https://x-*.fly.dev', 'https://x-*.web.app', 'https://x-*.firebaseapp.com',
      'https://*-team.pages.dev', 'https://a-*-b.vercel.app', 'https://*.ninjalabs.vercel.app',
      'https://x-*.workers.dev', 'https://x-*.ngrok-free.app', 'https://x-*.amplifyapp.com', 'https://x-*.azurewebsites.net', 'https://x-*.now.sh',
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

describe('OriginAllowlist — adversarial origins', () => {
  const list = OriginAllowlist.fromEnv('https://ninjalabs.xyz,https://preview-*.ninjalabs.xyz,http://localhost:3000');

  it.each([
    ['null', false], // sandboxed iframes / file:// send the literal string "null"
    ['https://NINJALABS.XYZ', true], // hosts are case-insensitive
    ['HTTPS://ninjalabs.xyz', true],
    ['https://ninjalabs.xyz:443', true],
    ['https://ninjalabs.xyz:444', false],
    ['https://ninjalabs.xyz.', false], // trailing-dot FQDN is a different origin string
    ['https://ninjalabs.xyz.evil.com', false],
    ['https://evilninjalabs.xyz', false],
    ['https://ninjalabs.xyz@evil.com', false],
    ['https://evil.com#@ninjalabs.xyz', false],
    ['https://evil.com?.ninjalabs.xyz', false],
    ['https://ninjalabs.xyz%2eevil.com', false], // percent-decoded host is ninjalabs.xyz.evil.com
    ['https://ninjalabs%2exyz', true], // …and this one decodes to exactly ninjalabs.xyz (same host per WHATWG)
    ['wss://ninjalabs.xyz', false],
    ['http://ninjalabs.xyz', false],
    ['http://localhost:3000', true],
    ['http://127.0.0.1:3000', false], // not the same origin as localhost
    ['http://localhost', false],
    ['https://preview-.ninjalabs.xyz', true], // the * may be empty
    ['https://preview-a1-b2.ninjalabs.xyz', true],
    ['https://preview-a.b.ninjalabs.xyz', false], // * never crosses a dot
    ['https://preview-a_b.ninjalabs.xyz', false], // underscore is outside the label alphabet
    ['https://x.preview-a.ninjalabs.xyz', false],
    ['https://preview-a.ninjalabs.xyz:8443', false],
    ['http://preview-a.ninjalabs.xyz', false],
    ['https://preview-a.ninjalabs.xyz.evil.com', false],
    ['https://[::1]', false],
    [' https://ninjalabs.xyz ', true], // URL trims surrounding spaces; a real Origin header never has them
  ])('%p → %p', (origin, allowed) => {
    expect(list.allows(origin)).toBe(allowed);
  });

  it.each([null, undefined, ''])('%p → false', (origin) => {
    expect(list.allows(origin)).toBe(false);
  });
});

describe('OriginAllowlist — entry parsing', () => {
  let error: jest.SpyInstance;
  beforeEach(() => { error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined); });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['*', 0], // bare wildcard: not an origin
    ['ninjalabs.xyz', 0], // scheme required
    ['https://', 0],
    ['https://user@ninjalabs.xyz', 0], // userinfo in an entry is malformed
    ['https://a+b-*.example.com', 0], // regex metacharacters never reach the pattern
    ['https://(.*)-*.example.com', 0],
    ['https://*.*', 0],
    ['https://*-*.example.com', 0],
    ['https://*.', 0], // no literal host part
    ['https://*.vercel.app.', 0], // trailing dot does not dodge the shared-hosting rule
    ['https://*.VERCEL.APP', 0],
    ['HTTPS://PREVIEW-*.NINJALABS.XYZ', 1],
    [',,, ,', 0],
  ])('%p yields %p usable entries', (entry, size) => {
    expect(OriginAllowlist.fromEnv(entry).size).toBe(size);
  });

  it('an out-of-range port in an entry is kept exact and never matches a real origin', () => {
    const list = OriginAllowlist.fromEnv('https://ninjalabs.xyz:99999');
    expect(list.allows('https://ninjalabs.xyz')).toBe(false);
    expect(list.allows('https://ninjalabs.xyz:99999')).toBe(false); // URL rejects the port
  });

  it('an uppercase wildcard entry matches lowercase browser origins', () => {
    const list = OriginAllowlist.fromEnv('HTTPS://PREVIEW-*.NINJALABS.XYZ');
    expect(list.allows('https://preview-7.ninjalabs.xyz')).toBe(true);
  });

  it('an entry with an explicit non-default port only matches that port', () => {
    const list = OriginAllowlist.fromEnv('https://preview-*.ninjalabs.xyz:8443,http://localhost:80');
    expect(list.allows('https://preview-a.ninjalabs.xyz:8443')).toBe(true);
    expect(list.allows('https://preview-a.ninjalabs.xyz')).toBe(false);
    expect(list.allows('http://localhost')).toBe(true); // :80 is http's default
  });

  it('a non-http scheme entry has no default port and matches only the same scheme', () => {
    const list = OriginAllowlist.fromEnv('chrome-extension://abcdef');
    expect(list.allows('chrome-extension://abcdef')).toBe(true);
    expect(list.allows('https://abcdef')).toBe(false);
  });

  it('fromEnv(undefined / null) is an empty list that allows nothing', () => {
    for (const value of [undefined, null]) {
      const list = OriginAllowlist.fromEnv(value);
      expect(list.size).toBe(0);
      expect(list.allows('https://ninjalabs.xyz')).toBe(false);
    }
    expect(error).not.toHaveBeenCalled();
  });
});

describe('OriginAllowlist.allowsHostname (Turnstile siteverify hostname — no scheme/port)', () => {
  const list = new OriginAllowlist([
    'https://ninjalabsfe.vercel.app',
    'http://localhost:3000',
    'https://preview-*.ninjalabs.xyz',
  ]);

  it.each(['ninjalabsfe.vercel.app', 'localhost', 'preview-1.ninjalabs.xyz', 'NINJALABSFE.vercel.app', 'ninjalabsfe.vercel.app.'])(
    'allows %p', (host) => expect(list.allowsHostname(host)).toBe(true),
  );

  it.each([
    'evil.example', 'ninjalabsfe.vercel.app.evil.example', 'xninjalabsfe.vercel.app', 'a.preview-1.ninjalabs.xyz',
    'ninjalabsfe-evil-team.vercel.app', 'localhost:3000', 'https://ninjalabsfe.vercel.app', '', '  ', undefined, null,
  ])('rejects %p', (host) => expect(list.allowsHostname(host as string | undefined)).toBe(false));
});
