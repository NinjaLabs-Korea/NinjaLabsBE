/** 로그 한 줄에 싣는 사용자 유래 문자열의 상한 (이스케이프 후 길이) */
export const LOG_VALUE_MAX = 200;

/**
 * 사용자 유래 문자열(경로, 닉네임, 예외 메시지 — DB 오류 메시지에는 요청 값이 들어간다)을 평문 로그 한 줄에 넣기 전에:
 *   - CR/LF·그 밖의 C0 제어 문자·DEL·U+2028/2029를 `\n`, `\r`, `\uXXXX`로 이스케이프 — 가짜 로그 줄 주입(log forging) 방지
 *   - LOG_VALUE_MAX 자로 자르고 잘린 길이를 붙인다 — 거대한 값이 로그를 채우지 못하게
 */
export function logSafe(value: unknown, max = LOG_VALUE_MAX): string {
  // eslint-disable-next-line no-control-regex -- 제어 문자를 찾는 것이 목적이다
  const escaped = String(value).replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, (char) => {
    if (char === '\n') return '\\n';
    if (char === '\r') return '\\r';
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
  return capLogValue(escaped, max);
}

/** 길이만 자른다 — JSON.stringify로 감싸는 구조화 로그(onboarding-log)는 제어 문자를 JSON이 이미 이스케이프한다 */
export function capLogValue(value: string, max = LOG_VALUE_MAX): string {
  return value.length > max ? `${value.slice(0, max)}…(+${value.length - max} chars)` : value;
}

/**
 * 로그에 실을 에러 설명 — `err.message`가 비어 있어도 원인이 남게 한다.
 * Node의 happy-eyeballs(autoSelectFamily)는 호스트가 IPv6·IPv4 둘 다로 풀릴 때 연결 실패를 `AggregateError`로 던지고, 그 `message`는 빈 문자열이다
 * (`new Pool({ host: 'localhost' }).query()` → `AggregateError{ message: '', code: 'ECONNREFUSED', errors: [::1…, 127.0.0.1…] }`).
 * `err.message`만 찍으면 DB가 닿지 않는 배포(기동 실패 `FATAL: `, 운영 알림, 5xx 줄)의 사유가 통째로 비었다.
 * 메시지가 있으면 그대로, 없으면 하위 오류 메시지(최대 4개) → `code` → 이름 순으로 돌려준다. 제어 문자 이스케이프/길이 제한은 호출부의 `logSafe`가 한다.
 */
export function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (err.message) return err.message;
  const inner = err instanceof AggregateError ? err.errors.filter((e): e is Error => e instanceof Error && Boolean(e.message)).slice(0, 4) : [];
  if (inner.length > 0) return inner.map((e) => e.message).join('; ');
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && code ? `${err.name} ${code}` : err.name;
}
