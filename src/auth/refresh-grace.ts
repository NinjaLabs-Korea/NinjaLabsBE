import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

/**
 * refresh 회전 재사용 유예(grace) — 멀티탭이 같은 refresh token으로 동시에 /auth/refresh를 부르면 두 번째 탭이 401을 받고
 * FE가 세션 상실로 처리하던 문제. 회전 후 30초 안에 구 토큰이 다시 오면 **같은 후속 refresh token**을 돌려줘야 하므로
 * 후속 원문을 후속 세션 행에 암호화해 잠깐 보관한다 (`auth_session.grace_refresh_token`, 0014).
 *
 *   - AES-256-GCM, 키 = sha256(JWT_SECRET || 'refresh-grace') — DB만 유출돼서는 복호화할 수 없다
 *   - 30초가 지나면 MaintenanceService가 비우고, 후속 세션이 회전/폐기될 때도 비운다
 *   - 평문 해시(refresh_token_hash)만 저장한다는 원칙의 유일한 예외이며, 수명이 30초인 사본이다 (docs/security.md)
 */
export const REFRESH_REUSE_GRACE = '30 seconds';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

function graceKey(secret: string): Buffer {
  return createHash('sha256').update(`${secret}\u0000refresh-grace`).digest();
}

export function encryptGraceToken(secret: string, rawRefreshToken: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, graceKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(rawRefreshToken, 'utf8'), cipher.final()]);
  return [iv, ciphertext, cipher.getAuthTag()].map((part) => part.toString('base64url')).join('.');
}

/** 형식이 깨졌거나 키가 다르면 null (유예를 포기하고 401로 떨어진다) */
export function decryptGraceToken(secret: string, encoded: string): string | null {
  const [iv, ciphertext, tag] = encoded.split('.').map((part) => Buffer.from(part ?? '', 'base64url'));
  if (!iv || !ciphertext || !tag || iv.length !== IV_BYTES || tag.length !== 16) return null;
  try {
    const decipher = createDecipheriv(ALGORITHM, graceKey(secret), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
