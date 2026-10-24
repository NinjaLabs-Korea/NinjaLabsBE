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
import { createHash, randomBytes, randomUUID } from 'crypto';
import { QueryResult } from 'pg';
import { DatabaseService, QueryRunner } from '../common/database/database.service';
import { isUniqueViolation } from '../common/database/pg-errors';
import { JWT_SECRET } from './jwt-secret';
import { decryptGraceToken, encryptGraceToken, REFRESH_REUSE_GRACE } from './refresh-grace';
import { GoogleIdTokenVerifier } from './google-id-token.verifier';
import { AccessTokenVerifier, legacyAccessTokenCutoff, SessionUser } from './access-token.verifier';
import { GoogleOAuthFlow, OAuthState } from './google-oauth.flow';
import { normalizeRefreshTtl, refreshTtlSeconds } from './refresh-ttl';
import { UserStatusCache } from './user-status-cache';

// SessionUser는 컨트롤러·가드 등 여러 모듈이 이 경로로 import한다 — 정의는 access-token.verifier.ts 한 곳
export type { SessionUser } from './access-token.verifier';
export type { OAuthState } from './google-oauth.flow';

/**
 * revokeChain 이 prev_refresh_token_hash 를 따라가는 최대 홉 수. 정상 사슬은 폐기 후 30일(MaintenanceService)이 지나면 잘려 나가므로
 * 15분 회전이라도 이보다 훨씬 짧다 — 넘으면 손상된/조작된 사슬(순환 등)로 보고 그 유저의 열린 세션을 전부 폐기한다 (안전 쪽으로).
 */
export const MAX_REVOKE_CHAIN_HOPS = 32;

