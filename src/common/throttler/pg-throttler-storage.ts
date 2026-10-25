import { Logger } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import { errorText, logSafe } from '../logging/log-safe';
import { QueryRunner } from '../database/database.service';

/**
 * 한 번의 원자적 upsert로 카운트한다 (0016_throttler_storage.sql). 같은 key의 동시 요청은 ON CONFLICT의 행 잠금으로 직렬화되므로
 * 레플리카가 몇 대든 한 버킷을 나눠 쓴다. 시각은 전부 DB의 now() — 레플리카 간 시계 차이가 창 계산에 섞이지 않는다.
 *
 * 고정 창(fixed window): 첫 요청이 now()+ttl까지의 창을 열고, 창이 지나면 다음 요청이 hits=1로 새 창을 연다.
 * 한도를 넘긴 요청(hits > limit)은 blocked_until = now()+blockDuration을 찍고, 그때까지 오는 요청은 카운트하지 않고 차단된다.
 * 차단이 풀린 뒤 첫 요청은 새 창으로 시작한다 (@nestjs/throttler 기본 저장소의 resetBlockdRequest와 같은 의미).
 *
 * `$n` 캐스트는 문장 안에서 같은 자리마다 통일한다 (test-support/sql-param-casts.spec.ts) — $2/$3/$4는 항상 `::int`.
 */
export const THROTTLER_INCREMENT_SQL = `
INSERT INTO throttler_storage AS t (key, hits, expires_at, blocked_until)
VALUES ($1, 1, now() + $2::int * interval '1 millisecond',
        CASE WHEN 1 > $3::int THEN now() + $4::int * interval '1 millisecond' END)
ON CONFLICT (key) DO UPDATE SET
  hits = CASE
    WHEN t.blocked_until > now() THEN t.hits
    WHEN t.expires_at <= now() OR t.blocked_until IS NOT NULL THEN 1
    ELSE t.hits + 1
  END,
  expires_at = CASE
    WHEN t.blocked_until > now() THEN t.expires_at
    WHEN t.expires_at <= now() OR t.blocked_until IS NOT NULL THEN EXCLUDED.expires_at
    ELSE t.expires_at
  END,
  blocked_until = CASE
    WHEN t.blocked_until > now() THEN t.blocked_until
    WHEN (CASE WHEN t.expires_at <= now() OR t.blocked_until IS NOT NULL THEN 1 ELSE t.hits + 1 END) > $3::int
      THEN now() + $4::int * interval '1 millisecond'
  END
RETURNING hits,
  GREATEST(ceil(extract(epoch FROM t.expires_at - now())), 0)::int AS time_to_expire,
  COALESCE(t.blocked_until > now(), false) AS is_blocked,
  GREATEST(COALESCE(ceil(extract(epoch FROM t.blocked_until - now())), 0), 0)::int AS time_to_block_expire`;

/** 패키지 index가 ThrottlerStorageRecord를 내보내지 않아 인터페이스에서 꺼낸다 */
type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;
type IncrementRow = { hits: number; time_to_expire: number; is_blocked: boolean; time_to_block_expire: number };

/** DB 오류 로그 간격 — 장애 중 요청마다 error 로그가 쏟아지지 않게 */
const ERROR_LOG_INTERVAL_MS = 60_000;

/**
 * Postgres 공유 throttler 저장소 (THROTTLER_STORAGE=postgres, production 기본) — throttler-options.ts가 세 throttler 모듈
 * (전역 IP, agent-api, auth-token)에 넣는다. 저장 키는 `<throttlerName>:<guard 키>` (guard 키는 이미 해시/agentId라 원문 자격 증명이 없다).
 *
 * **fail-open**: DB 오류면 그 요청은 통과시키고(카운트 없음) error 로그를 분당 1회까지만 남긴다. DB가 죽으면 인증·바운티 등 본 기능이
 * 어차피 실패하므로, 한도 저장소 때문에 `/health`와 DB를 안 쓰는 경로까지 500으로 만들지 않는다 (docs/security.md).
 */
export class PgThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(PgThrottlerStorage.name);
  private lastErrorLogAt = 0;

  constructor(private readonly db: QueryRunner) {}

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string): Promise<ThrottlerStorageRecord> {
    try {
      const result = (await this.db.query(THROTTLER_INCREMENT_SQL, [
        `${throttlerName}:${key}`,
        Math.round(ttl),
        Math.round(limit),
        Math.round(blockDuration),
      ])) as { rows: IncrementRow[] };
      const row = result.rows[0];
      return {
        totalHits: row.hits,
        timeToExpire: row.time_to_expire,
        isBlocked: row.is_blocked,
        timeToBlockExpire: row.time_to_block_expire,
      };
    } catch (err) {
      const now = Date.now();
      if (now - this.lastErrorLogAt >= ERROR_LOG_INTERVAL_MS) {
        this.lastErrorLogAt = now;
        this.logger.error(`throttler storage unavailable, failing open: ${logSafe(errorText(err))}`);
      }
      return { totalHits: 0, timeToExpire: Math.ceil(ttl / 1000), isBlocked: false, timeToBlockExpire: 0 };
    }
  }
}
