import { rootCertificates } from 'tls';

/**
 * pg Pool의 ssl 옵션 — database.service.ts와 scripts/migrate.js가 같은 규칙을 쓴다 (JS 쪽은 복제본).
 *
 *   PGSSLMODE=disable        → TLS 없음 (로컬 Postgres)
 *   DATABASE_CA_CERT=<PEM>   → Supabase CA로 서버 인증서 검증 (MITM 차단). 줄바꿈은 실제 개행 또는 `\n` 이스케이프 모두 허용
 *   그 외                     → TLS는 쓰되 인증서 검증 생략 (기존 동작, 운영 전 CA 설정 권장 — docs/security.md)
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
