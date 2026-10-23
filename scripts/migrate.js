#!/usr/bin/env node
/**
 * 단순 마이그레이션 러너 — supabase/migrations/*.sql을 순서대로 실행한다.
 *
 * Supabase CLI(supabase db push)를 쓸 수 있으면 그쪽을 권장.
 * 이 스크립트는 CLI 없이 DATABASE_URL만으로 돌릴 수 있는 대안이다.
 *
 * 사용법: DATABASE_URL=postgresql://... npm run migrate
 * 적용된 파일은 _migrations 테이블에 기록되어 중복 실행되지 않는다.
 *
 * applyMigrations()는 실 DB 통합 테스트(src/test-db, `npm run test:db`)가 그대로 가져다 쓴다 —
 * 테스트가 적용하는 스키마와 운영이 적용하는 스키마가 같은 코드 경로를 지나도록.
 */
const { readdirSync, readFileSync } = require('fs');
const { join } = require('path');
const { rootCertificates } = require('tls');

const MIGRATIONS_DIR = join(__dirname, '..', 'supabase', 'migrations');

// src/common/database/database-ssl.ts와 같은 규칙 (TS를 못 불러오므로 복제)
// 커스텀 ca는 Node 루트 저장소를 대체하므로 루트 인증서 뒤에 덧붙인다 (공인 인증서를 쓰는 *.pooler.supabase.com도 통과)
function sslOptions(env) {
  if (env.PGSSLMODE === 'disable') return undefined;
  const ca = (env.DATABASE_CA_CERT || '').replace(/\\n/g, '\n').trim();
  if (ca) return { ca: [...rootCertificates, ca], rejectUnauthorized: true };
  return { rejectUnauthorized: false };
}

/** 적용 순서대로 정렬된 마이그레이션 파일 이름 */
function migrationFiles(dir = MIGRATIONS_DIR) {
  return readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
}

/**
 * 아직 적용되지 않은 마이그레이션을 순서대로 적용한다. 파일 하나가 트랜잭션 하나.
 * 실패하면 그 파일을 롤백하고 `{ file }`을 붙인 에러를 던진다 (CLI는 exit 1, 테스트는 실패).
 * @param {import('pg').Pool} pool
 * @param {{ dir?: string, log?: (line: string) => void }} [options]
 * @returns {Promise<{ applied: string[], skipped: string[] }>}
 */
async function applyMigrations(pool, options = {}) {
  const dir = options.dir || MIGRATIONS_DIR;
  const log = options.log || (() => {});
  await pool.query(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

  const applied = [];
  const skipped = [];
  for (const file of migrationFiles(dir)) {
    const done = await pool.query('SELECT 1 FROM _migrations WHERE name = $1', [file]);
    if (done.rowCount) {
      log(`skip  ${file}`);
      skipped.push(file);
      continue;
    }
    const sql = readFileSync(join(dir, file), 'utf8');
    const client = await pool.connect();
    // 마이그레이션 안의 RAISE NOTICE를 운영자가 볼 수 있게 (조건부 DO 블록이 무엇을 했는지 등). 풀 클라이언트는 재사용되므로 끝나면 떼어낸다
    const onNotice = (n) => log(`[notice] ${n.message}`);
    client.on('notice', onNotice);
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      log(`apply ${file}`);
      applied.push(file);
    } catch (err) {
      await client.query('ROLLBACK');
      err.file = file;
      throw err;
    } finally {
      client.off('notice', onNotice);
      client.release();
    }
  }
  return { applied, skipped };
}

async function main() {
  // NestJS 밖에서 단독 실행되므로 .env를 직접 로드한다
  require('dotenv').config({ path: join(__dirname, '..', '.env') });
  const { Pool } = require('pg');
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: url, ssl: sslOptions(process.env) });
  try {
    await applyMigrations(pool, { log: console.log });
  } catch (err) {
    console.error(`FAIL  ${err.file || ''}\n`, err.message);
    if (err.hint) console.error('HINT ', err.hint);
    process.exit(1);
  }
  await pool.end();
  console.log('done');
}

module.exports = { applyMigrations, migrationFiles, sslOptions, MIGRATIONS_DIR };

if (require.main === module) main();
