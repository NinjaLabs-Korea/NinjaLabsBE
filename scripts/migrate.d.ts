// scripts/migrate.js의 타입 선언 — src/test-db(실 DB 통합 테스트)가 같은 applyMigrations()를 쓴다.
import type { Pool } from 'pg';

export declare const MIGRATIONS_DIR: string;
/** applyMigrations()가 실행 전체에 잡는 pg_advisory_lock 키 (bigint 문자열) */
export declare const MIGRATION_LOCK_KEY: string;
export declare function migrationFiles(dir?: string): string[];
export declare function sslOptions(
  env: Record<string, string | undefined>,
): { ca: string[]; rejectUnauthorized: true } | { rejectUnauthorized: false } | undefined;
export declare function applyMigrations(
  pool: Pool,
  options?: { dir?: string; log?: (line: string) => void },
): Promise<{ applied: string[]; skipped: string[] }>;
/** preDeploy 마이그레이션 실패 운영 알림 (OPS_ALERT_WEBHOOK_URL 없으면 아무것도 안 함). throw하지 않는다 */
export declare function alertMigrationFailure(env: Record<string, string | undefined>, err: unknown): Promise<void>;
