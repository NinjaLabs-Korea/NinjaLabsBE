import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * 정적 가드 — public 스키마의 모든 테이블은 RLS가 켜져 있어야 한다 (supabase/migrations/0017_enable_rls.sql 머리 주석).
 * Supabase는 public 테이블을 anon 키로 읽고 쓰는 Data API로 노출한다 — RLS 없는 테이블은 곧 공개 테이블이다.
 * CREATE TABLE이 있는 마이그레이션 묶음 어디선가 같은 테이블에 `ENABLE ROW LEVEL SECURITY`가 있어야 한다.
 */
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'supabase', 'migrations');
const sql = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
  .map((file) => readFileSync(join(MIGRATIONS_DIR, file), 'utf8').replace(/--[^\n]*/g, '')).join('\n');

const name = (raw: string) => raw.replace(/"/g, '').toLowerCase();
const created = [...sql.matchAll(/CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("?\w+"?)/gi)].map((m) => name(m[1]));
const secured = new Set([...sql.matchAll(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?("?\w+"?)\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi)].map((m) => name(m[1])));

describe('row level security coverage', () => {
  it('finds the tables (guards against the regexes silently matching nothing)', () => {
    expect(created.length).toBeGreaterThanOrEqual(25);
    expect(created).toEqual(expect.arrayContaining(['user', 'auth_session', 'agent_api_key', 'throttler_storage']));
  });

  it('enables RLS on every table a migration creates', () => {
    expect(created.filter((table) => !secured.has(table))).toEqual([]);
  });

  it('enables RLS on the runner-created _migrations table too', () => {
    expect(secured.has('_migrations')).toBe(true);
  });
});
