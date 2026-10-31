import { UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { DatabaseService } from '../common/database/database.service';
import { AuthSessions, hashToken } from './auth-sessions';
import { activeUserSql } from '../users/active-user';

/**
 * OAuth 콜백 → FE 사이의 일회용 로그인 코드(oauth_login_code)의 단일 출처. URL에는 세션 토큰 대신 이 코드만 실린다.
 * AuthService의 issueLoginCode / exchangeLoginCode가 이 클래스에 위임한다.
 *
 * 여기를 고치는 경우:
 *   - 코드/verifier 형식(PKCE, RFC 7636) → exchangeLoginCode 첫 줄의 정규식.
 *   - 코드 수명(60초) → 이 파일이 아니라 oauth_login_code.expires_at 기본값(supabase/migrations/0013_oauth_login_codes.sql).
 *   - 코드를 소비한 뒤 세션을 어떻게 발급하나 → auth-sessions.ts (같은 트랜잭션으로 넘긴다).
 * 규칙은 login-code.spec.ts / auth.service.branches.spec.ts가 문서 역할을 한다.
 */
export class LoginCodes {
  constructor(
    private readonly db: DatabaseService,
    private readonly sessions: AuthSessions,
  ) {}

  /** OAuth callback carries only a 60-second code bound to the initiating browser. */
  async issueLoginCode(userId: string, codeChallenge: string): Promise<string> {
    const code = randomBytes(32).toString('base64url');
    await this.db.query('DELETE FROM oauth_login_code WHERE expires_at <= now()');
    await this.db.query(
      `INSERT INTO oauth_login_code (code_hash, user_id, code_challenge)
       VALUES ($1, $2, $3)`,
      [hashToken(code), userId, codeChallenge],
    );
    return code;
  }

  async exchangeLoginCode(code: string, codeVerifier: string, ip?: string, userAgent?: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(code) || !/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) {
      throw new UnauthorizedException('INVALID_LOGIN_CODE');
    }
    const codeHash = hashToken(code);
    const challenge = createHash('sha256').update(codeVerifier).digest('base64url');
    return this.db.tx(async (tx) => {
      // Conditional DELETE atomically consumes the code, including across server replicas.
      const consumed = await tx.query<{ user_id: string; is_admin: boolean }>(
        `DELETE FROM oauth_login_code AS c USING "user" AS u
          WHERE c.code_hash = $1 AND c.code_challenge = $2
            AND c.expires_at > now() AND c.user_id = u.id
            AND ${activeUserSql('u')}
          RETURNING c.user_id, u.is_admin`,
        [codeHash, challenge],
      );
      if (consumed.rowCount !== 1) throw new UnauthorizedException('INVALID_LOGIN_CODE');
      const { user_id, is_admin } = consumed.rows[0];
      return this.sessions.issue(user_id, is_admin, ip, userAgent, tx);
    });
  }
}
