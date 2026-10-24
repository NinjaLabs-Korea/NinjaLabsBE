import { Logger } from '@nestjs/common';

/**
 * 부트스트랩 환경 검사 — main.ts / auth.module.ts / auth/jwt-secret.ts가 ConfigService에서 읽은 값을 넘긴다
 * (import 시점의 process.env는 ConfigModule이 .env를 읽기 전이므로 쓰지 않는다).
 *
 * production에서 **보안을 무력화하는** 값(JWT_SECRET 미설정/자리표시값, GOOGLE_CLIENT_SECRET 미설정, TRUST_PROXY=0/비정수)은
 * 조용히 폴백하지 않고 기동을 거부한다 (fail-fast). 반면 **빠뜨리기 쉽고 안전한 기본값이 있는** 것(TRUST_PROXY 미설정 → 1)과
 * **약하지만 동작은 하는** 것(JWT_SECRET 32바이트 미만)은 크래시 루프 대신 기동하면서 로그로 크게 알린다 —
 * 첫 배포에서 env 하나가 빠졌다고 서비스 전체가 재시작 루프에 빠지지 않도록 (docs/security.md, README "배포 순서").
 */
export type BootstrapEnv = Record<string, string | undefined>;

const logger = new Logger('BootstrapChecks');

export function isProduction(env: BootstrapEnv): boolean {
  return env.NODE_ENV === 'production';
}

/** production에서 TRUST_PROXY가 비어 있을 때의 기본 홉 수 — Railway/Fly/대부분의 PaaS는 엣지 프록시 1홉 뒤다 */
const DEFAULT_PRODUCTION_PROXY_HOPS = 1;

/**
 * 리버스 프록시 홉 수.
 *   - production + 미설정(또는 빈 값): 1로 보고 warn 1회 (Railway는 항상 프록시 1홉 뒤 — 배포 설정에서 빠뜨려도 크래시 루프가 되지 않는다)
 *   - production + 명시적 `0`/비정수/음수: 기동 거부 — 모든 요청이 프록시 IP로 묶여 rate limit과 auth_session.ip_address가 무의미해진다
 *   - 그 외 환경: 미설정/0이면 신뢰 안 함
 */
export function trustProxyHops(env: BootstrapEnv): number {
  const raw = env.TRUST_PROXY?.trim();
  if (isProduction(env) && !raw) {
    logger.warn(
      `TRUST_PROXY is not set — assuming ${DEFAULT_PRODUCTION_PROXY_HOPS} reverse-proxy hop in production (Railway/PaaS default). ` +
        'Set TRUST_PROXY explicitly to the number of proxies in front of this service to silence this warning.',
    );
    return DEFAULT_PRODUCTION_PROXY_HOPS;
  }
  const hops = Number(raw ?? 0);
  const valid = Number.isInteger(hops) && hops > 0;
  if (isProduction(env) && !valid) {
    throw new Error(
      `FATAL: TRUST_PROXY=${JSON.stringify(env.TRUST_PROXY)} — must be an integer >= 1 in production (number of reverse-proxy hops, 1 on Railway), ` +
        'or unset to default to 1. With 0 X-Forwarded-For is ignored and every client shares the proxy IP for rate limiting and session IP logging.',
    );
  }
  return valid ? hops : 0;
}

const DEV_JWT_SECRET_PLACEHOLDER = 'change-me-long-random-string';
const MIN_JWT_SECRET_BYTES = 32;

/**
 * JWT_SECRET
 *   - production + 미설정/자리표시값: 기동 거부 (알려진 시크릿으로 서명하면 누구나 세션을 위조할 수 있다)
 *   - production + 32바이트 미만: 기동은 하되 error 로그 — 약한 시크릿은 교체 대상이지 크래시 루프 사유는 아니다
 *   - 개발: 미설정/자리표시값이면 고정 dev 시크릿으로 폴백
 */
export function requireJwtSecret(env: BootstrapEnv): string {
  const secret = env.JWT_SECRET;
  const usable = Boolean(secret) && secret !== DEV_JWT_SECRET_PLACEHOLDER;
  if (isProduction(env)) {
    if (!usable) {
      throw new Error('FATAL: JWT_SECRET must be set to a random value in production (not the .env.example placeholder). Generate one with: openssl rand -base64 48');
    }
    if (Buffer.byteLength(secret!, 'utf8') < MIN_JWT_SECRET_BYTES) {
      logger.error(
        `JWT_SECRET is only ${Buffer.byteLength(secret!, 'utf8')} bytes — production requires at least ${MIN_JWT_SECRET_BYTES} random bytes. ` +
          'Booting anyway so the service stays up; rotate it now (openssl rand -base64 48). Rotating invalidates every access token and refresh grace copy.',
      );
    }
    return secret!;
  }
  return usable ? secret! : 'dev-only-secret';
}

/** GOOGLE_CLIENT_SECRET — production에서 비어 있으면 code 교환이 전부 실패하므로(로그인 불가) 기동 시점에 거부한다. */
export function requireGoogleClientSecret(env: BootstrapEnv): void {
  if (isProduction(env) && !env.GOOGLE_CLIENT_SECRET?.trim()) {
    throw new Error('FATAL: GOOGLE_CLIENT_SECRET must be set in production');
  }
}
