/**
 * JWT_REFRESH_TTL(refresh 세션 수명) 해석의 단일 출처 — 순수 함수만 둔다 (DB/Nest 의존 없음).
 *
 * 여기를 고치는 경우:
 *   - 받을 단위를 늘리거나 줄일 때 → REFRESH_TTL 정규식과 REFRESH_TTL_UNITS 표를 **함께** 고친다.
 *   - 허용 범위를 바꿀 때 → MIN_REFRESH_TTL_SECONDS / MAX_REFRESH_TTL_SECONDS (에러 메시지의 "90 days"도 같이).
 * 쓰는 곳: AuthService 생성자(부팅 시 검증 → auth_session.expires_at interval), refresh 쿠키 Max-Age(session-cookie.ts 경유).
 * 규칙은 refresh-ttl.spec.ts가 문서 역할을 한다.
 */

/**
 * JWT_REFRESH_TTL 문법 — `<정수>[공백]<단위>`. 단위는 아래 표의 것만 받고 Postgres interval 단위로 정규화한다.
 * `m`은 항상 분(minutes)이다 (월이 아님) — Postgres가 `15m`을 분으로 해석하긴 하지만 명시적으로 고정한다.
 */
const REFRESH_TTL = /^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)$/;
const REFRESH_TTL_UNITS: Record<string, string> = {
  s: 'seconds', sec: 'seconds', secs: 'seconds', second: 'seconds', seconds: 'seconds',
  m: 'minutes', min: 'minutes', mins: 'minutes', minute: 'minutes', minutes: 'minutes',
  h: 'hours', hr: 'hours', hrs: 'hours', hour: 'hours', hours: 'hours',
  d: 'days', day: 'days', days: 'days',
  w: 'weeks', week: 'weeks', weeks: 'weeks',
};

const REFRESH_TTL_SECONDS: Record<string, number> = { seconds: 1, minutes: 60, hours: 3_600, days: 86_400, weeks: 604_800 };
/** refresh 수명 허용 범위 — 60초 미만은 access 토큰보다 짧아 로그인이 즉시 풀리고, 90일 초과는 탈취 토큰의 수명이 너무 길다 */
export const MIN_REFRESH_TTL_SECONDS = 60;
export const MAX_REFRESH_TTL_SECONDS = 90 * 86_400;

/**
 * `14d` → `'14 days'`, `15m` → `'15 minutes'`. 문법에 맞지 않거나 0 / 60초 미만 / 90일 초과면 throw (부팅 시 fail-fast).
 */
export function normalizeRefreshTtl(raw: string | undefined): string {
  const ttl = (raw ?? '14d').trim();
  const match = REFRESH_TTL.exec(ttl);
  if (!match) {
    throw new Error(
      `JWT_REFRESH_TTL must be "<integer> <unit>" with unit s/m/h/d/w or their long forms (e.g. 14d, 15m, 2 weeks), got "${ttl}"`,
    );
  }
  const amount = Number(match[1]);
  const unit = REFRESH_TTL_UNITS[match[2]];
  const seconds = amount * REFRESH_TTL_SECONDS[unit];
  if (seconds < MIN_REFRESH_TTL_SECONDS || seconds > MAX_REFRESH_TTL_SECONDS) {
    throw new Error(
      `JWT_REFRESH_TTL must be between ${MIN_REFRESH_TTL_SECONDS} seconds and 90 days (got "${ttl}" = ${seconds} seconds)`,
    );
  }
  return `${amount} ${unit}`;
}

/** normalizeRefreshTtl의 결과(`'14 days'`) → 초. refresh 쿠키의 Max-Age (auth/session-cookie.ts) */
export function refreshTtlSeconds(normalized: string): number {
  const [amount, unit] = normalized.split(' ');
  const perUnit = REFRESH_TTL_SECONDS[unit];
  if (!perUnit || !/^\d+$/.test(amount)) throw new Error(`not a normalized refresh TTL: "${normalized}"`);
  return Number(amount) * perUnit;
}
