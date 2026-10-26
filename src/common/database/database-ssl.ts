import { rootCertificates } from 'tls';

/**
 * pg Pool의 ssl 옵션 — database.service.ts와 scripts/migrate.js가 같은 규칙을 쓴다 (JS 쪽은 복제본).
 *
 *   PGSSLMODE=disable        → TLS 없음 (로컬 Postgres)
 *   DATABASE_CA_CERT=<PEM>   → Supabase CA로 서버 인증서 검증 (MITM 차단). 줄바꿈은 실제 개행 또는 `\n` 이스케이프 모두 허용
 *   그 외                     → TLS는 쓰되 인증서 검증 생략 (기존 동작). production이면 기동 거부(`assertDbTlsVerifiedInProduction`): docs/security.md
 *
 * 커스텀 `ca`는 Node 루트 저장소를 "대체"하므로 Supabase CA만 넣으면 공인 인증서를 쓰는 풀러
 * (`*.pooler.supabase.com`)가 거부된다 — 루트 인증서 뒤에 커스텀 CA를 덧붙여 둘 다 통하게 한다.
 */
export type DatabaseSslOptions = { ca: string[]; rejectUnauthorized: true } | { rejectUnauthorized: false } | undefined;

export function databaseSslOptions(env: {
  PGSSLMODE?: string;
  DATABASE_CA_CERT?: string;
}): DatabaseSslOptions {
  if (env.PGSSLMODE === 'disable') return undefined;
  const ca = env.DATABASE_CA_CERT?.replace(/\\n/g, '\n').trim();
  if (ca) return { ca: [...rootCertificates, ca], rejectUnauthorized: true };
  return { rejectUnauthorized: false };
}

/** production에서 TLS는 켜져 있는데 CA가 없어 서버 인증서를 검증하지 않는 상태인가 */
export function dbTlsUnverifiedInProduction(env: { NODE_ENV?: string; PGSSLMODE?: string; DATABASE_CA_CERT?: string }): boolean {
  return env.NODE_ENV === 'production' && env.PGSSLMODE !== 'disable' && !env.DATABASE_CA_CERT?.trim();
}

/** 위 상태의 기동 거부 문구: scripts/migrate.js에 같은 문구의 복제본이 있다 (스펙이 동일성을 확인) */
export const DB_TLS_UNVERIFIED_MESSAGE =
  'FATAL: DATABASE_CA_CERT is empty in production: the Postgres server certificate would NOT be verified (rejectUnauthorized: false), so a network attacker between this service and the database could read and alter all traffic. ' +
  'Set DATABASE_CA_CERT to the Supabase CA PEM (or PGSSLMODE=disable only for a Postgres without TLS).';

/** production + TLS 켜짐 + CA 없음이면 기동 거부 (DatabaseService 생성자). 다른 환경은 아무것도 하지 않는다 */
export function assertDbTlsVerifiedInProduction(env: { NODE_ENV?: string; PGSSLMODE?: string; DATABASE_CA_CERT?: string }): void {
  if (dbTlsUnverifiedInProduction(env)) throw new Error(DB_TLS_UNVERIFIED_MESSAGE);
}
