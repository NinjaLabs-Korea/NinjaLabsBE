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

/** 로그에 실을 에러 설명 — 메시지가 빈 AggregateError(듀얼스택 DB 연결 실패)도 원인이 남는다. 구현은 NestJS 밖(migrate.js)과 공유하려고 scripts/ops-alert.js에 있다 */
export { errorText } from '../../../scripts/ops-alert';
