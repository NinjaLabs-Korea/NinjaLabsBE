import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'crypto';
import { DatabaseService } from '../common/database/database.service';

export interface SessionUser {
  userId: string;
  isAdmin: boolean;
}

export interface OAuthState {
  traceId?: string;
  redirectUrl?: string;
}

/**
 * 인증 흐름 (Google OAuth → 자체 JWT 세션)
 *
 * 1. FE가 /auth/google 로 리다이렉트 → 구글 동의 화면
 * 2. 구글이 /auth/google/callback 으로 code 전달
 * 3. 백엔드가 code를 토큰으로 교환, google_id/email 획득
 * 4. user upsert (신규면 온보딩 단계 1로 생성)
 * 5. access token(JWT) + refresh token 발급, refresh는 해시만 auth_session에 저장
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly db: DatabaseService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  private googleClientId(): string {
    const id = this.config.get<string>('GOOGLE_CLIENT_ID');
    if (!id) throw new Error('GOOGLE_CLIENT_ID is not configured');
    return id;
  }

  /**
   * CSRF 방어용 state — 서명된 단기 JWT라 서버 측 저장소/쿠키 없이 검증 가능.
   * 콜백에서 서명·만료·용도(p)를 확인한다.
   */
  async issueOauthState(traceId?: string, redirectUrl?: string): Promise<string> {
    const safeTraceId = traceId && /^[a-zA-Z0-9-]{1,64}$/.test(traceId) ? traceId : undefined;
    return this.jwt.signAsync(
      { p: 'gstate', t: safeTraceId, r: redirectUrl },
      { expiresIn: '10m' },
    );
  }

  async verifyOauthState(state: string): Promise<OAuthState> {
    try {
      const payload = await this.jwt.verifyAsync<{ p?: string; t?: string; r?: string }>(state);
      if (payload.p !== 'gstate') throw new Error('wrong purpose');
      return { traceId: payload.t, redirectUrl: payload.r };
    } catch {
      throw new UnauthorizedException('INVALID_OAUTH_STATE');
    }
  }

  buildGoogleAuthUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.googleClientId(),
      redirect_uri: this.config.get<string>('GOOGLE_CALLBACK_URL') ?? '',
      response_type: 'code',
      scope: 'openid email',
      state,
      // 매 로그인마다 계정 선택 화면 노출 (공용 PC에서 자동 재로그인 방지)
      prompt: 'select_account',
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }

  /** code → 토큰 교환 후 구글 프로필(google_id, email) 반환 */
  async exchangeGoogleCode(code: string): Promise<{ googleId: string; email: string }> {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.googleClientId(),
        client_secret: this.config.get<string>('GOOGLE_CLIENT_SECRET') ?? '',
        redirect_uri: this.config.get<string>('GOOGLE_CALLBACK_URL') ?? '',
        grant_type: 'authorization_code',
      }),
    });
    if (!res.ok) throw new UnauthorizedException('GOOGLE_CODE_EXCHANGE_FAILED');
    const body = (await res.json()) as { id_token?: string };
    if (!body.id_token) throw new UnauthorizedException('GOOGLE_CODE_EXCHANGE_FAILED');

    // id_token은 구글 토큰 엔드포인트에서 TLS로 직접 받았으므로 서명 재검증은 생략하고
    // 클레임(iss/aud/email_verified)만 확인한다.
    const claims = JSON.parse(
      Buffer.from(body.id_token.split('.')[1], 'base64url').toString('utf8'),
    ) as { iss?: string; aud?: string; sub?: string; email?: string; email_verified?: boolean };

    const issOk = claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com';
    if (!issOk || claims.aud !== this.googleClientId() || !claims.sub || !claims.email) {
      throw new UnauthorizedException('INVALID_GOOGLE_ID_TOKEN');
    }
    if (claims.email_verified === false) {
      throw new UnauthorizedException('GOOGLE_EMAIL_NOT_VERIFIED');
    }
    return { googleId: claims.sub, email: claims.email };
  }

  /** GET /auth/me — 프로필 + 온보딩/지갑/NFT 상태 (api-contract.md 응답 형태) */
  async getMe(userId: string) {
    const user = await this.db.query(
      `SELECT u.id, u.nickname, u.email, u.bio, u.onboarding_step,
              u.onboarding_completed_at, u.is_admin, u.is_member,
              COALESCE(array_agg(t.tag) FILTER (WHERE t.tag IS NOT NULL), '{}') AS tags
         FROM "user" u
         LEFT JOIN user_tag t ON t.user_id = u.id
        WHERE u.id = $1 AND u.deleted_at IS NULL
        GROUP BY u.id`,
      [userId],
    );
    if (!user.rowCount) throw new NotFoundException('USER_NOT_FOUND');
    const u = user.rows[0];

    const wallet = await this.db.query(
      `SELECT address, verified_at FROM wallet
        WHERE user_id = $1 AND is_primary = true AND disconnected_at IS NULL`,
      [userId],
    );
    const nft = await this.db.query(
      `SELECT status, token_id FROM nft
        WHERE owner_user_id = $1 AND nft_type = 'NINJA_PARENT'`,
      [userId],
    );

    return {
      id: u.id,
      nickname: u.nickname,
      email: u.email,
      bio: u.bio,
      tags: u.tags,
      onboardingStep: u.onboarding_step,
      onboardingCompleted: u.onboarding_completed_at !== null,
      isAdmin: u.is_admin,
      isMember: u.is_member,
      wallet: wallet.rowCount
        ? { address: wallet.rows[0].address, verifiedAt: wallet.rows[0].verified_at }
        : null,
      nft: nft.rowCount
        ? { status: nft.rows[0].status, tokenId: nft.rows[0].token_id }
        : null,
    };
  }

  /** 구글 프로필로 유저를 찾거나 생성한다 */
  async upsertGoogleUser(googleId: string, email: string) {
    const found = await this.db.query(
      `SELECT id, is_admin, onboarding_step, onboarding_completed_at
         FROM "user" WHERE google_id = $1 AND deleted_at IS NULL`,
      [googleId],
    );
    if (found.rowCount) return found.rows[0];

    // Google 인증(1단계)은 완료됐으므로 다음 화면인 지갑 연결(2단계)부터 시작한다.
    // 닉네임은 온보딩 3단계에서 입력받으므로 임시값으로 생성한다.
    const created = await this.db.query(
      `INSERT INTO "user" (google_id, email, nickname, bio, onboarding_step)
       VALUES ($1, $2, $3, '', 2)
       RETURNING id, is_admin, onboarding_step, onboarding_completed_at`,
      [googleId, email, `user_${randomBytes(4).toString('hex')}`],
    );
    return created.rows[0];
  }

  /** JWT access + refresh 발급, refresh 해시는 auth_session에 저장 */
  async issueSession(userId: string, isAdmin: boolean, ip?: string, userAgent?: string) {
    const session = await this.createSessionTokens(userId, isAdmin);

    await this.db.query(
      `INSERT INTO auth_session (user_id, refresh_token_hash, ip_address, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '14 days')`,
      [userId, session.refreshHash, ip ?? null, userAgent ?? null],
    );
    return { accessToken: session.accessToken, refreshToken: session.refreshToken };
  }

  /**
   * refresh token 재발급 — **회전(rotation) 방식**
   * 구 refresh token은 즉시 폐기하고 새 토큰을 발급한다.
   * 탈취된 토큰의 유효 기간을 "다음 갱신까지"로 최소화하고,
   * 이미 폐기된 토큰 재사용 시도(= 탈취 신호)는 거부된다.
   */
  async refresh(refreshToken: string, ip?: string, userAgent?: string) {
    const hash = createHash('sha256').update(refreshToken).digest('hex');
    return this.db.tx(async (tx) => {
      // 유효한 기존 세션을 조건부 UPDATE로 선점한다. 같은 토큰의 동시 요청 중
      // 첫 요청만 row를 반환하고, 나머지는 커밋 이후 조건 재평가에서 거부된다.
      const consumed = await tx.query<{ user_id: string; is_admin: boolean }>(
        `UPDATE auth_session AS s
            SET revoked_at = now()
           FROM "user" AS u
          WHERE s.refresh_token_hash = $1
            AND s.user_id = u.id
            AND s.revoked_at IS NULL
            AND s.expires_at > now()
          RETURNING s.user_id, u.is_admin`,
        [hash],
      );
      if (consumed.rowCount !== 1) {
        throw new UnauthorizedException('INVALID_REFRESH_TOKEN');
      }

      const { user_id, is_admin } = consumed.rows[0];
      const next = await this.createSessionTokens(user_id, is_admin);
      await tx.query(
        `INSERT INTO auth_session (user_id, refresh_token_hash, ip_address, user_agent, expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '14 days')`,
        [user_id, next.refreshHash, ip ?? null, userAgent ?? null],
      );
      return { accessToken: next.accessToken, refreshToken: next.refreshToken };
    });
  }

  private async createSessionTokens(userId: string, isAdmin: boolean) {
    const accessToken = await this.jwt.signAsync({ sub: userId, adm: isAdmin });
    const refreshToken = randomBytes(48).toString('base64url');
    const refreshHash = createHash('sha256').update(refreshToken).digest('hex');
    return { accessToken, refreshToken, refreshHash };
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
