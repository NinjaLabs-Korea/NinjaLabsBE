import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'crypto';
import { QueryResult } from 'pg';
import { DatabaseService, QueryRunner } from '../common/database/database.service';
import { isUniqueViolation } from '../common/database/pg-errors';
import { JWT_SECRET } from './jwt-secret';
import { decryptGraceToken, encryptGraceToken, REFRESH_REUSE_GRACE } from './refresh-grace';
import {
  GoogleIdTokenClaims,
  GoogleIdTokenVerifier,
  GoogleVerifierUnavailableError,
} from './google-id-token.verifier';

/**
 * JWT_REFRESH_TTL 문법 — `<정수>[공백]<단위>`. 단위는 아래 표의 것만 받고 Postgres interval 단위로 정규화한다.
 * `m`은 항상 분(minutes)이다 (월이 아님) — Postgres가 `15m`을 분으로 해석하긴 하지만 명시적으로 고정한다.
 */
const REFRESH_TTL = /^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)$/;
const REFRESH_TTL_UNITS: Record<string, string> = {
  s: 'seconds', sec: 'seconds', secs: 'seconds', second: 'seconds', seconds: 'seconds',
  m: 'minutes', min: 'minutes', mins: 'minutes', minute: 'minutes', minutes: 'minutes',
  h: 'hours', hr: 'hours', hrs: 'hours', hour: 'hours', hours: 'hours',
  d: 'days', day: 'days', days: 'days',
  w: 'weeks', week: 'weeks', weeks: 'weeks',
};

const REFRESH_TTL_SECONDS: Record<string, number> = { seconds: 1, minutes: 60, hours: 3_600, days: 86_400, weeks: 604_800 };
/** refresh 수명 허용 범위 — 60초 미만은 access 토큰보다 짧아 로그인이 즉시 풀리고, 90일 초과는 탈취 토큰의 수명이 너무 길다 */
export const MIN_REFRESH_TTL_SECONDS = 60;
export const MAX_REFRESH_TTL_SECONDS = 90 * 86_400;

/**
 * `14d` → `'14 days'`, `15m` → `'15 minutes'`. 문법에 맞지 않거나 0 / 60초 미만 / 90일 초과면 throw (부팅 시 fail-fast).
 */
export function normalizeRefreshTtl(raw: string | undefined): string {
  const ttl = (raw ?? '14d').trim();
  const match = REFRESH_TTL.exec(ttl);
  if (!match) {
    throw new Error(
      `JWT_REFRESH_TTL must be "<integer> <unit>" with unit s/m/h/d/w or their long forms (e.g. 14d, 15m, 2 weeks), got "${ttl}"`,
    );
  }
  const amount = Number(match[1]);
  const unit = REFRESH_TTL_UNITS[match[2]];
  const seconds = amount * REFRESH_TTL_SECONDS[unit];
  if (seconds < MIN_REFRESH_TTL_SECONDS || seconds > MAX_REFRESH_TTL_SECONDS) {
    throw new Error(
      `JWT_REFRESH_TTL must be between ${MIN_REFRESH_TTL_SECONDS} seconds and 90 days (got "${ttl}" = ${seconds} seconds)`,
    );
  }
  return `${amount} ${unit}`;
}

export interface SessionUser {
  userId: string;
  isAdmin: boolean;
}

