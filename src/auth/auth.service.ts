import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'crypto';
import { DatabaseService } from '../common/database/database.service';

export interface SessionUser {
  userId: string;
  isAdmin: boolean;
}

/**
 * 인증 흐름 (Google OAuth → 자체 JWT 세션)
 *
 * 1. FE가 /auth/google 로 리다이렉트 → 구글 동의 화면
 * 2. 구글이 /auth/google/callback 으로 code 전달
 * 3. 백엔드가 code를 토큰으로 교환, google_id/email 획득
 * 4. user upsert (신규면 온보딩 단계 1로 생성)
 * 5. access token(JWT) + refresh token 발급, refresh는 해시만 auth_session에 저장
 *
 * TODO(구현): 구글 토큰 교환은 googleapis 또는 fetch로 구현.
 *             Turnstile 검증도 이 시점(가입 요청)에 수행.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly db: DatabaseService,
    private readonly jwt: JwtService,
  ) {}

  /** 구글 프로필로 유저를 찾거나 생성한다 */
  async upsertGoogleUser(googleId: string, email: string) {
    const found = await this.db.query(
      `SELECT id, is_admin FROM "user" WHERE google_id = $1 AND deleted_at IS NULL`,
      [googleId],
    );
    if (found.rowCount) return found.rows[0];

    // 닉네임은 온보딩 3단계에서 입력받으므로 임시값으로 생성
    const created = await this.db.query(
      `INSERT INTO "user" (google_id, email, nickname, bio, onboarding_step)
       VALUES ($1, $2, $3, '', 1)
       RETURNING id, is_admin`,
      [googleId, email, `user_${randomBytes(4).toString('hex')}`],
    );
    return created.rows[0];
  }

  /** JWT access + refresh 발급, refresh 해시는 auth_session에 저장 */
  async issueSession(userId: string, isAdmin: boolean, ip?: string, userAgent?: string) {
    const accessToken = await this.jwt.signAsync({ sub: userId, adm: isAdmin });
    const refreshToken = randomBytes(48).toString('base64url');
    const refreshHash = createHash('sha256').update(refreshToken).digest('hex');

    await this.db.query(
      `INSERT INTO auth_session (user_id, refresh_token_hash, ip_address, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '14 days')`,
      [userId, refreshHash, ip ?? null, userAgent ?? null],
    );
    return { accessToken, refreshToken };
  }

  /**
   * refresh token 재발급 — **회전(rotation) 방식**
   * 구 refresh token은 즉시 폐기하고 새 토큰을 발급한다.
   * 탈취된 토큰의 유효 기간을 "다음 갱신까지"로 최소화하고,
   * 이미 폐기된 토큰 재사용 시도(= 탈취 신호)는 거부된다.
   */
  async refresh(refreshToken: string, ip?: string, userAgent?: string) {
    const hash = createHash('sha256').update(refreshToken).digest('hex');
    const session = await this.db.query<{ id: string; user_id: string; is_admin: boolean }>(
      `SELECT s.id, s.user_id, u.is_admin
         FROM auth_session s JOIN "user" u ON u.id = s.user_id
        WHERE s.refresh_token_hash = $1
          AND s.revoked_at IS NULL
          AND s.expires_at > now()`,
      [hash],
    );
    if (!session.rowCount) throw new UnauthorizedException('INVALID_REFRESH_TOKEN');
    const { id, user_id, is_admin } = session.rows[0];

    // 구 세션 폐기 후 새 세션 발급 (원자적 회전)
    await this.db.query(`UPDATE auth_session SET revoked_at = now() WHERE id = $1`, [id]);
    return this.issueSession(user_id, is_admin, ip, userAgent);
  }

  /** 세션 폐기 (로그아웃) */
  async revoke(refreshToken: string) {
    const hash = createHash('sha256').update(refreshToken).digest('hex');
    await this.db.query(
      `UPDATE auth_session SET revoked_at = now() WHERE refresh_token_hash = $1 AND revoked_at IS NULL`,
      [hash],
    );
  }

  async verifyAccessToken(token: string): Promise<SessionUser> {
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; adm: boolean }>(token);
      return { userId: payload.sub, isAdmin: payload.adm === true };
    } catch {
      throw new UnauthorizedException('INVALID_ACCESS_TOKEN');
    }
  }
}
