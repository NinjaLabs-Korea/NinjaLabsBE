import { decryptGraceToken, encryptGraceToken } from './refresh-grace';

describe('refresh reuse-grace token envelope', () => {
  const secret = 's'.repeat(32);
  const token = 'r'.repeat(64);

  it('round-trips with the same secret and produces a fresh IV each time', () => {
    const a = encryptGraceToken(secret, token);
    const b = encryptGraceToken(secret, token);
    expect(a).not.toBe(b);
    expect(a).not.toContain(token);
    expect(decryptGraceToken(secret, a)).toBe(token);
    expect(decryptGraceToken(secret, b)).toBe(token);
  });

  it('returns null for a different secret, a tampered ciphertext or garbage', () => {
    const encoded = encryptGraceToken(secret, token);
    expect(decryptGraceToken('t'.repeat(32), encoded)).toBeNull();
    const [iv, ciphertext, tag] = encoded.split('.');
    const flipped = Buffer.from(ciphertext, 'base64url');
    flipped[0] ^= 0xff;
    expect(decryptGraceToken(secret, [iv, flipped.toString('base64url'), tag].join('.'))).toBeNull();
    expect(decryptGraceToken(secret, 'not.an.envelope')).toBeNull();
    expect(decryptGraceToken(secret, '')).toBeNull();
  });
});
