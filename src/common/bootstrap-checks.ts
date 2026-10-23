/**
 * 부트스트랩 환경 검사 — main.ts / auth.module.ts / auth/jwt-secret.ts가 ConfigService에서 읽은 값을 넘긴다
 * (import 시점의 process.env는 ConfigModule이 .env를 읽기 전이므로 쓰지 않는다).
 * production에서 잘못 설정된 값은 조용히 폴백하지 않고 기동을 거부한다 (fail-fast).
 */
export type BootstrapEnv = Record<string, string | undefined>;

export function isProduction(env: BootstrapEnv): boolean {
  return env.NODE_ENV === 'production';
}

/**
 * 리버스 프록시 홉 수. production에서 0/미설정이면 모든 요청이 프록시 IP로 묶여 rate limit과
 * auth_session.ip_address가 무의미해지므로 기동을 거부한다 (.railway/railway.ts가 TRUST_PROXY=1을 넣는다).
 */
export function trustProxyHops(env: BootstrapEnv): number {
  const hops = Number(env.TRUST_PROXY ?? 0);
  if (isProduction(env) && !(Number.isInteger(hops) && hops > 0)) {
    throw new Error(
      'FATAL: TRUST_PROXY must be an integer >= 1 in production (number of reverse-proxy hops, 1 on Railway). ' +
        'Without it X-Forwarded-For is ignored and every client shares the proxy IP for rate limiting and session IP logging.',
    );
  }
  return Number.isInteger(hops) && hops > 0 ? hops : 0;
}

const DEV_JWT_SECRET_PLACEHOLDER = 'change-me-long-random-string';
const MIN_JWT_SECRET_BYTES = 32;

/** JWT_SECRET — production에서는 미설정/기본값/32바이트 미만이면 기동 거부. 개발에서는 고정 dev 시크릿으로 폴백. */
export function requireJwtSecret(env: BootstrapEnv): string {
  const secret = env.JWT_SECRET;
  const usable = Boolean(secret) && secret !== DEV_JWT_SECRET_PLACEHOLDER;
  if (isProduction(env)) {
    if (!usable || Buffer.byteLength(secret!, 'utf8') < MIN_JWT_SECRET_BYTES) {
      throw new Error(
        `FATAL: JWT_SECRET must be set to a random value of at least ${MIN_JWT_SECRET_BYTES} bytes in production (not the .env.example placeholder)`,
      );
    }
    return secret!;
  }
  return usable ? secret! : 'dev-only-secret';
}

/** GOOGLE_CLIENT_SECRET — production에서 비어 있으면 code 교환이 전부 실패하므로 기동 시점에 거부한다. */
export function requireGoogleClientSecret(env: BootstrapEnv): void {
  if (isProduction(env) && !env.GOOGLE_CLIENT_SECRET?.trim()) {
    throw new Error('FATAL: GOOGLE_CLIENT_SECRET must be set in production');
  }
}
