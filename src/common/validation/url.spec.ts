import { isHttpUrl, isMediaPath, isSitePath } from './url';

describe('URL field validators', () => {
  const mediaPath = '/media/11111111-1111-4111-8111-111111111111';

  it('isHttpUrl accepts http(s) URLs with a protocol, including localhost previews', () => {
    expect(isHttpUrl('https://ninjalabs.xyz/bounties/1')).toBe(true);
    expect(isHttpUrl('http://localhost:3000/media/x')).toBe(true);
    expect(isHttpUrl('https://github.com/org/repo?tab=readme#top')).toBe(true);
  });

  it.each([
    'ninjalabs.xyz', 'ftp://ninjalabs.xyz', 'javascript:alert(1)', 'data:text/html,hi', '//ninjalabs.xyz',
    mediaPath, '', '   ', 'https://', `https://x.y/${'a'.repeat(2048)}`, 42, null, undefined,
  ])('isHttpUrl rejects %p', (value) => {
    expect(isHttpUrl(value)).toBe(false);
  });

  it.each([
    'https:ninjalabs.xyz', 'https:/ninjalabs.xyz', 'https:///ninjalabs.xyz', 'HTTPS:\\\\ninjalabs.xyz', 'http:ninjalabs.xyz/x',
  ])('isHttpUrl requires // after the scheme: %p', (value) => {
    expect(isHttpUrl(value)).toBe(false);
  });

  it.each([
    'https://user:pw@ninjalabs.xyz', 'https://user@ninjalabs.xyz', 'https://:pw@ninjalabs.xyz', 'https://ninjalabs.xyz@evil.com/x',
    'https://@ninjalabs.xyz', 'https://ninjalabs.xyz%40evil.com@evil.com',
  ])('isHttpUrl rejects userinfo: %p', (value) => {
    expect(isHttpUrl(value)).toBe(false);
  });

  it('isHttpUrl still accepts hosts with ports, paths, queries and fragments', () => {
    expect(isHttpUrl('HTTPS://NinjaLabs.xyz:8443/a/b?c=d#e')).toBe(true);
    expect(isHttpUrl('http://127.0.0.1:3000/')).toBe(true);
  });

  it('isMediaPath accepts exactly the relative path POST /admin/media returns', () => {
    expect(isMediaPath(mediaPath)).toBe(true);
    expect(isMediaPath(mediaPath.toUpperCase())).toBe(true);
    expect(isMediaPath('/media/not-a-uuid')).toBe(false);
    expect(isMediaPath(`${mediaPath}/../x`)).toBe(false);
    expect(isMediaPath(`https://api.ninjalabs.xyz${mediaPath}`)).toBe(false);
    expect(isMediaPath('/other/11111111-1111-4111-8111-111111111111')).toBe(false);
  });

  it('isSitePath accepts absolute site routes but not protocol-relative or whitespace paths', () => {
    expect(isSitePath('/bounties/helix-volume-analytics')).toBe(true);
    expect(isSitePath('/')).toBe(true);
    expect(isSitePath('/bounties/')).toBe(true);
    expect(isSitePath('/bounties?page=2&q=a%20b#top')).toBe(true);
    expect(isSitePath('/users/%EB%8B%8C%EC%9E%90')).toBe(true);
    expect(isSitePath('/a/.hidden/b.c/..d/e..')).toBe(true);
    expect(isSitePath(mediaPath)).toBe(true);
    expect(isSitePath('//evil.com/x')).toBe(false);
    expect(isSitePath('bounties/x')).toBe(false);
    expect(isSitePath('/bounties/x y')).toBe(false);
    expect(isSitePath('/x\\y')).toBe(false);
    expect(isSitePath('')).toBe(false);
  });

  it.each([
    ['percent-encoded slash', '/bounties%2f..%2fadmin'],
    ['percent-encoded slash (upper)', '/bounties%2F..%2Fadmin'],
    ['percent-encoded backslash', '/x%5cy'],
    ['percent-encoded backslash (upper)', '/x%5Cy'],
    ['encoded slash in the query', '/x?next=%2f%2fevil.com'],
    ['NUL', '/x\u0000y'],
    ['encoded NUL', '/x%00y'],
    ['other control char', '/x\u001fy'],
    ['DEL', '/x\u007fy'],
    ['encoded CR LF', '/x%0d%0aSet-Cookie:a=b'],
    ['dot-dot segment', '/bounties/../admin'],
    ['trailing dot-dot', '/bounties/..'],
    ['single-dot segment', '/./admin'],
    ['encoded dot-dot', '/bounties/%2e%2e/admin'],
    ['half-encoded dot-dot', '/bounties/.%2E/admin'],
    ['path-parameter dot-dot', '/bounties/..;/admin'],
    ['path-parameter dot-dot with value', '/bounties/..;jsessionid=1/admin'],
    ['encoded path-parameter dot-dot', '/bounties/%2e%2e%3b/admin'],
    ['malformed percent encoding', '/bounties/%zz'],
    ['truncated percent encoding', '/bounties/%2'],
    ['too long', `/${'a'.repeat(2048)}`],
  ])('isSitePath rejects %s: %p', (_label, value) => {
    expect(isSitePath(value)).toBe(false);
  });
});
