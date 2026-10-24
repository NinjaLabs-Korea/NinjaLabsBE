import { BadRequestException } from '@nestjs/common';

/** PostgreSQL unique_violation (23505) — 유니크 인덱스 충돌 여부 */
export function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505';
}

/**
 * 입력 문자 자체를 DB가 저장할 수 없는 오류 — UTF8 DB에서 텍스트에 NUL(U+0000)이 들어 있으면 22021(character_not_in_repertoire,
 * "invalid byte sequence for encoding UTF8: 0x00"), 인코딩 변환 불가는 22P05. 서버 상태가 아니라 요청 값만이 원인이므로 클라이언트 오류다.
 */
const INVALID_CHARACTER_CODES: ReadonlySet<string> = new Set(['22021', '22P05']);

/**
 * 요청 값 때문에 난 Postgres 오류를 400 INVALID_CHARACTER로 바꾼다 — 그 외는 그대로 돌려준다.
 * HttpExceptionFilter(응답)와 RequestLoggingInterceptor(요청 로그의 상태)가 같은 판단을 쓴다.
 */
export function asClientError(err: unknown): unknown {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && INVALID_CHARACTER_CODES.has(code)
    ? new BadRequestException('INVALID_CHARACTER')
    : err;
}
