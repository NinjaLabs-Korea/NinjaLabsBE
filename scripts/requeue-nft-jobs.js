#!/usr/bin/env node
/**
 * FAILED nft_job 수동 재시도 — 워커(nft-job.worker.ts)가 5회 시도 끝에 FAILED로 고정한 잡을 PENDING으로 되돌린다.
 *
 *   node scripts/requeue-nft-jobs.js <job-id> [<job-id> ...] [--dry-run] [--yes]
 *   node scripts/requeue-nft-jobs.js --all [--dry-run] [--yes]
 *
 *   --dry-run  대상 잡만 출력하고 아무것도 쓰지 않는다
 *   --yes      확인 프롬프트를 건너뛴다 (비대화형 실행은 필수)
 *
 * 한 트랜잭션에서:
 *   - nft_job: status FAILED → PENDING, retry_count 0(새로 5회), scheduled_at now(), started_at/processed_at NULL. last_error는 남긴다
 *     (다음 시도가 덮어쓰고 성공하면 비운다 — 무엇 때문에 실패했는지 재시도 직전까지 보이게).
 *   - nft: 그 잡의 nft가 FAILED면 token_id가 있으면(민팅은 끝났고 attach가 실패) MINTED, 없으면 PENDING으로 되돌린다
 *     — 워커의 ATTACH 분기는 MINTED/ATTACHING만, MINT 분기는 MINTED/ATTACHED가 아니면 민팅하므로 두 경우 모두 다시 돈다.
 *   - audit_log: 잡마다 NFT_JOB_REQUEUED (actor NULL, entity_type 'nft_job').
 * FAILED가 아닌 잡 id는 건너뛰고 이유를 출력한다. 워커가 다음 1분 폴링에서 집는다.
 * 원인(컨트랙트/가스/니모닉/RPC)을 고치기 전에 돌리면 같은 이유로 다시 5회 실패한다 — docs/runbook.md "NFT 민팅 정체".
 * 접속: DATABASE_URL (+ DATABASE_CA_CERT / PGSSLMODE) — scripts/migrate.js와 같은 규칙 (scripts/ops-cli.js).
 */
const { parseArgs, promptYes, runCli, UUID_RE } = require('./ops-cli');

const USAGE = 'usage: node scripts/requeue-nft-jobs.js (<job-id>... | --all) [--dry-run] [--yes]';

/** 대상 FAILED 잡 조회. ids가 null이면 전부 */
async function findFailedJobs(runner, ids, lock = false) {
  const r = await runner.query(
    `SELECT j.id, j.nft_id, j.job_type, j.retry_count, j.last_error, j.processed_at, n.status AS nft_status
       FROM nft_job j JOIN nft n ON n.id = j.nft_id
      WHERE j.status = 'FAILED' AND ($1::uuid[] IS NULL OR j.id = ANY($1::uuid[]))
      ORDER BY j.processed_at NULLS FIRST, j.id
      ${lock ? 'FOR UPDATE OF j' : ''}`,
    [ids],
  );
  return r.rows;
}

/**
 * 재큐잉 적용 (한 트랜잭션). 잠근 뒤 다시 FAILED인 것만 처리하므로 그 사이 워커/다른 운영자가 바꾼 잡은 건드리지 않는다.
 * @returns {Promise<string[]>} 실제로 되돌린 잡 id
 */
async function requeueJobs(pool, ids) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const jobs = await findFailedJobs(client, ids, true);
    const jobIds = jobs.map((job) => job.id);
    if (jobIds.length) {
      await client.query(
        `UPDATE nft_job
            SET status = 'PENDING', retry_count = 0, scheduled_at = now(), started_at = NULL, processed_at = NULL
          WHERE id = ANY($1::uuid[]) AND status = 'FAILED'`,
        [jobIds],
      );
      await client.query(
        `UPDATE nft SET status = CASE WHEN token_id IS NOT NULL THEN 'MINTED' ELSE 'PENDING' END
          WHERE status = 'FAILED' AND id = ANY($1::uuid[])`,
        [[...new Set(jobs.map((job) => job.nft_id))]],
      );
      await client.query(
        `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, after_data)
         SELECT NULL, 'NFT_JOB_REQUEUED', 'nft_job', id, jsonb_build_object('source', 'scripts/requeue-nft-jobs.js')
           FROM unnest($1::uuid[]) AS id`,
        [jobIds],
      );
    }
    await client.query('COMMIT');
    return jobIds;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * CLI 본체 — 테스트가 pool/prompt/log를 주입해 그대로 돌린다. 종료 코드를 돌려준다.
 * @param {string[]} argv
 * @param {{ pool: import('pg').Pool, prompt?: (q: string) => Promise<boolean>, log?: (line: string) => void }} deps
 */
async function run(argv, deps) {
  const log = deps.log || console.log;
  const prompt = deps.prompt || promptYes;
  let parsed;
  try {
    parsed = parseArgs(argv, ['all', 'dry-run', 'yes']);
  } catch (err) {
    log(`${err.message}\n${USAGE}`);
    return 2;
  }
  const { flags, positional } = parsed;
  if (Boolean(flags.all) === positional.length > 0 || positional.some((id) => !UUID_RE.test(id))) {
    log(USAGE);
    return 2;
  }
  const ids = flags.all ? null : [...new Set(positional.map((id) => id.toLowerCase()))];

  const jobs = await findFailedJobs(deps.pool, ids);
  if (ids) {
    const found = new Set(jobs.map((job) => job.id));
    for (const id of ids.filter((x) => !found.has(x))) log(`skip     ${id} - not found or not FAILED`);
  }
  if (!jobs.length) {
    log('nothing to requeue');
    return ids ? 1 : 0;
  }
  for (const job of jobs) {
    const error = (job.last_error || '').replace(/\s+/g, ' ').slice(0, 120);
    log(`job      ${job.id}  ${job.job_type}  nft=${job.nft_id} (${job.nft_status})  tries=${job.retry_count}  last_error=${error}`);
  }
  log(`plan     ${jobs.length} job(s) FAILED -> PENDING, retry_count -> 0 (+ nft FAILED -> MINTED/PENDING, audit NFT_JOB_REQUEUED)`);
  if (flags['dry-run']) {
    log('dry-run  nothing written');
    return 0;
  }
  if (!flags.yes && !(await prompt(`Requeue ${jobs.length} nft_job(s)?`))) {
    log('aborted  nothing written (non-interactive runs need --yes)');
    return 1;
  }
  const requeued = await requeueJobs(deps.pool, jobs.map((job) => job.id));
  log(`done     requeued ${requeued.length} job(s); the worker picks them up on its next 1-minute poll`);
  return 0;
}

module.exports = { run, requeueJobs, findFailedJobs };

if (require.main === module) runCli(run);
