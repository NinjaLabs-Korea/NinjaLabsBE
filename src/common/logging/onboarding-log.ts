import { HttpException, Logger } from '@nestjs/common';
import { capLogValue } from './log-safe';

type LogDetails = Record<string, boolean | number | string | null | undefined>;

/**
 * 문자열 값은 200자로 자른다(닉네임처럼 사용자가 준 값이 섞인다). CR/LF 등 제어 문자는 JSON.stringify가 `\n`으로 이스케이프하므로 한 줄이 유지된다.
 * U+2028/2029는 JSON이 이스케이프하지 않으므로 여기서 바꾼다.
 */
function safeDetails(details: LogDetails): LogDetails {
  return Object.fromEntries(Object.entries(details).map(([key, value]) => [key, typeof value === 'string' ? safeString(value) : value]));
}

function safeString(value: string): string {
  return capLogValue(value.replace(/[\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16)}`));
}

/** Temporary structured onboarding diagnostics. Never pass tokens, codes, signatures, or messages. */
export function onboardingLog(logger: Logger, event: string, details: LogDetails = {}) {
  logger.log(`[onboarding] ${JSON.stringify({ event, ...safeDetails(details) })}`);
}

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
  logger.error(`[onboarding] ${JSON.stringify({ event, ...safeDetails(details), errorCode: safeString(code) })}`);
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
