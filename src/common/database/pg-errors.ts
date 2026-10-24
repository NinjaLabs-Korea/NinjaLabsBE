import { BadRequestException } from '@nestjs/common';

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
 * 요청 값 때문에 난 Postgres 오류를 400으로 바꾼다 — 그 외는 그대로 돌려준다.
 *   22021/22P05 → INVALID_CHARACTER (저장할 수 없는 문자)
 *   23503 + "is not present in table" → REFERENCE_NOT_FOUND (요청이 없는 행의 id를 가리킴) — 서비스가 도메인 코드(BOUNTY_NOT_FOUND 등)로
 *     먼저 바꾸지 못한 경우의 **안전망**이다. 새 FK 입력은 서비스에서 해당 제약 이름으로 잡아 구체적인 코드를 주는 것이 원칙.
 * HttpExceptionFilter(응답)와 RequestLoggingInterceptor(요청 로그의 상태)가 같은 판단을 쓴다.
 */
export function asClientError(err: unknown): unknown {
  const code = (err as PgError)?.code;
  if (typeof code === 'string' && INVALID_CHARACTER_CODES.has(code)) return new BadRequestException('INVALID_CHARACTER');
  if (isMissingReference(err)) return new BadRequestException('REFERENCE_NOT_FOUND');
  return err;
}
