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

/**
 * migrate/운영 스크립트용 pg Pool 타임아웃 — src/common/database/pool-timeouts.ts와 같은 DB_CONNECTION_TIMEOUT_MS 규칙(기본 5000, 잘못된 값은 기본값).
 * 블랙홀 DB에서 preDeploy가 무한히 매달리지 않고 실패(→ 배포 중단 + 알림)하게 한다.
 * statement_timeout / query_timeout은 **걸지 않는다** — 마이그레이션의 긴 DDL·백필, pg_advisory_lock 대기를 끊으면 안 된다.
 */
function poolTimeoutOptions(env) {
  const raw = String(env.DB_CONNECTION_TIMEOUT_MS || '').trim();
  const parsed = /^\d+$/.test(raw) ? Number(raw) : NaN;
  const connectionTimeoutMillis = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 5000;
  return { connectionTimeoutMillis, idleTimeoutMillis: 30000 };
}

/** 적용 순서대로 정렬된 마이그레이션 파일 이름 */
function migrationFiles(dir = MIGRATIONS_DIR) {
  return readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
}

/**
 * 마이그레이션 파일 안의 최상위 트랜잭션 제어문 — applyMigrations()가 파일마다 BEGIN … COMMIT으로 감싸므로, 파일 안의 COMMIT 등은
 * 그 트랜잭션을 일찍 끝내 "파일 하나 = 원자적 적용"을 깨뜨린다 (앞부분 DDL은 남고 파일은 기록되지 않아 재실행이 자기 잔재에 걸린다).
 */
const TRANSACTION_CONTROL = new Set(['BEGIN', 'START', 'COMMIT', 'END', 'ROLLBACK']);

/**
 * SQL 텍스트에서 최상위 트랜잭션 제어문(`BEGIN`, `START TRANSACTION`, `COMMIT`, `END`, `ROLLBACK`)을 찾는다.
 * 문장 경계(`;`)는 최상위에서만 센다 — `--` 주석, `/* *\/` 주석(중첩 포함), '문자열'(E'…'의 백슬래시 이스케이프 포함), "식별자",
 * 달러 인용 본문(`$$ … $$`, `$tag$ … $tag$` — DO 블록·함수 본문의 BEGIN … END)은 건너뛴다.
 * SQL 표준 함수 본문(`BEGIN ATOMIC … END`)은 문장 중간의 BEGIN ATOMIC부터 짝이 맞는 END까지 한 문장으로 본다 (안의 CASE … END 포함).
 * 각 문장의 첫 키워드만 본다: `START`는 다음 단어가 TRANSACTION일 때만.
 * @param {string} sql
 * @returns {{ line: number, keyword: string }[]}
 */