export interface OAuthState {
  traceId?: string;
  redirectUrl?: string;
  codeChallenge: string;
}

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

  /**
   * @param graceSecret grace_refresh_token 암호화 키 재료 (refresh-grace.ts). JwtModule이 서명에 쓰는 것과 **같은 provider**(JWT_SECRET,
   *   jwt-secret.ts)에서 주입받으므로 두 값이 어긋날 수 없다 — ConfigModule이 .env를 읽은 뒤 한 번만 계산된다.
   */
  constructor(
    private readonly db: DatabaseService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @Inject(JWT_SECRET) private readonly graceSecret: string,
    @Optional() private readonly googleVerifier: GoogleIdTokenVerifier = new GoogleIdTokenVerifier(),
  ) {
    this.refreshTtl = normalizeRefreshTtl(this.config.get<string>('JWT_REFRESH_TTL'));
  }

  private googleClientId(): string {
    const id = this.config.get<string>('GOOGLE_CLIENT_ID');
    if (!id) throw new Error('GOOGLE_CLIENT_ID is not configured');
    return id;
  }

  /**
   * CSRF 방어용 state — 서명된 단기 JWT라 서버 측 저장소/쿠키 없이 검증 가능.
   * 콜백에서 서명·만료·용도(p)를 확인한다.
   */
  async issueOauthState(traceId: string | undefined, redirectUrl: string, codeChallenge: string): Promise<string> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
      throw new UnauthorizedException('INVALID_CODE_CHALLENGE');
    }
    const safeTraceId = traceId && /^[a-zA-Z0-9-]{1,64}$/.test(traceId) ? traceId : undefined;
    return this.jwt.signAsync(
      { p: 'gstate', t: safeTraceId, r: redirectUrl, c: codeChallenge },
      { expiresIn: '10m' },
    );
  }

  async verifyOauthState(state: string): Promise<OAuthState> {
    try {
      const payload = await this.jwt.verifyAsync<{ p?: string; t?: string; r?: string; c?: string }>(state);
      if (payload.p !== 'gstate' || !payload.c || !/^[A-Za-z0-9_-]{43}$/.test(payload.c)) {
        throw new Error('invalid state');
      }
      return { traceId: payload.t, redirectUrl: payload.r, codeChallenge: payload.c };
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

    // id_token 서명을 Google JWKS로 검증한다 (google-auth-library: 서명·만료·audience).
    // 그 위에 iss/aud/sub/email/email_verified 클레임을 한 번 더 확인한다.
    // 검증 실패(서명/만료/audience)는 401, Google JWKS를 못 받아온 것(네트워크/비2xx)은 503 — 토큰 탓이 아니다.
    let claims: GoogleIdTokenClaims | undefined;
    try {
      claims = await this.googleVerifier.verify(body.id_token, this.googleClientId());
    } catch (err) {
      if (err instanceof GoogleVerifierUnavailableError) {
        this.logger.warn(`Google id_token verification unavailable: ${err.message}`);
        throw new ServiceUnavailableException('GOOGLE_UNAVAILABLE');
      }
      throw new UnauthorizedException('INVALID_GOOGLE_ID_TOKEN');
    }
    if (!claims) throw new UnauthorizedException('INVALID_GOOGLE_ID_TOKEN');

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
          graceToken: encryptGraceToken(this.graceSecret, next.refreshToken),
        });
        return { tokens: { accessToken: next.accessToken, refreshToken: next.refreshToken } };
      }

      // 유예 창: 이 토큰이 30초 안에 회전됐고 그 후속 세션이 아직 살아 있으면 후속 쌍을 그대로 돌려준다
      const successor = await tx.query<{ user_id: string; is_admin: boolean; grace_refresh_token: string }>(
        `SELECT s.user_id, u.is_admin, s.grace_refresh_token
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
        ? decryptGraceToken(this.graceSecret, successor.rows[0].grace_refresh_token)
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
   */
  private async revokeChain(runner: QueryRunner, hash: string) {
    const ids = new Set<string>();
    const seen = new Set<string>();
    let frontier = [hash];
    while (frontier.length) {
      for (const h of frontier) seen.add(h);
      const hop = (await runner.query(
        `SELECT id, refresh_token_hash FROM auth_session
          WHERE refresh_token_hash = ANY($1::varchar[]) OR prev_refresh_token_hash = ANY($1::varchar[])
          FOR UPDATE`,
        [frontier],
      )) as QueryResult<{ id: string; refresh_token_hash: string }>;
      for (const row of hop.rows) ids.add(row.id);
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
   * 30초 유예용 암호화 사본(grace_refresh_token)을 함께 적는다.
   * `$6`은 두 번 쓰이므로 두 자리 모두 같은 캐스트(::varchar)여야 한다 — 한쪽만 캐스트하면 Postgres가
   * 42P08(inconsistent types deduced for parameter)로 거부해 모든 세션 발급이 500이 된다 (test-db가 실제 DB로 검증).
   */
  private async saveSession(
    runner: QueryRunner,
    userId: string,
    refreshHash: string,
    ip?: string,
    userAgent?: string,
    rotation?: { prevHash: string; graceToken: string },
  ) {
    await runner.query(
      `INSERT INTO auth_session
         (user_id, refresh_token_hash, ip_address, user_agent, expires_at,
          prev_refresh_token_hash, prev_rotated_at, grace_refresh_token)
       VALUES ($1, $2, $3, $4, now() + $5::interval,
               $6::varchar, CASE WHEN $6::varchar IS NULL THEN NULL ELSE now() END, $7)`,
      [userId, refreshHash, ip ?? null, userAgent ?? null, this.refreshTtl,
       rotation?.prevHash ?? null, rotation?.graceToken ?? null],
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

  /**
   * access JWT 검증 — 서명·만료 외에 `typ === 'access'`와 문자열 `sub`를 요구한다 (state JWT 등 다른 용도 토큰 거부).
   *
   * 전환기 예외: 이 배포 이전에 발급된 access 토큰에는 `typ`이 없다. `typ`도 `p`(OAuth state 용도 클레임)도 없고 `sub`가 문자열인 토큰은
   * 레거시 access 토큰으로 보고 받는다 — 배포 직후 로그인된 사용자가 access TTL(15분) 안에 전부 401을 맞지 않도록.
   * state 토큰(`p: 'gstate'`, `sub` 없음)은 어느 경로로도 통과하지 못한다.
   * TODO(remove after 2026-11-30): 레거시 분기(`legacy`)를 지우고 `typ === 'access'`만 남긴다 — 그때면 구 토큰은 모두 만료됐다.
   */
  async verifyAccessToken(token: string): Promise<SessionUser> {
    let payload: { sub?: unknown; adm?: unknown; typ?: unknown; p?: unknown };
    try {
      payload = await this.jwt.verifyAsync<{ sub?: unknown; adm?: unknown; typ?: unknown; p?: unknown }>(token);
    } catch {
      throw new UnauthorizedException('INVALID_ACCESS_TOKEN');
    }
    const legacy = payload.typ === undefined && payload.p === undefined;
    if ((payload.typ !== 'access' && !legacy) || typeof payload.sub !== 'string' || !payload.sub) {
      throw new UnauthorizedException('INVALID_ACCESS_TOKEN');
    }
    return { userId: payload.sub, isAdmin: payload.adm === true };
  }
}
