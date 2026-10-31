import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'crypto';
import { DatabaseService } from '../common/database/database.service';
import { isUniqueViolation } from '../common/database/pg-errors';
import { ONBOARDING_STEP } from '../users/onboarding-step';
import { JWT_SECRET } from './jwt-secret';
import { AuthSessions } from './auth-sessions';
import { LoginCodes } from './login-codes';
import { GoogleIdTokenVerifier } from './google-id-token.verifier';
import { AccessTokenVerifier, legacyAccessTokenCutoff, SessionUser } from './access-token.verifier';
import { GoogleOAuthFlow, OAuthState } from './google-oauth.flow';
import { normalizeRefreshTtl, refreshTtlSeconds } from './refresh-ttl';
import { UserStatusCache } from './user-status-cache';

// SessionUser는 컨트롤러·가드 등 여러 모듈이 이 경로로 import한다 — 정의는 access-token.verifier.ts 한 곳
export type { SessionUser } from './access-token.verifier';
export type { OAuthState } from './google-oauth.flow';

/** `GET /auth/me` 응답 = 쿠키 모드 refresh/exchange 응답의 `user` (docs/api-contract.md). 만드는 곳은 AuthService.getMe 하나 */
export type MeResponse = {
  id: string;
  nickname: string;
  email: string;
  bio: string;
  tags: string[];
  onboardingStep: number;
  onboardingCompleted: boolean;
  isAdmin: boolean;
  isMember: boolean;
  wallet: { address: string; verifiedAt: Date | null } | null;
  nft: { status: string; tokenId: string | null } | null;
};

