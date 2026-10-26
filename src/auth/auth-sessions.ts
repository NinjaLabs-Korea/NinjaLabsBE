import { Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { JWT_SIGN_OPTIONS } from './jwt-algorithm';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { isIP } from 'net';
import { QueryResult } from 'pg';
import { DatabaseService, QueryRunner } from '../common/database/database.service';
import { decryptGraceToken, encryptGraceToken, REFRESH_REUSE_GRACE } from './refresh-grace';

/**
 * 자체 세션(access JWT + refresh 토큰)의 단일 출처 — 발급, 회전(refresh), 재사용 감지 사슬 폐기, 로그아웃.
 * AuthService의 issueSession / refresh / revoke와 LoginCodes(로그인 코드 소비 후 발급)가 이 클래스를 쓴다.
 *
 * 여기를 고치는 경우:
 *   - access JWT에 넣는 클레임 → signAccessToken (검증 쪽 access-token.verifier.ts도 함께).
 *   - refresh 회전·30초 유예·재사용 감지 규칙 → refresh / revokeChain. 유예 사본 암호화와 창 길이는 refresh-grace.ts.
 *   - auth_session에 적는 컬럼 → saveSession (`$6` 이중 캐스트 주의 — 아래 주석). 수명(JWT_REFRESH_TTL) 해석은 refresh-ttl.ts.
 *   - 사슬 홉 상한 → MAX_REVOKE_CHAIN_HOPS.
 * 회전/로그인 시 "유저가 ACTIVE인가"는 각 SQL의 `u.status = 'ACTIVE' AND u.deleted_at IS NULL` 조건이다.
 */

/**
 * revokeChain 이 prev_refresh_token_hash 를 따라가는 최대 홉 수. 정상 사슬은 폐기 후 30일(MaintenanceService)이 지나면 잘려 나가므로
 * 15분 회전이라도 이보다 훨씬 짧다 — 넘으면 손상된/조작된 사슬(순환 등)로 보고 그 유저의 열린 세션을 전부 폐기한다 (안전 쪽으로).
 */
export const MAX_REVOKE_CHAIN_HOPS = 32;

/** refresh 토큰·로그인 코드 원문 → DB에 저장/조회하는 sha256 hex 해시 (원문은 저장하지 않는다) */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * 한 유저의 열린 세션을 전부 폐기 (유예 사본도 비운다) — 그 유저는 이후 refresh할 수 없다.
 * 호출자의 runner(트랜잭션) 안에서 실행한다: revokeChain의 홉 상한 초과 폴백, 회원 탈퇴(users/account-withdrawal.service.ts).
 */
export async function revokeAllSessionsOfUser(runner: QueryRunner, userId: string): Promise<void> {
  await runner.query(
    `UPDATE auth_session SET revoked_at = now(), grace_refresh_token = NULL
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
}

/** auth_session.ip_address(INET)에 넣어도 되는 값만 통과 — Node의 isIP는 존 ID(`fe80::1%eth0`)를 받지만 Postgres inet은 거부한다 */
function inetOrNull(ip: string | undefined): string | null {
  return ip && isIP(ip) && !ip.includes('%') ? ip : null;
}

export class AuthSessions {
  /**
   * @param refreshTtl normalizeRefreshTtl 결과(`'14 days'`) — auth_session.expires_at = now() + 이 interval
   * @param graceSecret grace_refresh_token 암호화 키 재료 (refresh-grace.ts) — AuthService가 JWT_SECRET provider에서 받아 넘긴다
   * @param logger AuthService의 로거 — 로그 컨텍스트가 `AuthService`로 유지된다
   */
  constructor(
    private readonly db: DatabaseService,
    private readonly jwt: JwtService,
    private readonly refreshTtl: string,
    private readonly graceSecret: string,
    private readonly logger: Logger,
  ) {}

  /**
   * JWT access + refresh 발급, refresh 해시는 auth_session에 저장.
   * @param runner 기본은 풀(autocommit). 로그인 코드 소비처럼 같은 트랜잭션에서 저장해야 하면 그 tx를 넘긴다 (login-codes.ts)
   */
  async issue(userId: string, isAdmin: boolean, ip?: string, userAgent?: string, runner: QueryRunner = this.db) {
    const session = await this.createSessionTokens(userId, isAdmin);

    await this.saveSession(runner, userId, session.refreshHash, ip, userAgent);
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
    const hash = hashToken(refreshToken);
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
        const accessToken = await this.signAccessToken(user_id, is_admin);
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
  async revokeChain(runner: QueryRunner, hash: string) {
    const ids = new Set<string>();
    const seen = new Set<string>();
    let userId: string | undefined;
    let frontier = [hash];
    for (let hops = 0; frontier.length; hops++) {
      if (hops >= MAX_REVOKE_CHAIN_HOPS) {
        this.logger.warn(
          `revokeChain: session chain from ${hash.slice(0, 12)}… exceeds ${MAX_REVOKE_CHAIN_HOPS} hops - revoking every open session of user ${userId} instead`,
        );
        // 홉이 하나라도 있었으므로 userId는 정해져 있다 (frontier가 비어 있지 않다 = 직전 홉이 행을 돌려줬다)
        if (userId) await revokeAllSessionsOfUser(runner, userId);
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

  /**
   * access JWT 발급 — 클레임 모양의 단일 출처 (검증 규칙은 access-token.verifier.ts, 두 곳을 함께 고친다).
   * typ: 'access' — 같은 JWT_SECRET으로 서명되는 OAuth state(p: 'gstate')가 Bearer로 쓰이지 않도록 용도를 바인딩한다
   */
  private signAccessToken(userId: string, isAdmin: boolean): Promise<string> {
    return this.jwt.signAsync({ sub: userId, adm: isAdmin, typ: 'access' }, JWT_SIGN_OPTIONS);
  }

  private async createSessionTokens(userId: string, isAdmin: boolean) {
    const accessToken = await this.signAccessToken(userId, isAdmin);
    const refreshToken = randomBytes(48).toString('base64url');
    const refreshHash = hashToken(refreshToken);
    return { accessToken, refreshToken, refreshHash };
  }

  /**
   * refresh 세션 저장 — 원문 토큰은 저장하지 않고 해시만, 수명은 JWT_REFRESH_TTL.
   * ip_address는 INET 컬럼이라 IP 리터럴이 아닌 값(포트가 붙은 `1.2.3.4:5678`, 존 ID가 붙은 IPv6, 프록시가 넘긴 쓰레기)은 Postgres가
   * 22P02로 거부해 그 클라이언트의 모든 로그인·refresh가 500이 된다 — 기록용 값이라 IP가 아니면 null로 둔다.
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
      [userId, refreshHash, inetOrNull(ip), userAgent ?? null, this.refreshTtl,
       rotation?.prevHash ?? null,
       rotation ? encryptGraceToken(this.graceSecret, sessionId, rotation.graceRefreshToken) : null,
       sessionId],
    );
  }

  /**
   * 세션 폐기 (로그아웃) — 유예 사본도 비운다. 제시된 토큰이 방금(30초 유예 안에) 회전됐다면 그 후속 세션도 함께 폐기한다:
   * 로그아웃과 다른 탭의 refresh가 겹치면 로그아웃 요청은 이미 회전된 구 토큰을 들고 오는데, 구 세션만 닫으면 후속 세션이 살아남아
   * 로그아웃했는데도 로그인이 유지된다.
   */
  async revoke(refreshToken: string) {
    const hash = hashToken(refreshToken);
    await this.db.query(
      `UPDATE auth_session SET revoked_at = now(), grace_refresh_token = NULL
        WHERE revoked_at IS NULL
          AND (refresh_token_hash = $1
               OR (prev_refresh_token_hash = $1 AND prev_rotated_at > now() - interval '${REFRESH_REUSE_GRACE}'))`,
      [hash],
    );
  }
}
