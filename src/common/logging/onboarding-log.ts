import { HttpException, Logger } from '@nestjs/common';

type LogDetails = Record<string, boolean | number | string | null | undefined>;

/** Temporary structured onboarding diagnostics. Never pass tokens, codes, signatures, or messages. */
export function onboardingLog(logger: Logger, event: string, details: LogDetails = {}) {
  logger.log(`[onboarding] ${JSON.stringify({ event, ...details })}`);
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
  logger.error(`[onboarding] ${JSON.stringify({ event, ...details, errorCode: code })}`);
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
