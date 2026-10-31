import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'supabase', 'migrations');

/**
 * 유닛 스펙용 - 마이그레이션의 `CREATE TABLE <table> (` 안에서 `status ... CHECK (status IN (...))` 값 목록을 꺼낸다.
 * 상태 정책 파일(bounties/*-status.ts)의 값 집합이 DB CHECK와 같은지 검사하는 데 쓴다.
 * 이후 마이그레이션이 같은 테이블의 status CHECK를 바꾸면(ALTER ... CHECK) 이 헬퍼가 그걸 읽지 못하므로 던진다 - 그때 헬퍼를 고친다.
 */
export function statusCheckValues(table: string): string[] {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  let found: string[] | undefined;
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const altered = new RegExp(`ALTER\\s+TABLE\\s+${table}\\b[^;]*\\bstatus\\b[^;]*\\bCHECK\\b`, 'i');
    if (altered.test(sql)) throw new Error(`${file} alters ${table}.status CHECK - teach statusCheckValues() to follow it`);
    const create = new RegExp(`CREATE\\s+TABLE\\s+${table}\\s*\\(([\\s\\S]*?)\\n\\);`, 'i').exec(sql);
    if (!create) continue;
    const check = /\bstatus\b[^,]*?CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)/i.exec(create[1]);
    if (!check) throw new Error(`${file}: no status CHECK in CREATE TABLE ${table}`);
    found = [...check[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  }
  if (!found) throw new Error(`CREATE TABLE ${table} not found in supabase/migrations`);
  return found;
}
