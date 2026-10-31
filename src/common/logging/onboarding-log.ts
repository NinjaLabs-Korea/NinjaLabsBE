import { HttpException, Logger } from '@nestjs/common';
import { capLogValue } from './log-safe';

type LogDetails = Record<string, boolean | number | string | null | undefined>;

/**
 * 문자열 값은 200자로 자른다(닉네임처럼 사용자가 준 값이 섞인다). CR/LF 등 제어 문자는 JSON.stringify가 `\n`으로 이스케이프하므로 한 줄이 유지된다.
 * U+2028/2029는 JSON이 이스케이프하지 않으므로 여기서 바꾼다.
 */
function safeDetails(details: LogDetails): LogDetails {
  return Object.fromEntries(Object.entries(details).map(([key, value]) => [key, safeValue(value)]));
}

/**
 * 타입은 문자열|숫자|불리언|null이지만 쿼리 파라미터가 그대로 넘어오는 호출처(`?trace[a]=…`, `?error=a&error=b`)에서는 Express가 배열/객체를 준다 -
 * 그대로 두면 문자열 상한 없이 중첩 구조가 로그 한 줄에 실린다. 객체는 JSON 문자열로 바꿔 같은 상한을 적용한다.
 */
function safeValue(value: unknown): boolean | number | string | null | undefined {
  if (typeof value === 'string') return safeString(value);
  if (value !== null && typeof value === 'object') return safeString(JSON.stringify(value));
  return value as boolean | number | null | undefined;
}

function safeString(value: string): string {
  return capLogValue(value.replace(/[\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16)}`));
}

/**
 * Structured onboarding/auth diagnostics (JSON after the `[onboarding]` tag). Never pass tokens, codes, signatures, or messages.
 * Pass `rid: requestIdOf(req)` so a line joins the request log (`... rid=<id>`); `traceId` is the FE's `x-onboarding-trace-id`.
 */
export function onboardingLog(logger: Logger, event: string, details: LogDetails = {}) {
  logger.log(`[onboarding] ${JSON.stringify({ event, ...safeDetails(details) })}`);
}

/** 예상된 4xx(닉네임 중복·확인 불일치·Turnstile 거절 등 사용자 실수)는 warn, 5xx와 예기치 못한 예외만 error - error 레벨 필터에 장애만 남기려는 규칙 */
export function onboardingError(
  logger: Logger,
  event: string,
  error: unknown,
  details: LogDetails = {},
) {
  let code = error instanceof Error ? error.name : 'UNKNOWN_ERROR';
  if (error instanceof HttpException) {
    const response = error.getResponse();
    code = typeof response === 'string'
      ? response
      : String((response as { message?: string | string[] }).message ?? error.name);
  }
  const line = `[onboarding] ${JSON.stringify({ event, ...safeDetails(details), errorCode: safeString(code) })}`;
  if (error instanceof HttpException && error.getStatus() < 500) logger.warn(line);
  else logger.error(line);
}

export function maskWalletAddress(address: string): string {
  const value = address.trim();
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : 'invalid';
}

export function requestTraceId(headers: Record<string, unknown>): string | undefined {
  const value = headers['x-onboarding-trace-id'];
  return typeof value === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(value)
    ? value
    : undefined;
}