function findTransactionControl(sql) {
  const found = [];
  const n = sql.length;
  let i = 0;
  let line = 1;
  /** 현재 문장의 단어들 (첫 단어 판정 + BEGIN ATOMIC 추적용) */
  let words = [];
  let firstLine = 0;
  let atomicDepth = 0; // BEGIN ATOMIC 안의 CASE 중첩 + 1, 0이면 바깥
  const isIdent = (c) => c !== undefined && /[A-Za-z0-9_$\u0080-￿]/.test(c);
  const endStatement = () => {
    const first = (words[0] || '').toUpperCase();
    if (TRANSACTION_CONTROL.has(first) && (first !== 'START' || (words[1] || '').toUpperCase() === 'TRANSACTION')) {
      found.push({ line: firstLine, keyword: first === 'START' ? 'START TRANSACTION' : first });
    }
    words = [];
    atomicDepth = 0;
  };
  const advance = (to) => {
    for (; i < to && i < n; i++) if (sql[i] === '\n') line++;
  };
  const noteToken = (token) => {
    if (words.length === 0) firstLine = line;
    words.push(token);
  };

  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      const eol = sql.indexOf('\n', i);
      advance(eol === -1 ? n : eol);
    } else if (c === '/' && next === '*') {
      let depth = 0;
      let j = i;
      while (j < n) {
        if (sql[j] === '/' && sql[j + 1] === '*') { depth++; j += 2; }
        else if (sql[j] === '*' && sql[j + 1] === '/') { depth--; j += 2; if (depth === 0) break; }
        else j++;
      }
      advance(j);
    } else if (c === "'") {
      const escapes = (sql[i - 1] === 'E' || sql[i - 1] === 'e') && !isIdent(sql[i - 2]);
      let j = i + 1;
      while (j < n) {
        if (escapes && sql[j] === '\\') { j += 2; continue; }
        if (sql[j] === "'") { if (sql[j + 1] === "'") { j += 2; continue; } j++; break; }
        j++;
      }
      noteToken("'");
      advance(j);
    } else if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '"') { if (sql[j + 1] === '"') { j += 2; continue; } j++; break; }
        j++;
      }
      noteToken('"');
      advance(j);
    } else if (c === '$' && !isIdent(sql[i - 1]) && /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.test(sql.slice(i, i + 64))) {
      const tag = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(sql.slice(i, i + 64))[0];
      const close = sql.indexOf(tag, i + tag.length);
      noteToken('$$');
      advance(close === -1 ? n : close + tag.length);
    } else if (/[A-Za-z_\u0080-￿]/.test(c)) {
      let j = i;
      while (j < n && isIdent(sql[j])) j++;
      const word = sql.slice(i, j);
      const upper = word.toUpperCase();
      if (atomicDepth > 0) {
        if (upper === 'CASE') atomicDepth++;
        else if (upper === 'END') atomicDepth--;
      } else if (upper === 'ATOMIC' && words.length > 1 && words[words.length - 1].toUpperCase() === 'BEGIN') {
        atomicDepth = 1;
      }
      noteToken(word);
      advance(j);
    } else if (c === ';') {
      if (atomicDepth > 0) advance(i + 1);
      else { endStatement(); advance(i + 1); }
    } else {
      if (!/\s/.test(c)) noteToken(c);
      advance(i + 1);
    }
  }
  endStatement();
  return found;
}

/**
 * 모든 마이그레이션 파일을 실행 전에 검사한다 — 하나라도 최상위 트랜잭션 제어문이 있으면 아무것도 실행/기록하지 않고 던진다.
 * 이미 적용된 파일도 검사한다 (어느 파일이든 나쁘면 실행 전체 중단). 에러에는 `file`, `line`이 붙는다.
 * @param {string} [dir]
 */
function assertNoTransactionControl(dir = MIGRATIONS_DIR) {
  const problems = [];
  for (const file of migrationFiles(dir)) {
    for (const hit of findTransactionControl(readFileSync(join(dir, file), 'utf8'))) problems.push({ file, ...hit });
  }
  if (!problems.length) return;
  const err = new Error(
    `migration files must not contain top-level transaction control (the runner wraps each file in its own transaction): ${problems
      .map((p) => `${p.file}:${p.line} ${p.keyword}`)
      .join(', ')}`,
  );
  err.file = problems[0].file;
  err.line = problems[0].line;
  err.problems = problems;
  throw err;
}

/**
 * 마이그레이션 실행 전체를 감싸는 세션 수준 advisory lock 키 (임의의 고정 상수 — 다른 advisory lock 용도와 겹치지 않게 큰 값).
 * 두 배포(예: Railway preDeploy가 겹친 경우)가 동시에 migrate하면 둘 다 `_migrations`에서 같은 파일을 "미적용"으로 보고 같은 DDL을 두 번 돌린다 —
 * 하나는 실패하고 배포가 깨진다. 락을 잡은 쪽이 끝날 때까지 다른 쪽은 기다렸다가, 이미 적용된 파일을 skip한다.
 */
const MIGRATION_LOCK_KEY = '7242031118431903';

