import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';

type PgError = { code?: unknown; constraint?: unknown; detail?: unknown } | null | undefined;

/**
 * PostgreSQL unique_violation (23505) — 유니크 인덱스 충돌 여부. `constraint`를 주면 **그 제약(인덱스) 이름**일 때만 true —
 * 한 트랜잭션이 여러 유니크 제약을 건드릴 때 엉뚱한 충돌을 특정 도메인 코드(예: NICKNAME_TAKEN)로 잘못 바꾸지 않도록.
 */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const pg = err as PgError;
  return pg?.code === '23505' && (constraint === undefined || pg.constraint === constraint);
}

/** PostgreSQL foreign_key_violation (23503). `constraint`를 주면 그 FK 이름일 때만 true */
export function isForeignKeyViolation(err: unknown, constraint?: string): boolean {
  const pg = err as PgError;
  return pg?.code === '23503' && (constraint === undefined || pg.constraint === constraint);
}

/**
 * INSERT/UPDATE가 **존재하지 않는 행을 가리킨** FK 위반인지 — detail이 `Key (x)=(y) is not present in table "t".`인 경우.
 * 참조되는 행을 지우려다 난 23503(`... is still referenced from table ...`)은 요청 값 탓이 아니라 서버 쪽 정책 문제이므로 제외한다.
 */
function isMissingReference(err: unknown): boolean {
  const pg = err as PgError;
  return isForeignKeyViolation(err) && typeof pg?.detail === 'string' && pg.detail.includes('is not present in table');
}

/**
 * 입력 문자 자체를 DB가 저장할 수 없는 오류 — UTF8 DB에서 텍스트에 NUL(U+0000)이 들어 있으면 22021(character_not_in_repertoire,
 * "invalid byte sequence for encoding UTF8: 0x00"), 인코딩 변환 불가는 22P05. 서버 상태가 아니라 요청 값만이 원인이므로 클라이언트 오류다.
 */
const INVALID_CHARACTER_CODES: ReadonlySet<string> = new Set(['22021', '22P05']);

/**
 * 달력에 없는 날짜/시각 — class-validator의 `IsDateString`(비-strict ISO 8601)은 `2026-02-31`·`2026-04-31T00:00:00Z`를 통과시키고
 * Postgres가 timestamptz 캐스트에서 22008(datetime_field_overflow, "date/time field value out of range")로 거부한다. 22007은 형식 자체가 틀린 경우.
 * 둘 다 서버가 만든 값이 아니라 요청 값이 원인이다(서버 쪽 시각은 전부 now()/Date).
 */
const INVALID_DATE_CODES: ReadonlySet<string> = new Set(['22007', '22008']);

/**
 * 요청 값 때문에 난 Postgres 오류를 400으로 바꾼다 — 그 외는 그대로 돌려준다.
 *   22021/22P05 → INVALID_CHARACTER (저장할 수 없는 문자)
 *   22007/22008 → INVALID_DATE (달력에 없는 날짜/시각 — 예: 2월 31일)
 *   23503 + "is not present in table" → REFERENCE_NOT_FOUND (요청이 없는 행의 id를 가리킴) — 서비스가 도메인 코드(BOUNTY_NOT_FOUND 등)로
 *     먼저 바꾸지 못한 경우의 **안전망**이다. 새 FK 입력은 서비스에서 해당 제약 이름으로 잡아 구체적인 코드를 주는 것이 원칙.
 * HttpExceptionFilter·RequestLoggingInterceptor는 asHttpError()(아래)를 거쳐 이 판단을 쓴다.
 */
export function asClientError(err: unknown): unknown {
  const code = (err as PgError)?.code;
  if (typeof code === 'string' && INVALID_CHARACTER_CODES.has(code)) return new BadRequestException('INVALID_CHARACTER');
  if (typeof code === 'string' && INVALID_DATE_CODES.has(code)) return new BadRequestException('INVALID_DATE');
  if (isMissingReference(err)) return new BadRequestException('REFERENCE_NOT_FOUND');
  return err;
}

/**
 * DB에 닿지 못한 오류 — 요청 값이 아니라 DB 쪽 상태가 원인이고 재시도하면 될 수 있는 것.
 * 메시지(pg 8.16 / pg-pool 3.x 고정 문자열):
 *   'timeout exceeded when trying to connect'           풀 고갈 — connectionTimeoutMillis 동안 빈 연결이 안 났다
 *   'Connection terminated due to connection timeout'  새 연결 수립이 connectionTimeoutMillis를 넘었다 (블랙홀 DB)
 *   'Query read timeout'                                query_timeout — 서버가 문장 취소 응답조차 못 보냈다
 *   'Connection terminated unexpectedly'                쿼리 도중 연결이 끊겼다 (DB 재시작·장애조치·네트워크 단절)
 * 코드: 연결 자체가 안 되는 Node 소켓 오류(ECONNREFUSED / ENOTFOUND / EAI_AGAIN — 나가는 연결에서만 나므로 클라이언트 쪽 소켓 오류와 섞이지 않는다)와
 * 서버가 거절한 연결 계열 SQLSTATE — 08xxx connection_exception, 57P01 admin_shutdown, 57P02 crash_shutdown, 57P03 cannot_connect_now(기동 중), 53300 too_many_connections.
 * 서버가 돌려준 57014(statement_timeout)는 여기 넣지 않는다 — DB는 살아 있고 느린 쿼리(서버 버그)이므로 500으로 남겨 경보 대상이 되게 한다.
 */
const DATABASE_UNAVAILABLE_MESSAGES: ReadonlySet<string> = new Set([
  'timeout exceeded when trying to connect',
  'Connection terminated due to connection timeout',
  'Query read timeout',
  'Connection terminated unexpectedly',
]);
const DATABASE_UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN',
  '08000', '08001', '08003', '08004', '08006', '08007', '57P01', '57P02', '57P03', '53300',
]);

export function isDatabaseUnavailable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as PgError)?.code;
  return DATABASE_UNAVAILABLE_MESSAGES.has(err.message) || (typeof code === 'string' && DATABASE_UNAVAILABLE_CODES.has(code));
}

/**
 * 응답 상태 결정용 매핑 — asClientError(400) + DB 연결 불가(타임아웃·연결 끊김·거부) → 503 DATABASE_UNAVAILABLE. 그 외는 그대로.
 * HttpExceptionFilter(응답)와 RequestLoggingInterceptor(요청 로그의 상태)가 같은 판단을 쓴다.
 */
export function asHttpError(err: unknown): unknown {
  if (isDatabaseUnavailable(err)) return new ServiceUnavailableException('DATABASE_UNAVAILABLE');
  return asClientError(err);
}
