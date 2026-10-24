import { createCipheriv, createHash, randomBytes } from 'crypto';
import { decryptGraceToken, encryptGraceToken } from './refresh-grace';

describe('refresh reuse-grace token envelope', () => {
  const secret = 's'.repeat(32);
  const token = 'r'.repeat(64);
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const otherSession = '22222222-2222-4222-8222-222222222222';

  it('round-trips with the same secret and session id and produces a fresh IV each time', () => {
    const a = encryptGraceToken(secret, sessionId, token);
    const b = encryptGraceToken(secret, sessionId, token);
    expect(a).not.toBe(b);
    expect(a).not.toContain(token);
    expect(decryptGraceToken(secret, sessionId, a)).toBe(token);
    expect(decryptGraceToken(secret, sessionId, b)).toBe(token);
  });

  it('is bound to the session row: a copy moved to another auth_session row does not decrypt (AAD)', () => {
    expect(decryptGraceToken(secret, otherSession, encryptGraceToken(secret, sessionId, token))).toBeNull();
  });

  it('returns null for a different secret, a tampered ciphertext or garbage', () => {
    const encoded = encryptGraceToken(secret, sessionId, token);
    expect(decryptGraceToken('t'.repeat(32), sessionId, encoded)).toBeNull();
    const [iv, ciphertext, tag] = encoded.split('.');
    const flipped = Buffer.from(ciphertext, 'base64url');
    flipped[0] ^= 0xff;
    expect(decryptGraceToken(secret, sessionId, [iv, flipped.toString('base64url'), tag].join('.'))).toBeNull();
    expect(decryptGraceToken(secret, sessionId, 'not.an.envelope')).toBeNull();
    expect(decryptGraceToken(secret, sessionId, '')).toBeNull();
  });

  it('treats a copy written with the previous scheme (sha256 key, no AAD) as "no grace" (null)', () => {
    const legacyKey = createHash('sha256').update(`${secret}\u0000refresh-grace`).digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', legacyKey, iv);
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    const legacy = [iv, ciphertext, cipher.getAuthTag()].map((part) => part.toString('base64url')).join('.');
    expect(decryptGraceToken(secret, sessionId, legacy)).toBeNull();
  });
});
