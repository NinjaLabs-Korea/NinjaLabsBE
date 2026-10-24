#!/usr/bin/env node
/**
 * 운영자 권한(is_admin) 부여/회수 — 이메일로 유저를 찾는다.
 *
 *   node scripts/grant-admin.js grant  <email> [--dry-run] [--yes]
 *   node scripts/grant-admin.js revoke <email> [--dry-run] [--yes] [--force]
 *
 *   --dry-run  대상과 변경 내용만 출력하고 아무것도 쓰지 않는다
 *   --yes      확인 프롬프트를 건너뛴다 (비대화형 실행은 필수 — TTY가 아니면 프롬프트는 항상 "no")
 *   --force    revoke로 활성 운영자가 0명이 되는 것을 허용한다
 *
 * 대상은 Google 로그인을 한 번 마친(= "user" 행이 있는) 미탈퇴 유저다. 이메일은 대소문자를 무시하고 비교한다.
 * 변경과 감사 행(audit_log: actor_user_id NULL, action ADMIN_GRANTED / ADMIN_REVOKED, entity_type 'user')은 한 트랜잭션이다.
 * 이미 원하는 상태면 아무것도 쓰지 않는다 (감사 행도 없음).
 *
 * 효과가 나타나는 시점: AdminGuard가 매 요청 DB를 다시 보므로 **회수는 즉시**. 부여는 JWT의 adm 클레임이 필요하므로
 * 대상자의 다음 /auth/refresh(최대 15분) 또는 재로그인부터 (docs/runbook.md "어드민 부트스트랩").
 * 접속: DATABASE_URL (+ DATABASE_CA_CERT / PGSSLMODE) — scripts/migrate.js와 같은 규칙 (scripts/ops-cli.js).
 */
const { OpsError, parseArgs, promptYes, runCli } = require('./ops-cli');

const SOURCE = 'scripts/grant-admin.js';
const USAGE = 'usage: node scripts/grant-admin.js <grant|revoke> <email> [--dry-run] [--yes] [--force]';

/** 미탈퇴 유저를 이메일(대소문자 무시)로 찾는다. 0명/2명 이상이면 OpsError */
async function findUserByEmail(runner, email, lock = false) {
  const r = await runner.query(
    `SELECT id, email, nickname, status, is_admin
       FROM "user"
      WHERE lower(email) = lower($1) AND deleted_at IS NULL
      ${lock ? 'FOR UPDATE' : ''}`,
    [email],
  );
  if (r.rowCount === 0) {
    throw new OpsError('USER_NOT_FOUND', `no active user with email ${email} — the person must sign in with Google once first`);
  }
  if (r.rowCount > 1) {
    throw new OpsError('AMBIGUOUS_EMAIL', `${r.rowCount} active users match ${email} case-insensitively — fix the data before granting`);
  }
  return r.rows[0];
}

/** user를 뺀 활성(ACTIVE, 미탈퇴) 운영자 수 — AdminGuard가 받아 주는 운영자만 센다 */
async function countOtherActiveAdmins(runner, userId) {
  const r = await runner.query(
    `SELECT count(*)::int AS n FROM "user"
      WHERE is_admin = true AND status = 'ACTIVE' AND deleted_at IS NULL AND id <> $1`,
    [userId],
  );
  return r.rows[0].n;
}

function lastAdminError(email) {
  return new OpsError('LAST_ADMIN', `${email} is the last active admin — pass --force to leave the platform with no admin`);
}

/**
 * 변경 적용 — 한 트랜잭션: 대상 행 FOR UPDATE → (revoke면) 다른 활성 운영자 수 확인 → UPDATE → 감사 행.
 * 동시에 두 revoke가 돌아 마지막 운영자 둘이 서로를 지우는 일을 막으려고 is_admin 행 전체를 먼저 잠근다.
 * @returns {Promise<{ changed: boolean, user: object }>}
 */
