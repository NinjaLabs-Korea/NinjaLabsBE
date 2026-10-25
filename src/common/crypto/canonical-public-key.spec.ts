import { canonicalPublicKeyBase64 } from './canonical-public-key';

describe('canonicalPublicKeyBase64', () => {
  const key = Buffer.from(`02${'ab'.repeat(32)}`, 'hex');
  const canonical = key.toString('base64');

  it('returns the canonical padded form for every spelling Node decodes to the same 33 bytes', () => {
    expect(canonicalPublicKeyBase64(canonical)).toBe(canonical);
    expect(canonicalPublicKeyBase64(canonical.replace(/=+$/, ''))).toBe(canonical);
    expect(canonicalPublicKeyBase64(key.toString('base64url'))).toBe(canonical);
    expect(canonicalPublicKeyBase64(` ${canonical.slice(0, 10)}\n${canonical.slice(10)} `)).toBe(canonical);
    expect(canonicalPublicKeyBase64(`${canonical}${'!'.repeat(50_000)}`)).toBe(canonical);
  });

  it('is null unless the decoded key is 33 bytes', () => {
    expect(canonicalPublicKeyBase64('')).toBeNull();
    expect(canonicalPublicKeyBase64('not-a-key')).toBeNull();
    expect(canonicalPublicKeyBase64(Buffer.alloc(32, 1).toString('base64'))).toBeNull();
  });
});