/**
 * 인증 흐름 (Google OAuth → 자체 JWT 세션)
 *
 * 1. FE가 /auth/google 로 리다이렉트 → 구글 동의 화면
 * 2. 구글이 /auth/google/callback 으로 code 전달
 * 3. 백엔드가 code를 토큰으로 교환, google_id/email 획득
 * 4. user upsert (신규면 온보딩 단계 1로 생성)
 * 5. 브라우저 challenge에 연결된 일회용 코드 전달 (URL에 세션 토큰 없음)
 * 6. POST /auth/exchange로 코드를 소비하고 세션 발급, refresh는 해시만 저장
 *
 * AuthService는 **창구(facade)**다 — 컨트롤러·가드·탈퇴 서비스가 보는 공개 메서드와 생성자 시그니처를 고정하고, 실제 규칙은
 * 아래 협력자에 있다. 규칙을 고칠 때는 이 파일이 아니라 해당 파일을 연다:
 *   - Google state / 동의 URL / code 교환          → google-oauth.flow.ts   (id_token 서명 검증: google-id-token.verifier.ts)
 *   - 일회용 로그인 코드 발급·소비                  → login-codes.ts
 *   - 세션 발급·refresh 회전·재사용 감지·로그아웃   → auth-sessions.ts       (유예 사본 암호화: refresh-grace.ts)
 *   - access JWT 검증 + 레거시 전환기               → access-token.verifier.ts
 *   - JWT_REFRESH_TTL 해석                          → refresh-ttl.ts
 *   - AuthGuard 유저 상태 캐시(30초)                → user-status-cache.ts
 * 이 파일에 직접 남은 규칙은 유저 조회/생성(getMe, upsertGoogleUser)과 assertActiveUser의 "ACTIVE" SQL뿐이다.
 * 협력자는 Nest provider가 아닌 일반 클래스로, 생성자에서 만든다 — 그래서 `new AuthService(db, jwt, config, secret)` 하나로 스펙이 전부 조립된다.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  /** JWT_REFRESH_TTL을 정규화한 Postgres interval 문자열 — 생성 시 검증해 잘못된 값이면 부팅이 실패한다 (JWT_SECRET과 동일) */
  private readonly refreshTtl: string;
  /** refreshTtl을 초로 — refresh 쿠키 Max-Age */
  readonly refreshTtlSeconds: number;
  /** Google OAuth 왕복 (state, 동의 URL, code 교환) — google-oauth.flow.ts */
  private readonly oauth: GoogleOAuthFlow;
  /** 세션 발급·회전·폐기 — auth-sessions.ts */
  private readonly sessions: AuthSessions;
  /** OAuth 콜백 일회용 로그인 코드 — login-codes.ts */
  private readonly loginCodes: LoginCodes;
  /** access JWT 검증 (레거시 전환기 포함) — access-token.verifier.ts */
  private readonly accessTokens: AccessTokenVerifier;
  /** AuthGuard용 유저 상태 캐시 (프로세스별, 30초) — user-status-cache.ts */
  private readonly userStatusCache = new UserStatusCache();

  /**
   * @param graceSecret grace_refresh_token 암호화 키 재료 (refresh-grace.ts). JwtModule이 서명에 쓰는 것과 **같은 provider**(JWT_SECRET,
   *   jwt-secret.ts)에서 주입받으므로 두 값이 어긋날 수 없다 — ConfigModule이 .env를 읽은 뒤 한 번만 계산된다.
   */
  constructor(
    private readonly db: DatabaseService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @Inject(JWT_SECRET) private readonly graceSecret: string,
    @Optional() googleVerifier: GoogleIdTokenVerifier = new GoogleIdTokenVerifier(),
  ) {
    this.refreshTtl = normalizeRefreshTtl(this.config.get<string>('JWT_REFRESH_TTL'));
    this.refreshTtlSeconds = refreshTtlSeconds(this.refreshTtl);
    this.accessTokens = new AccessTokenVerifier(
      this.jwt,
      legacyAccessTokenCutoff(this.config.get<string>('LEGACY_ACCESS_TOKEN_CUTOFF')),
    );
    this.oauth = new GoogleOAuthFlow(this.jwt, this.config, googleVerifier, this.logger);
    this.sessions = new AuthSessions(this.db, this.jwt, this.refreshTtl, this.graceSecret, this.logger);
    this.loginCodes = new LoginCodes(this.db, this.sessions);
  }

  /** CSRF 방어용 서명 state(10분 JWT) 발급 — google-oauth.flow.ts */
  issueOauthState(traceId: string | undefined, redirectUrl: string, codeChallenge: string): Promise<string> {
    return this.oauth.issueOauthState(traceId, redirectUrl, codeChallenge);
  }

  /** 콜백의 state 검증 → trace/redirect/PKCE challenge — google-oauth.flow.ts */
  verifyOauthState(state: string): Promise<OAuthState> {
    return this.oauth.verifyOauthState(state);
  }

  /** Google 동의 화면 URL — google-oauth.flow.ts */
  buildGoogleAuthUrl(state: string): string {
    return this.oauth.buildGoogleAuthUrl(state);
  }

  /** code → 구글 프로필(google_id, email), id_token 서명·클레임 검증 포함 — google-oauth.flow.ts */
  exchangeGoogleCode(code: string): Promise<{ googleId: string; email: string }> {
    return this.oauth.exchangeGoogleCode(code);
  }

  /** GET /auth/me: 프로필 + 온보딩/지갑/NFT 상태 (api-contract.md 응답 형태). 쿠키 모드 refresh/exchange의 `user`도 이것 (sessionUserOf) */
  async getMe(userId: string): Promise<MeResponse> {
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

  /**
   * 방금 발급한 access 토큰의 주인에 대한 `GET /auth/me` 응답. 쿠키 모드 refresh/exchange 응답에 `user`로 싣는다.
   * 토큰을 AuthGuard와 같은 검증기로 읽고 같은 getMe를 부르므로 두 응답이 갈라질 수 없다. FE는 이 값이 있으면 `/auth/me` 왕복을 건너뛴다.
   */
  async sessionUserOf(accessToken: string): Promise<MeResponse> {
    const { userId } = await this.verifyAccessToken(accessToken);
    return this.getMe(userId);
  }

  /** 구글 프로필로 유저를 찾거나 생성한다 */
  async upsertGoogleUser(googleId: string, email: string) {
    const found = await this.findGoogleUser(googleId);
    if (found) return found;

    // Google 인증(1단계)은 완료됐으므로 다음 화면인 지갑 연결(2단계)부터 시작한다.
    // 닉네임은 온보딩 3단계에서 입력받으므로 임시값으로 생성한다.
    try {
      const created = await this.db.query(
        `INSERT INTO "user" (google_id, email, nickname, bio, onboarding_step)
         VALUES ($1, $2, $3, '', ${ONBOARDING_STEP.WALLET})
         RETURNING id, is_admin, onboarding_step, onboarding_completed_at`,
        [googleId, email, `user_${randomBytes(4).toString('hex')}`],
      );
      return created.rows[0];
    } catch (err: unknown) {
      // uq_user_email / uq_user_google_id는 deleted_at IS NULL 행만 본다(0014). 그래도 같은 이메일/구글 계정의 활성 행과
      // 충돌하면(동시 첫 로그인, 또는 탈퇴 후 다른 google_id로 같은 이메일) 500 대신 409 → 콜백이 #error=AUTH_FAILED로 보낸다
      if (isUniqueViolation(err)) {
        // 같은 구글 계정의 동시 첫 로그인(두 콜백이 겹침)이면 상대가 방금 만든 행이 이제 보인다 — 그 유저로 로그인시킨다. 안 보이면 이메일 충돌이다
        const raced = await this.findGoogleUser(googleId);
        if (raced) return raced;
        throw new ConflictException('ACCOUNT_CONFLICT');
      }
      throw err;
    }
  }

  private async findGoogleUser(googleId: string) {
    const found = await this.db.query(
      `SELECT id, is_admin, onboarding_step, onboarding_completed_at
         FROM "user" WHERE google_id = $1 AND deleted_at IS NULL`,
      [googleId],
    );
    return found.rowCount ? found.rows[0] : undefined;
  }

  /** OAuth 콜백용 60초 일회용 코드 발급 (브라우저 PKCE challenge에 묶임) — login-codes.ts */
  issueLoginCode(userId: string, codeChallenge: string): Promise<string> {
    return this.loginCodes.issueLoginCode(userId, codeChallenge);
  }

  /** POST /auth/exchange — 코드를 원자적으로 소비하고 세션 발급 — login-codes.ts */
  exchangeLoginCode(code: string, codeVerifier: string, ip?: string, userAgent?: string) {
    return this.loginCodes.exchangeLoginCode(code, codeVerifier, ip, userAgent);
  }

  /** JWT access + refresh 발급, refresh 해시만 저장 — auth-sessions.ts */
  issueSession(userId: string, isAdmin: boolean, ip?: string, userAgent?: string) {
    return this.sessions.issue(userId, isAdmin, ip, userAgent);
  }

  /** refresh 회전 + 30초 유예 + 재사용 감지 시 사슬 폐기 — auth-sessions.ts */
  refresh(refreshToken: string, ip?: string, userAgent?: string) {
    return this.sessions.refresh(refreshToken, ip, userAgent);
  }

  /** 세션 폐기 (로그아웃) — auth-sessions.ts */
  revoke(refreshToken: string) {
    return this.sessions.revoke(refreshToken);
  }

  /** 이 프로세스의 유저 상태 캐시에서 한 유저를 지운다 — 탈퇴처럼 본인이 상태를 바꾼 직후 다음 요청부터 바로 반영되게 (다른 레플리카는 TTL ≤ 30초) */
  forgetUserStatus(userId: string): void {
    this.userStatusCache.forget(userId);
  }

  /**
   * access 토큰의 주인이 지금도 ACTIVE이고 삭제되지 않았는지 — 아니면 401 INVALID_ACCESS_TOKEN (FE는 refresh를 시도하고, refresh도 같은 조건으로
   * 거부되므로 세션을 비운다). 결과는 USER_STATUS_CACHE_TTL_MS 동안 캐시한다 (정지/삭제 반영 지연 ≤ 30초).
   */
  async assertActiveUser(userId: string, now = Date.now()): Promise<void> {
    let active = this.userStatusCache.get(userId, now);
    if (active === undefined) {
      const r = await this.db.query(
        `SELECT 1 FROM "user" WHERE id = $1 AND status = 'ACTIVE' AND deleted_at IS NULL`,
        [userId],
      );
      active = r.rowCount === 1;
      this.userStatusCache.set(userId, active, now);
    }
    if (!active) throw new UnauthorizedException('INVALID_ACCESS_TOKEN');
  }

  /** access JWT → SessionUser (typ/sub 규칙과 레거시 전환기) — access-token.verifier.ts */
  verifyAccessToken(token: string): Promise<SessionUser> {
    return this.accessTokens.verify(token);
  }
}
