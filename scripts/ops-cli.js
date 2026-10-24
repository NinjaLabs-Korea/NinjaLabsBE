/**
 * 운영 스크립트(scripts/grant-admin.js, scripts/requeue-nft-jobs.js) 공용 — 접속, 인자, 확인 프롬프트.
 *
 * 접속은 scripts/migrate.js와 같은 규칙이다: DATABASE_URL + sslOptions()(DATABASE_CA_CERT가 있으면 인증서 검증, PGSSLMODE=disable이면 TLS 끔).
 * 운영 DB에 붙을 때는 Railway 변수와 같은 DATABASE_URL / DATABASE_CA_CERT를 셸에 넣고 실행한다 (docs/runbook.md "운영 스크립트").
 */
const { join } = require('path');
const { createInterface } = require('readline');
const { sslOptions } = require('./migrate');

/** 레포 루트 .env를 읽는다 (이미 셸에 있는 값은 덮어쓰지 않는다 — dotenv 기본 동작) */
function loadDotEnv() {
  require('dotenv').config({ path: join(__dirname, '..', '.env') });
}

/** DATABASE_URL → pg Pool (max 1). 없으면 throw */
function createPool(env = process.env) {
  const { Pool } = require('pg');
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  return new Pool({ connectionString: env.DATABASE_URL, ssl: sslOptions(env), max: 1 });
}

/**
 * `--flag`는 flags에, 나머지는 positional에. 모르는 플래그는 throw (오타 난 `--dry-rn`이 실제 변경으로 이어지지 않게).
 * @param {string[]} argv
 * @param {string[]} known 허용 플래그 (`--` 없이)
 */
function parseArgs(argv, known) {
  const flags = {};
  const positional = [];
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (!known.includes(name)) throw new Error(`unknown option: ${arg}`);
      flags[name] = true;
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

/**
 * 터미널에서 정확히 `yes`를 입력해야 true. 표준 입력이 TTY가 아니면(파이프/CI) 묻지 않고 false — 비대화형 실행은 `--yes`를 명시한다.
 * @param {string} question
 */
async function promptYes(question) {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise((resolve) => rl.question(`${question} Type "yes" to continue: `, resolve));
    return String(answer).trim() === 'yes';
  } finally {
    rl.close();
  }
}

/** 운영자에게 그대로 보여 줄 예상된 실패 (exit 1) — 그 밖의 에러는 FAIL로 출력된다 */
class OpsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `if (require.main === module) runCli(run)` — .env 로드 → Pool → run(argv, { pool }) → 종료 코드로 exit.
 * 예상된 실패는 run()이 코드로 돌려주고(1/2), 그 밖의 예외는 FAIL 한 줄과 exit 1.
 */
async function runCli(run) {
  loadDotEnv();
  let pool;
  try {
    pool = createPool(process.env);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  let code = 1;
  try {
    code = await run(process.argv.slice(2), { pool });
  } catch (err) {
    console.error(`FAIL     ${err.message}`);
  } finally {
    await pool.end();
  }
  process.exit(code);
}

module.exports = { loadDotEnv, createPool, parseArgs, promptYes, runCli, OpsError, UUID_RE };
