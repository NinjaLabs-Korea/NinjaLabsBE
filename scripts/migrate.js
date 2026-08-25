#!/usr/bin/env node
/**
 * 단순 마이그레이션 러너 — supabase/migrations/*.sql을 순서대로 실행한다.
 *
 * Supabase CLI(supabase db push)를 쓸 수 있으면 그쪽을 권장.
 * 이 스크립트는 CLI 없이 DATABASE_URL만으로 돌릴 수 있는 대안이다.
 *
 * 사용법: DATABASE_URL=postgresql://... npm run migrate
 * 적용된 파일은 _migrations 테이블에 기록되어 중복 실행되지 않는다.
 */
const { readdirSync, readFileSync } = require('fs');
const { join } = require('path');
const { Pool } = require('pg');

// NestJS 밖에서 단독 실행되므로 .env를 직접 로드한다
require('dotenv').config({ path: join(__dirname, '..', '.env') });

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const pool = new Pool({
    connectionString: url,
    ssl: process.env.PGSSLMODE === 'disable' ? undefined : { rejectUnauthorized: false },
  });

  await pool.query(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

  const dir = join(__dirname, '..', 'supabase', 'migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    const done = await pool.query('SELECT 1 FROM _migrations WHERE name = $1', [file]);
    if (done.rowCount) {
      console.log(`skip  ${file}`);
      continue;
    }
    const sql = readFileSync(join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`apply ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`FAIL  ${file}\n`, err.message);
      process.exit(1);
    } finally {
      client.release();
    }
  }
  await pool.end();
  console.log('done');
}

main();