async function applyAdminChange(pool, { email, grant, force = false }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT id FROM "user" WHERE is_admin = true ORDER BY id FOR UPDATE`);
    const user = await findUserByEmail(client, email, true);
    if (user.is_admin === grant) {
      await client.query('ROLLBACK');
      return { changed: false, user };
    }
    if (!grant && !force && (await countOtherActiveAdmins(client, user.id)) === 0) throw lastAdminError(user.email);
    await client.query(`UPDATE "user" SET is_admin = $2 WHERE id = $1`, [user.id, grant]);
    await client.query(
      `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, before_data, after_data)
       VALUES (NULL, $1, 'user', $2, $3::jsonb, $4::jsonb)`,
      [
        grant ? 'ADMIN_GRANTED' : 'ADMIN_REVOKED',
        user.id,
        JSON.stringify({ is_admin: !grant }),
        JSON.stringify({ is_admin: grant, source: SOURCE }),
      ],
    );
    await client.query('COMMIT');
    return { changed: true, user: { ...user, is_admin: grant } };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * CLI 본체 — 테스트가 pool/prompt/log를 주입해 그대로 돌린다. 종료 코드를 돌려준다.
 * @param {string[]} argv process.argv.slice(2)
 * @param {{ pool: import('pg').Pool, prompt?: (q: string) => Promise<boolean>, log?: (line: string) => void }} deps
 */
async function run(argv, deps) {
  const log = deps.log || console.log;
  const prompt = deps.prompt || promptYes;
  let parsed;
  try {
    parsed = parseArgs(argv, ['dry-run', 'yes', 'force']);
  } catch (err) {
    log(`${err.message}\n${USAGE}`);
    return 2;
  }
  const [mode, email, ...rest] = parsed.positional;
  if (!['grant', 'revoke'].includes(mode) || !email || rest.length || !email.includes('@')) {
    log(USAGE);
    return 2;
  }
  const grant = mode === 'grant';
  const { flags } = parsed;

  try {
    const user = await findUserByEmail(deps.pool, email);
    log(`user     ${user.id}  ${user.email}  nickname=${user.nickname}  status=${user.status}  is_admin=${user.is_admin}`);
    if (user.is_admin === grant) {
      log(`no change — ${user.email} is already ${grant ? 'an admin' : 'not an admin'}`);
      return 0;
    }
    if (user.status !== 'ACTIVE') {
      log(`warning  status is ${user.status} — AdminGuard only admits ACTIVE users, so the flag has no effect until the account is ACTIVE`);
    }
    // 미리 보기에서도(그리고 확인을 묻기 전에) 마지막 운영자 회수를 알린다 — 실제 판정은 applyAdminChange가 잠금 아래에서 다시 한다
    if (!grant && !flags.force && (await countOtherActiveAdmins(deps.pool, user.id)) === 0) throw lastAdminError(user.email);
    log(`plan     is_admin ${!grant} -> ${grant}  (+ audit_log ${grant ? 'ADMIN_GRANTED' : 'ADMIN_REVOKED'}, actor NULL)`);
    if (flags['dry-run']) {
      log('dry-run  nothing written');
      return 0;
    }
    if (!flags.yes && !(await prompt(`${grant ? 'Grant' : 'Revoke'} admin for ${user.email}?`))) {
      log('aborted  nothing written (non-interactive runs need --yes)');
      return 1;
    }
    const result = await applyAdminChange(deps.pool, { email, grant, force: Boolean(flags.force) });
    if (!result.changed) {
      log(`no change — state changed concurrently, ${result.user.email} is already is_admin=${grant}`);
      return 0;
    }
    log(`done     ${result.user.email} is_admin=${grant}. ${grant
      ? 'Takes effect at their next token refresh (<= 15 min) or re-login.'
      : 'Admin routes reject them immediately (AdminGuard re-reads the DB).'}`);
    return 0;
  } catch (err) {
    if (err instanceof OpsError) {
      log(`error    ${err.code}: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

module.exports = { run, applyAdminChange, findUserByEmail, countOtherActiveAdmins };

if (require.main === module) runCli(run);
