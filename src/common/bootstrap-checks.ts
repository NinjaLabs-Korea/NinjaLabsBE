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

/** 개발 기본 FE 오리진 / 로그인 후 리다이렉트 — **production에서는 쓰지 않는다** (아래 두 검사가 값을 요구한다) */
export const LOCAL_FE_ORIGIN = 'http://localhost:3000';
export const LOCAL_AUTH_SUCCESS_REDIRECT = 'http://localhost:3000/';

/** 루프백 호스트 — localhost(·*.localhost), 127.0.0.0/8, ::1, 0.0.0.0. production 브라우저가 이 주소로 가면 사용자 자신의 기계에 닿는다 */
function isLoopbackUrl(value: string): boolean {
  let host: string;
  try {
    host = new URL(value.trim()).hostname.toLowerCase().replace(/\.+$/, '');
  } catch {
    return false;
  }
  return host === 'localhost' || host.endsWith('.localhost') || /^127(\.\d{1,3}){3}$/.test(host) || host === '[::1]' || host === '0.0.0.0';
}

/**
 * CORS 허용 목록의 env 값 (app-setup.ts → OriginAllowlist.fromEnv).
 *   - production + 미설정/빈 값: 기동 거부 — 예전엔 조용히 `http://localhost:3000`으로 폴백해 운영 FE의 모든 API 호출이 CORS로 막혔다
 *   - production + 루프백 항목(localhost/127.x): 그 항목만 빼고 error 로그 (기동은 함) — 아무 브라우저 탭의 localhost 페이지가
 *     운영 API를 자격 증명과 함께 부를 수 있게 되므로 허용하지 않지만, 옛 main의 railway.ts가 `http://localhost:3000`을 넣었기 때문에
 *     `railway config apply` 전의 값으로 크래시 루프가 나지 않게 한다. 빼고 나서 남는 항목이 없으면 미설정과 같으므로 기동 거부
 *   - 그 외 환경: 미설정이면 로컬 FE (`http://localhost:3000`)
 */
export function corsOriginsValue(env: BootstrapEnv): string {
  if (!isProduction(env)) return env.CORS_ORIGINS ?? LOCAL_FE_ORIGIN;
  const entries = (env.CORS_ORIGINS ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) {
    throw new Error('FATAL: CORS_ORIGINS must be set in production (comma-separated FE origins, e.g. https://ninjalabsfe.vercel.app) — there is no localhost fallback in production');
  }
  const loopback = entries.filter(isLoopbackUrl);
  const kept = entries.filter((entry) => !isLoopbackUrl(entry));
  if (loopback.length > 0) {
    logger.error(
      `CORS_ORIGINS contains loopback origin(s) ${loopback.map((entry) => JSON.stringify(entry)).join(', ')} — IGNORED in production ` +
        '(any localhost page in any browser tab could call the production API with credentials). Remove them from the Railway variable; local FEs use a local BE.',
    );
  }
  if (kept.length === 0) {
    throw new Error(`FATAL: CORS_ORIGINS=${JSON.stringify(env.CORS_ORIGINS)} lists only loopback origins — production needs the real FE origin(s)`);
  }
  return kept.join(',');
}

/**
 * AUTH_ALLOWED_REDIRECT_ORIGINS(로그인 returnTo + Turnstile hostname 허용 목록)의 항목 — production에서는 corsOriginsValue와 같은 이유로
 * 루프백 오리진(localhost/127.x)을 뺀다: 로그인 코드를 사용자 자신의 기계에서 도는 아무 서버로 보낼 수 있게 되기 때문이다.
 * 대시보드에서 넣은 `http://localhost:3000`으로 크래시 루프가 나지 않게 기동은 거부하지 않는다 (`ignored`는 AuthModule이 error로 로그).
 * 그 외 환경은 그대로 둔다 — 로컬 FE가 정상 경로다.
 */
export function authRedirectOrigins(env: BootstrapEnv): { kept: string[]; ignored: string[] } {
  const entries = (env.AUTH_ALLOWED_REDIRECT_ORIGINS ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  if (!isProduction(env)) return { kept: entries, ignored: [] };
  return { kept: entries.filter((entry) => !isLoopbackUrl(entry)), ignored: entries.filter(isLoopbackUrl) };
}

/** production에서 AUTH_ALLOWED_REDIRECT_ORIGINS의 루프백 항목이 무시되고 있음을 기동 때 한 번 알린다 (feRedirectAllowlist가 같은 규칙으로 뺀다) */
export function warnIgnoredAuthRedirectOrigins(env: BootstrapEnv): void {
  const { ignored } = authRedirectOrigins(env);
  if (ignored.length === 0) return;
  logger.error(
    `AUTH_ALLOWED_REDIRECT_ORIGINS contains loopback origin(s) ${ignored.map((entry) => JSON.stringify(entry)).join(', ')} — IGNORED in production ` +
      '(a login code could be delivered to any server running on the user\'s own machine). Remove them from the Railway variable.',
  );
}

/** production에서 반드시 있어야 하는 로그인 플로우 값 — 없으면 Google 동의 화면/콜백/완료 리다이렉트 중 하나가 깨진다 */
const PRODUCTION_AUTH_KEYS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CALLBACK_URL', 'AUTH_SUCCESS_REDIRECT'] as const;
/** 이 중 URL인 값 — http(s) URL이어야 하고 루프백이면 안 된다 */
const PRODUCTION_AUTH_URL_KEYS = ['GOOGLE_CALLBACK_URL', 'AUTH_SUCCESS_REDIRECT'] as const;

/**
 * GOOGLE_CLIENT_ID / GOOGLE_CALLBACK_URL / AUTH_SUCCESS_REDIRECT — production에서 미설정·빈 값·URL 아님·루프백이면 기동 거부.
 * 예전엔 AUTH_SUCCESS_REDIRECT가 조용히 `http://localhost:3000/`으로 폴백해 로그인 완료 후 사용자를 **자기 기계의 localhost로**
 * 로그인 코드와 함께 보냈고, GOOGLE_CLIENT_ID가 비면 첫 로그인 요청에서야 500이 났다. railway.ts가 네 값(CORS 포함)을 공개값으로 넣는다.
 * 개발에서는 아무것도 하지 않는다 (fe-origins.ts가 로컬 FE로 폴백, google-oauth.flow.ts는 요청 시점에 GOOGLE_CLIENT_ID를 요구).
 */
export function requireProductionAuthUrls(env: BootstrapEnv): void {
  if (!isProduction(env)) return;
  const missing = PRODUCTION_AUTH_KEYS.filter((key) => !env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(`FATAL: ${missing.join(', ')} must be set in production (public values in .railway/railway.ts — run \`railway config apply\`)`);
  }
  for (const key of PRODUCTION_AUTH_URL_KEYS) {
    const value = env[key]!.trim();
    const isHttpUrl = URL.canParse(value) && ['http:', 'https:'].includes(new URL(value).protocol);
    if (!isHttpUrl || isLoopbackUrl(value)) {
      throw new Error(`FATAL: ${key}=${JSON.stringify(env[key])} — must be a public http(s) URL in production (not localhost/127.x)`);
    }
  }
}