/**
 * 아직 적용되지 않은 마이그레이션을 순서대로 적용한다. 파일 하나가 트랜잭션 하나.
 * 먼저 모든 파일을 assertNoTransactionControl()로 검사한다 — 최상위 BEGIN/COMMIT 등이 있는 파일이 하나라도 있으면 DB에 붙기 전에 던진다
 * (아무것도 실행하지 않고 `_migrations`에도 기록하지 않는다).
 * 실행 전체를 한 클라이언트(세션)에서 `pg_advisory_lock(MIGRATION_LOCK_KEY)`로 직렬화하고 finally에서 푼다 — 실패해도 락은 남지 않는다
 * (세션 락이라 프로세스가 죽어 연결이 끊겨도 Postgres가 푼다). 한 클라이언트만 쓰므로 `max: 1` 풀에서도 동작한다.
 * 실패하면 그 파일을 롤백하고 `{ file }`을 붙인 에러를 던진다 (CLI는 exit 1, 테스트는 실패).
 * @param {import('pg').Pool} pool
 * @param {{ dir?: string, log?: (line: string) => void }} [options]
 * @returns {Promise<{ applied: string[], skipped: string[] }>}
 */
async function applyMigrations(pool, options = {}) {
  const dir = options.dir || MIGRATIONS_DIR;
  const log = options.log || (() => {});
  assertNoTransactionControl(dir);
  const client = await pool.connect();
  // 마이그레이션 안의 RAISE NOTICE를 운영자가 볼 수 있게 (조건부 DO 블록이 무엇을 했는지 등). 풀 클라이언트는 재사용되므로 끝나면 떼어낸다
  const onNotice = (n) => log(`[notice] ${n.message}`);
  client.on('notice', onNotice);
  let locked = false;
  try {
    const free = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS ok', [MIGRATION_LOCK_KEY]);
    if (!free.rows[0].ok) {
      log('wait  another migration run holds the lock');
      await client.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_LOCK_KEY]);
    }
    locked = true;

    await client.query(`CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

    const applied = [];
    const skipped = [];
    for (const file of migrationFiles(dir)) {
      const done = await client.query('SELECT 1 FROM _migrations WHERE name = $1', [file]);
      if (done.rowCount) {
        log(`skip  ${file}`);
        skipped.push(file);
        continue;
      }
      const sql = readFileSync(join(dir, file), 'utf8');
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
      }
    }
    return { applied, skipped };
  } finally {
    try {
      if (locked) await client.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_KEY]);
    } finally {
      client.off('notice', onNotice);
      client.release();
    }
  }
}

/**
 * preDeploy 마이그레이션 실패 운영 알림 — OPS_ALERT_WEBHOOK_URL이 있으면 한 번 보낸다 (최대 5초).
 * 웹훅이 없거나 닿지 않으면 로그만 남긴다. 절대 throw하지 않는다 (scripts/ops-alert.js).
 */
async function alertMigrationFailure(env, err) {
  const { postOpsAlert, webhookStatus } = require('./ops-alert');
  if (webhookStatus(env.OPS_ALERT_WEBHOOK_URL) !== 'ok') return;
  const environment = env.RAILWAY_ENVIRONMENT_NAME || env.NODE_ENV || 'development';
  const detail = String((err && err.message) || err).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500);
  const result = await postOpsAlert(
    env.OPS_ALERT_WEBHOOK_URL,
    `[NinjaLabs ${environment}] migration-failure: npm run migrate failed${err && err.file ? ` at ${err.file}` : ''} — deploy aborted, previous version keeps serving: ${detail}`,
  );
  if (!result.ok) console.error(`ops alert webhook unreachable for migration failure: ${result.reason}`);
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
  const pool = new Pool({ connectionString: url, ssl: sslOptions(process.env), ...poolTimeoutOptions(process.env) });
  try {
    await applyMigrations(pool, { log: console.log });
  } catch (err) {
    console.error(`FAIL  ${err.file || ''}${err.line ? `:${err.line}` : ''}\n`, err.message);
    if (err.hint) console.error('HINT ', err.hint);
    await alertMigrationFailure(process.env, err);
    process.exit(1);
  }
  await pool.end();
  console.log('done');
}

module.exports = { alertMigrationFailure, applyMigrations, assertNoTransactionControl, findTransactionControl, migrationFiles, poolTimeoutOptions, sslOptions, MIGRATIONS_DIR, MIGRATION_LOCK_KEY };

if (require.main === module) main();
