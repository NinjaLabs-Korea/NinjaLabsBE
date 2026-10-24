/**
 * pg Pool 타임아웃 — 없으면 DB가 블랙홀(패킷 무응답)이 되거나 풀이 고갈될 때 모든 요청이 무한히 매달린다
 * (PgThrottlerStorage가 스로틀 대상 요청마다 DB를 치므로 `/health`를 뺀 거의 모든 경로가 같이 멈춘다).
 *
 *   connectionTimeoutMillis  DB_CONNECTION_TIMEOUT_MS (기본 5000) — 새 연결 수립 + 풀 대기(체크아웃) 상한.
 *                            넘으면 pg-pool이 'timeout exceeded when trying to connect' /
 *                            'Connection terminated due to connection timeout'으로 reject → HttpExceptionFilter가 503 DATABASE_UNAVAILABLE
 *   idleTimeoutMillis        30000 — 유휴 연결 정리
 *   statement_timeout        DB_STATEMENT_TIMEOUT_MS (기본 15000) — 서버 측 문장 상한(연결 시작 파라미터). 넘으면 57014 query_canceled
 *   query_timeout            statement_timeout + 2000 — 서버가 응답조차 못 할 때(소켓은 살아 있고 패킷이 안 옴) 클라이언트 측 상한.
 *                            서버 취소가 먼저 오도록 조금 길게 둔다. 넘으면 'Query read timeout'
 *
 * 잘못된 값(비정수, 0 이하)은 기본값으로 돌린다 — env 오타 하나로 타임아웃이 꺼지거나(0) 기동이 깨지지 않게.
 * scripts/migrate.js의 poolTimeoutOptions()는 연결 타임아웃만 같은 규칙으로 쓰고 문장 타임아웃은 걸지 않는다(긴 DDL/백필).
 */
export const DEFAULT_DB_CONNECTION_TIMEOUT_MS = 5_000;
export const DEFAULT_DB_IDLE_TIMEOUT_MS = 30_000;
export const DEFAULT_DB_STATEMENT_TIMEOUT_MS = 15_000;
/** query_timeout = statement_timeout + 이 값 */
export const QUERY_TIMEOUT_MARGIN_MS = 2_000;

export type DatabaseTimeoutOptions = {
  connectionTimeoutMillis: number;
  idleTimeoutMillis: number;
  statement_timeout: number;
  query_timeout: number;
};

function positiveInt(raw: string | undefined, fallback: number): number {
  const trimmed = raw?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return fallback;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function databaseTimeoutOptions(env: {
  DB_CONNECTION_TIMEOUT_MS?: string;
  DB_STATEMENT_TIMEOUT_MS?: string;
}): DatabaseTimeoutOptions {
  const statement = positiveInt(env.DB_STATEMENT_TIMEOUT_MS, DEFAULT_DB_STATEMENT_TIMEOUT_MS);
  return {
    connectionTimeoutMillis: positiveInt(env.DB_CONNECTION_TIMEOUT_MS, DEFAULT_DB_CONNECTION_TIMEOUT_MS),
    idleTimeoutMillis: DEFAULT_DB_IDLE_TIMEOUT_MS,
    statement_timeout: statement,
    query_timeout: statement + QUERY_TIMEOUT_MARGIN_MS,
  };
}