/**
 * 인증 흐름 (Google OAuth → 자체 JWT 세션)
 *
 * 1. FE가 /auth/google 로 리다이렉트 → 구글 동의 화면
 * 2. 구글이 /auth/google/callback 으로 code 전달
 * 3. 백엔드가 code를 토큰으로 교환, google_id/email 획득
 * 4. user upsert (신규면 온보딩 단계 1로 생성)
 * 5. 브라우저 challenge에 연결된 일회용 코드 전달 (URL에 세션 토큰 없음)
 * 6. POST /auth/exchange로 코드를 소비하고 세션 발급, refresh는 해시만 저장
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
    try {
      const created = await this.db.query(
        `INSERT INTO "user" (google_id, email, nickname, bio, onboarding_step)
         VALUES ($1, $2, $3, '', 2)
         RETURNING id, is_admin, onboarding_step, onboarding_completed_at`,
        [googleId, email, `user_${randomBytes(4).toString('hex')}`],
      );
      return created.rows[0];
    } catch (err: unknown) {
      // uq_user_email / uq_user_google_id는 deleted_at IS NULL 행만 본다(0014). 그래도 같은 이메일/구글 계정의 활성 행과
      // 충돌하면(동시 첫 로그인, 또는 탈퇴 후 다른 google_id로 같은 이메일) 500 대신 409 → 콜백이 #error=AUTH_FAILED로 보낸다
      if (isUniqueViolation(err)) throw new ConflictException('ACCOUNT_CONFLICT');
      throw err;
    }
  }

  /** OAuth callback carries only a 60-second code bound to the initiating browser. */
  async issueLoginCode(userId: string, codeChallenge: string): Promise<string> {
    const code = randomBytes(32).toString('base64url');
    await this.db.query('DELETE FROM oauth_login_code WHERE expires_at <= now()');
    await this.db.query(
      `INSERT INTO oauth_login_code (code_hash, user_id, code_challenge)
       VALUES ($1, $2, $3)`,
      [createHash('sha256').update(code).digest('hex'), userId, codeChallenge],
    );
    return code;
  }

  async exchangeLoginCode(code: string, codeVerifier: string, ip?: string, userAgent?: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(code) || !/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) {
      throw new UnauthorizedException('INVALID_LOGIN_CODE');
    }
    const codeHash = createHash('sha256').update(code).digest('hex');
    const challenge = createHash('sha256').update(codeVerifier).digest('base64url');
    return this.db.tx(async (tx) => {
      // Conditional DELETE atomically consumes the code, including across server replicas.
      const consumed = await tx.query<{ user_id: string; is_admin: boolean }>(
        `DELETE FROM oauth_login_code AS c USING "user" AS u
          WHERE c.code_hash = $1 AND c.code_challenge = $2
            AND c.expires_at > now() AND c.user_id = u.id
            AND u.deleted_at IS NULL AND u.status = 'ACTIVE'
          RETURNING c.user_id, u.is_admin`,
        [codeHash, challenge],
      );
      if (consumed.rowCount !== 1) throw new UnauthorizedException('INVALID_LOGIN_CODE');
      const { user_id, is_admin } = consumed.rows[0];
      const session = await this.createSessionTokens(user_id, is_admin);
      await this.saveSession(tx, user_id, session.refreshHash, ip, userAgent);
      return { accessToken: session.accessToken, refreshToken: session.refreshToken };
    });
  }

  /** JWT access + refresh 발급, refresh 해시는 auth_session에 저장 */
  async issueSession(userId: string, isAdmin: boolean, ip?: string, userAgent?: string) {
    const session = await this.createSessionTokens(userId, isAdmin);

    await this.saveSession(this.db, userId, session.refreshHash, ip, userAgent);
    return { accessToken: session.accessToken, refreshToken: session.refreshToken };
  }

  /**
   * refresh token 재발급 — **회전(rotation) 방식**
   * 구 refresh token은 즉시 폐기하고 새 토큰을 발급한다.
   * 탈취된 토큰의 유효 기간을 "다음 갱신까지"로 최소화하고,
   * 이미 폐기된 토큰 재사용 시도(= 탈취 신호)는 거부되며 그 토큰에서 파생된 세션 사슬 전체를 폐기한다.
   *
   * 재사용 유예(30초): 멀티탭이 같은 토큰으로 동시에 호출하면 진 쪽은 401 대신 **이긴 쪽과 같은 후속 쌍**을 받는다
   * (후속 세션 행의 grace_refresh_token을 복호화 — refresh-grace.ts). 다시 회전하지 않으므로 두 탭이 같은 토큰을 쥔다.
   */
  async refresh(refreshToken: string, ip?: string, userAgent?: string) {
    const hash = createHash('sha256').update(refreshToken).digest('hex');
    // 재사용 감지의 사슬 폐기는 **커밋돼야** 한다 — 트랜잭션 콜백 안에서 401을 던지면 db.tx가 롤백해 폐기가 사라진다
    // (test-db의 auth.db-spec이 실 DB로 확인). 그래서 콜백은 결과만 돌려주고 예외는 커밋 뒤에 던진다.
    const outcome = await this.db.tx(async (tx): Promise<{ tokens: { accessToken: string; refreshToken: string } } | { reuse: true }> => {
      // 유효한 기존 세션을 조건부 UPDATE로 선점한다. 같은 토큰의 동시 요청 중
      // 첫 요청만 row를 반환하고, 나머지는 커밋 이후 조건 재평가에서 거부된다.
      // 정지(SUSPENDED/WITHDRAWN)·삭제된 유저의 세션은 회전되지 않는다 — 구 토큰은 아래 사슬 폐기로 소비되므로 재시도도 불가.
      // 이 행이 품고 있던 유예 사본(grace_refresh_token)은 회전되는 순간 비운다.
      const consumed = await tx.query<{ user_id: string; is_admin: boolean }>(
        `UPDATE auth_session AS s
            SET revoked_at = now(), grace_refresh_token = NULL
           FROM "user" AS u
          WHERE s.refresh_token_hash = $1
            AND s.user_id = u.id
            AND s.revoked_at IS NULL
            AND s.expires_at > now()
            AND u.status = 'ACTIVE'
            AND u.deleted_at IS NULL
          RETURNING s.user_id, u.is_admin`,
        [hash],
      );
      if (consumed.rowCount === 1) {
        const { user_id, is_admin } = consumed.rows[0];
        const next = await this.createSessionTokens(user_id, is_admin);
        await this.saveSession(tx, user_id, next.refreshHash, ip, userAgent, {
          prevHash: hash,
          graceRefreshToken: next.refreshToken,
        });
        return { tokens: { accessToken: next.accessToken, refreshToken: next.refreshToken } };
      }

      // 유예 창: 이 토큰이 30초 안에 회전됐고 그 후속 세션이 아직 살아 있으면 후속 쌍을 그대로 돌려준다
      const successor = await tx.query<{ id: string; user_id: string; is_admin: boolean; grace_refresh_token: string }>(
        `SELECT s.id, s.user_id, u.is_admin, s.grace_refresh_token
           FROM auth_session AS s
           JOIN "user" AS u ON u.id = s.user_id
          WHERE s.prev_refresh_token_hash = $1
            AND s.prev_rotated_at > now() - interval '${REFRESH_REUSE_GRACE}'
            AND s.grace_refresh_token IS NOT NULL
            AND s.revoked_at IS NULL
            AND s.expires_at > now()
            AND u.status = 'ACTIVE'
            AND u.deleted_at IS NULL`,
        [hash],
      );
      const graced = successor.rowCount === 1
        ? decryptGraceToken(this.graceSecret, successor.rows[0].id, successor.rows[0].grace_refresh_token)
        : null;
      if (graced) {
        const { user_id, is_admin } = successor.rows[0];
        const accessToken = await this.jwt.signAsync({ sub: user_id, adm: is_admin, typ: 'access' });
        return { tokens: { accessToken, refreshToken: graced } };
      }

      // 재사용 감지: 창 밖이거나 후속이 이미 회전/폐기됨 → 이 토큰과 거기서 파생된 사슬 전체를 폐기한다 (커밋 후 401)
      await this.revokeChain(tx, hash);
      return { reuse: true };
    });
    if ('reuse' in outcome) throw new UnauthorizedException('INVALID_REFRESH_TOKEN');
    return outcome.tokens;
  }

  /**
   * hash 세션과 prev_refresh_token_hash로 이어진 모든 후속 세션을 폐기 (유예 사본도 비운다).
   *
   * 재귀 CTE 한 문장으로 하지 않는 이유: READ COMMITTED에서 문장 하나는 시작 시점 스냅샷만 본다. 정당한 소유자가 바로 그 순간
   * 후속 토큰(T2)을 회전 중이면(S2를 조건부 UPDATE로 잠근 채 S3를 INSERT, 아직 커밋 전) CTE는 S3를 보지 못하고, S2는 잠금 대기 뒤
   * 재평가에서 이미 폐기돼 건너뛴다 — 그 회전이 커밋되면 S3가 살아남는다. 그래서 사슬을 한 홉씩 **FOR UPDATE로 잠그며** 따라간다:
   * 회전 중인 행은 그 트랜잭션이 끝날 때까지 기다리고, 다음 홉은 새 스냅샷이라 커밋된 S3를 본다. 새 홉이 없을 때까지 반복한 뒤
   * 모은 행을 한 번에 폐기한다 (test-db auth.db-spec이 이 레이스를 실 DB로 재현).
   *
   * 홉 수는 MAX_REVOKE_CHAIN_HOPS 로 묶는다 — 그보다 긴 사슬은 정상 회전으로는 생기지 않으므로(손상·조작된 데이터) 걷기를 멈추고
   * 그 유저의 폐기되지 않은 세션을 **전부** 폐기한 뒤 경고를 남긴다. 사슬을 따라가다 끝내지 못하는 것보다 넓게 폐기하는 쪽이 안전하다.
   */
  private async revokeChain(runner: QueryRunner, hash: string) {
    const ids = new Set<string>();
    const seen = new Set<string>();
    let userId: string | undefined;
    let frontier = [hash];
    for (let hops = 0; frontier.length; hops++) {
      if (hops >= MAX_REVOKE_CHAIN_HOPS) {
        this.logger.warn(
          `revokeChain: session chain from ${hash.slice(0, 12)}… exceeds ${MAX_REVOKE_CHAIN_HOPS} hops — revoking every open session of user ${userId} instead`,
        );
        await runner.query(
          `UPDATE auth_session SET revoked_at = now(), grace_refresh_token = NULL
            WHERE user_id = $1 AND revoked_at IS NULL`,
          [userId],
        );
        return;
      }
      for (const h of frontier) seen.add(h);
      const hop = (await runner.query(
        `SELECT id, user_id, refresh_token_hash FROM auth_session
          WHERE refresh_token_hash = ANY($1::varchar[]) OR prev_refresh_token_hash = ANY($1::varchar[])
          FOR UPDATE`,
        [frontier],
      )) as QueryResult<{ id: string; user_id: string; refresh_token_hash: string }>;
      for (const row of hop.rows) ids.add(row.id);
      userId ??= hop.rows[0]?.user_id;
      frontier = hop.rows.map((row) => row.refresh_token_hash).filter((h) => !seen.has(h));
    }
    await runner.query(
      `UPDATE auth_session SET revoked_at = now(), grace_refresh_token = NULL
        WHERE id = ANY($1::uuid[]) AND revoked_at IS NULL`,
      [[...ids]],
    );
  }

  private async createSessionTokens(userId: string, isAdmin: boolean) {
    // typ: 'access' — 같은 JWT_SECRET으로 서명되는 OAuth state(p: 'gstate')가 Bearer로 쓰이지 않도록 용도를 바인딩한다
    const accessToken = await this.jwt.signAsync({ sub: userId, adm: isAdmin, typ: 'access' });
    const refreshToken = randomBytes(48).toString('base64url');
    const refreshHash = createHash('sha256').update(refreshToken).digest('hex');
    return { accessToken, refreshToken, refreshHash };
  }

  /**
   * refresh 세션 저장 — 원문 토큰은 저장하지 않고 해시만, 수명은 JWT_REFRESH_TTL.
   * 회전으로 만들어진 세션은 선행 토큰 해시(prev_refresh_token_hash, 재사용 감지 사슬)와
   * 30초 유예용 암호화 사본(grace_refresh_token)을 함께 적는다. 사본은 이 행의 id를 AAD로 묶으므로 id를 앱에서 먼저 만든다 ($8).
   * `$6`은 두 번 쓰이므로 두 자리 모두 같은 캐스트(::varchar)여야 한다 — 한쪽만 캐스트하면 Postgres가
   * 42P08(inconsistent types deduced for parameter)로 거부해 모든 세션 발급이 500이 된다 (test-db가 실제 DB로 검증).
   */
  private async saveSession(
    runner: QueryRunner,
    userId: string,
    refreshHash: string,
    ip?: string,
    userAgent?: string,
    rotation?: { prevHash: string; graceRefreshToken: string },
  ) {
    const sessionId = randomUUID();
    await runner.query(
      `INSERT INTO auth_session
         (id, user_id, refresh_token_hash, ip_address, user_agent, expires_at,
          prev_refresh_token_hash, prev_rotated_at, grace_refresh_token)
       VALUES ($8::uuid, $1, $2, $3, $4, now() + $5::interval,
               $6::varchar, CASE WHEN $6::varchar IS NULL THEN NULL ELSE now() END, $7)`,
      [userId, refreshHash, ip ?? null, userAgent ?? null, this.refreshTtl,
       rotation?.prevHash ?? null,
       rotation ? encryptGraceToken(this.graceSecret, sessionId, rotation.graceRefreshToken) : null,
       sessionId],
    );
  }

  /** 세션 폐기 (로그아웃) — 유예 사본도 비운다 */
  async revoke(refreshToken: string) {
    const hash = createHash('sha256').update(refreshToken).digest('hex');
    await this.db.query(
      `UPDATE auth_session SET revoked_at = now(), grace_refresh_token = NULL
        WHERE refresh_token_hash = $1 AND revoked_at IS NULL`,
      [hash],
    );
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
