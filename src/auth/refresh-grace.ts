import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto';

/**
 * refresh 회전 재사용 유예(grace) — 멀티탭이 같은 refresh token으로 동시에 /auth/refresh를 부르면 두 번째 탭이 401을 받고
 * FE가 세션 상실로 처리하던 문제. 회전 후 30초 안에 구 토큰이 다시 오면 **같은 후속 refresh token**을 돌려줘야 하므로
 * 후속 원문을 후속 세션 행에 암호화해 잠깐 보관한다 (`auth_session.grace_refresh_token`, 0014).
 *
 *   - AES-256-GCM, 키 = HKDF-SHA256(JWT_SECRET, salt = GRACE_KEY_SALT, info = 'refresh-grace', 32바이트) — DB만 유출돼서는 복호화할 수 없다
 *   - AAD = 그 사본을 담은 **auth_session 행 id** — 사본을 다른 세션 행으로 옮겨 붙여도 복호화되지 않는다
 *   - 30초가 지나면 MaintenanceService가 5분마다 비우고, 후속 세션이 회전/폐기될 때도 비운다
 *   - 평문 해시(refresh_token_hash)만 저장한다는 원칙의 유일한 예외이며, 수명이 30초인 사본이다 (docs/security.md)
 *
 * 이전 형식(키 = sha256(secret || 'refresh-grace'), AAD 없음)으로 쓰인 행은 복호화되지 않는다 → "유예 없음"으로 보고 401 + 사슬 폐기 경로로 간다.
 * 그런 행은 배포 시점에 30초 창 안에 있던 것뿐이라(멀티탭 동시 갱신이 그 30초에 겹친 경우만 다시 로그인) 호환 분기를 두지 않는다.
 */
export const REFRESH_REUSE_GRACE = '30 seconds';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

/** HKDF salt — 용도/형식 버전을 고정한다. 바꾸면 기존 사본은 전부 "유예 없음"이 된다 */
export const GRACE_KEY_SALT = 'ninjalabs:auth_session.grace_refresh_token:v2';

function graceKey(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, GRACE_KEY_SALT, 'refresh-grace', 32));
}

/** @param sessionId 사본을 저장할 auth_session 행의 id (AAD로 묶인다) */
export function encryptGraceToken(secret: string, sessionId: string, rawRefreshToken: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, graceKey(secret), iv);
  cipher.setAAD(Buffer.from(sessionId, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(rawRefreshToken, 'utf8'), cipher.final()]);
  return [iv, ciphertext, cipher.getAuthTag()].map((part) => part.toString('base64url')).join('.');
}

/** 형식이 깨졌거나, 키가 다르거나, 다른 세션 행의 사본(AAD 불일치)이거나, 이전 형식이면 null (유예를 포기하고 401로 떨어진다) */
export function decryptGraceToken(secret: string, sessionId: string, encoded: string): string | null {
  const [iv, ciphertext, tag] = encoded.split('.').map((part) => Buffer.from(part ?? '', 'base64url'));
  if (!iv || !ciphertext || !tag || iv.length !== IV_BYTES || tag.length !== 16) return null;
  try {
    const decipher = createDecipheriv(ALGORITHM, graceKey(secret), iv);
    decipher.setAAD(Buffer.from(sessionId, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
