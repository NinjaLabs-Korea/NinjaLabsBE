// scripts/migrate.js의 타입 선언 — src/test-db(실 DB 통합 테스트)가 같은 applyMigrations()를 쓴다.
import type { Pool } from 'pg';

export declare const MIGRATIONS_DIR: string;
export declare function migrationFiles(dir?: string): string[];
export declare function sslOptions(
  env: Record<string, string | undefined>,
): { ca: string[]; rejectUnauthorized: true } | { rejectUnauthorized: false } | undefined;
export declare function applyMigrations(
  pool: Pool,
  options?: { dir?: string; log?: (line: string) => void },
): Promise<{ applied: string[]; skipped: string[] }>;
