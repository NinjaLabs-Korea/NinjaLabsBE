#!/usr/bin/env node
/* global process, console */
/**
 * 돈 경로 SQL 표적 뮤테이션 - `TEST_DATABASE_URL=... npm run test:mutation:sql [-- --concurrency 2] [-- --only R1,M3]`
 *
 * Stryker(stryker.config.mjs)는 TS/JS 연산자와 리터럴을 바꾸지만 SQL 문자열 안의 조건(`>` 대 `>=`, `IN` 대 `NOT IN`, 빠진 술어,
 * 상태 집합의 원소 하나)은 바꾸지 않는다. 문자열 전체를 비우는 변형은 모든 쿼리를 깨뜨려 너무 쉽게 죽는다.
 * 그래서 mutation/sql-mutants.mjs의 변형(파일, 바꿀 원문, 바꿀 값)을 하나씩 적용하고 jest.mutation.config.js(단위 + 실DB)를 돌려
 * 테스트가 실패하면 killed, 통과하면 survived로 센다.
 *
 * 작업 사본: .mutation-tmp/w<n>/ (레포 사본, node_modules는 심볼릭 링크). 각 jest 실행은 test:db global-setup이 DB를 새로 만들고 지운다.
 * 결과: reports/mutation/sql-mutants.json + 표 출력. 원문이 정확히 한 번 나오지 않으면 그 변형은 STALE(코드가 바뀌었으니 목록을 고친다).
 * CI에는 붙이지 않는다. 동시성은 코어 수의 절반 이하로.
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MUTANTS } from './sql-mutants.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = join(ROOT, '.mutation-tmp');
const SKIP = new Set(['node_modules', '.git', '.stryker-tmp', '.mutation-tmp', 'reports', 'dist', 'coverage']);

function option(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

if (!process.env.TEST_DATABASE_URL) {
  console.error('TEST_DATABASE_URL is required (a Postgres the user may CREATE DATABASE on - see docs/testing in the wiki)');
  process.exit(2);
}
const concurrency = Math.max(1, Number(option('concurrency', '2')));
const only = option('only', '');
const selected = only ? MUTANTS.filter((m) => only.split(',').includes(m.id)) : MUTANTS;

const ids = new Set();
for (const m of MUTANTS) {
  if (ids.has(m.id)) throw new Error(`duplicate mutant id ${m.id}`);
  ids.add(m.id);
}

function workspace(n) {
  const dir = join(TMP, `w${n}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // 사본이 레포 안(.mutation-tmp)에 있어 레포 전체를 한 번에 복사할 수 없다 - 최상위 항목을 하나씩
  for (const entry of readdirSync(ROOT)) {
    if (!SKIP.has(entry)) cpSync(join(ROOT, entry), join(dir, entry), { recursive: true });
  }
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

function runJest(dir) {
  return new Promise((resolve) => {
    const child = spawn('npx', ['jest', '-c', 'jest.mutation.config.js', '--bail', '--silent', '--ci'], {
      cwd: dir, env: { ...process.env, CI: '' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

function firstFailure(out) {
  const m = /●\s+(.+)/.exec(out);
  return m ? m[1].trim().slice(0, 160) : '';
}

async function worker(n, queue, results) {
  const dir = workspace(n);
  for (let m = queue.shift(); m; m = queue.shift()) {
    const file = join(dir, m.file);
    const original = readFileSync(join(ROOT, m.file), 'utf8');
    const count = original.split(m.from).length - 1;
    if (count !== 1) {
      results.push({ ...m, status: 'STALE', detail: `original text found ${count} times` });
      console.log(`${m.id.padEnd(5)} STALE    (${count} matches) ${m.why}`);
      continue;
    }
    writeFileSync(file, original.replace(m.from, m.to));
    const started = Date.now();
    const { code, out } = await runJest(dir);
    writeFileSync(file, original);
    const status = code === 0 ? 'SURVIVED' : 'KILLED';
    const detail = code === 0 ? '' : firstFailure(out);
    results.push({ ...m, status, detail, seconds: Math.round((Date.now() - started) / 1000) });
    console.log(`${m.id.padEnd(5)} ${status.padEnd(8)} ${m.why}${detail ? `  <- ${detail}` : ''}`);
  }
}

const queue = [...selected];
const results = [];
await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, (_, n) => worker(n, queue, results)));
rmSync(TMP, { recursive: true, force: true });

results.sort((a, b) => MUTANTS.indexOf(MUTANTS.find((m) => m.id === a.id)) - MUTANTS.indexOf(MUTANTS.find((m) => m.id === b.id)));
mkdirSync(join(ROOT, 'reports', 'mutation'), { recursive: true });
writeFileSync(join(ROOT, 'reports', 'mutation', 'sql-mutants.json'), JSON.stringify(results, null, 2));

const byFile = new Map();
for (const r of results) {
  const row = byFile.get(r.file) || { killed: 0, survived: 0, equivalent: 0, stale: 0 };
  if (r.status === 'KILLED') row.killed++;
  else if (r.status === 'STALE') row.stale++;
  else if (r.equivalent) row.equivalent++;
  else row.survived++;
  byFile.set(r.file, row);
}
console.log('\nfile                                              killed survived equivalent stale  score');
for (const [file, r] of byFile) {
  const scored = r.killed + r.survived;
  console.log(`${file.padEnd(50)}${String(r.killed).padStart(6)}${String(r.survived).padStart(9)}${String(r.equivalent).padStart(11)}${String(r.stale).padStart(6)}  ${scored ? ((100 * r.killed) / scored).toFixed(1) : '-'}%`);
}
const survivors = results.filter((r) => r.status === 'SURVIVED' && !r.equivalent);
if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
process.exit(results.some((r) => r.status === 'STALE') || survivors.length ? 1 : 0);
