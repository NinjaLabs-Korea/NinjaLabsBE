#!/usr/bin/env node
/**
 * 취소된 바운티의 환불 기록 — 스폰서에게 멀티시그에서 환불 송금을 마친 뒤, 그 보상(bounty_reward)을 REFUNDED로 기록한다.
 *
 *   node scripts/record-refund.js <reward-id> --tx <hash> [--dry-run] [--yes]
 *
 *   --tx       환불 송금 tx 해시 (32바이트 hex, 0x 선택 — src/common/validation/tx-hash.ts와 같은 정규화: 소문자 + 0x)
 *   --dry-run  검사 결과와 환불 금액만 출력하고 아무것도 쓰지 않는다
 *   --yes      확인 프롬프트를 건너뛴다 (비대화형 실행은 필수)
 *
 * 한 트랜잭션에서 (rewards.service.ts confirmDeposit과 같은 잠금 순서: bounty → bounty_reward):
 *   - 바운티가 CANCELLED, 보상이 FUNDED/PARTIALLY_PAID/PAID/REFUND_PENDING, PAID/CANCELLED/FAILED 밖의 payout이 없고, 입금액 − PAID 합계 > 0이어야 한다.
 *     PAID 보상도 받는다: 보상 PAID는 "수상자 몫 지급 끝"일 뿐 입금액을 다 썼다는 뜻이 아니다 (초과 입금, 또는 max_winners를 채웠지만
 *     상한보다 적게 지급) — 그 남은 돈 때문에 바운티 삭제가 409이므로 여기서 정산할 수 있어야 한다 (docs/decisions.md 삭제 정책 2026-10-25).
 *     하나라도 어긋나면 아무것도 쓰지 않고 이유를 출력한다 (exit 1).
 *   - bounty_reward: status → REFUNDED.
 *   - audit_log: REWARD_REFUNDED (actor NULL, entity_type 'bounty_reward', after_data {txHash, refundedAmount = deposited − PAID 합계, source}).
 * 이 해시가 이미 입금(deposit_tx_hash)이나 지급(payout_tx_hash)으로 기록돼 있으면 거부한다 — 잘못 붙여 넣은 해시를 환불 증빙으로 남기지 않는다.
 * 스키마 변경 없음. 환불 송금 자체는 이 스크립트가 하지 않는다 (docs/runbook.md §7.7).
 * 접속: DATABASE_URL (+ DATABASE_CA_CERT / PGSSLMODE) — scripts/migrate.js와 같은 규칙 (scripts/ops-cli.js).
 */
const { OpsError, UUID_RE, parseArgs, promptYes, runCli } = require('./ops-cli');

const USAGE = 'usage: node scripts/record-refund.js <reward-id> --tx <hash> [--dry-run] [--yes]';
const TX_HASH = /^(0x)?[0-9a-fA-F]{64}$/;
/** 환불 기록을 받는 보상 상태 — src/rewards/payout-status.ts PAYABLE_REWARD_STATUSES + REFUND_PENDING (payout-status.spec.ts가 대조) */
const REFUNDABLE = ['FUNDED', 'PARTIALLY_PAID', 'PAID', 'REFUND_PENDING'];
/**
 * payout 종료 상태 — 이 밖의 payout(진행 중)이 하나라도 있으면 거부한다.
 * src/rewards/payout-status.ts TERMINAL_PAYOUT_STATUSES의 **사본**이다 (scripts는 src를 import하지 않는 독립 JS).
 * 규칙을 바꾸면 그 파일과 여기를 같이 고친다 — src/rewards/payout-status.spec.ts가 둘이 어긋나면 실패한다.
 */
const TERMINAL_PAYOUT_STATUSES = ['PAID', 'CANCELLED', 'FAILED'];
const SOURCE = 'scripts/record-refund.js';

/** src/common/validation/tx-hash.ts normalizeTxHash와 같은 규칙 — 틀리면 null */
function normalizeTxHash(raw) {
  if (typeof raw !== 'string' || !TX_HASH.test(raw.trim())) return null;
  return `0x${raw.trim().replace(/^0x/i, '').toLowerCase()}`;
}

/**
 * 보상 상태 검사. lock이면 바운티 → 보상 순서로 FOR UPDATE (한 트랜잭션 안에서만 의미 있음).
 * @returns {Promise<{ reward: object|null, refundedAmount: string|null }>}
 */
async function inspectReward(runner, rewardId, lock = false) {
  const head = await runner.query(`SELECT bounty_id FROM bounty_reward WHERE id = $1`, [rewardId]);
  if (!head.rowCount) return { reward: null, refundedAmount: null };
  if (lock) await runner.query(`SELECT id FROM bounty WHERE id = $1 FOR UPDATE`, [head.rows[0].bounty_id]);
  const r = await runner.query(
    `SELECT rw.id, rw.bounty_id, rw.status AS reward_status, rw.amount::text AS amount, rw.deposited_amount::text AS deposited_amount,
            b.status AS bounty_status,
            (SELECT COALESCE(SUM(p.amount), 0)::text FROM payout p WHERE p.bounty_reward_id = rw.id AND p.status = 'PAID') AS paid_total,
            (SELECT count(*)::int FROM payout p WHERE p.bounty_reward_id = rw.id
              AND p.status NOT IN (${TERMINAL_PAYOUT_STATUSES.map((status) => `'${status}'`).join(', ')})) AS open_payouts,
            (SELECT (rw.deposited_amount - COALESCE(SUM(p.amount), 0))::text FROM payout p WHERE p.bounty_reward_id = rw.id AND p.status = 'PAID') AS refunded_amount
       FROM bounty_reward rw JOIN bounty b ON b.id = rw.bounty_id
      WHERE rw.id = $1 ${lock ? 'FOR UPDATE OF rw' : ''}`,
    [rewardId],
  );
  const reward = r.rows[0] || null;
  return { reward, refundedAmount: reward ? reward.refunded_amount : null };
}

/** 거부 사유 (없으면 null) */
function refusalReason(reward, refundedAmount) {
  if (!reward) return 'reward not found';
  if (reward.bounty_status !== 'CANCELLED') return `bounty is ${reward.bounty_status}, not CANCELLED`;
  if (!REFUNDABLE.includes(reward.reward_status)) return `reward is ${reward.reward_status}, expected one of ${REFUNDABLE.join('/')}`;
  if (reward.open_payouts > 0) return `${reward.open_payouts} payout(s) are still open (not ${TERMINAL_PAYOUT_STATUSES.join('/')}) — cancel or finish them first`;
  if (reward.deposited_amount === null || refundedAmount === null || !(Number(refundedAmount) > 0)) {
    return 'nothing to refund (deposited amount minus PAID payouts is not positive)';
  }
  return null;
}

async function hashInUse(runner, hash) {
  const r = await runner.query(
    `SELECT (SELECT count(*) FROM bounty_reward WHERE deposit_tx_hash = $1)::int AS as_deposit,
            (SELECT count(*) FROM payout WHERE payout_tx_hash = $1)::int AS as_payout,
            (SELECT count(*) FROM audit_log WHERE action = 'REWARD_REFUNDED' AND after_data->>'txHash' = $1)::int AS as_refund`,
    [hash],
  );
  const row = r.rows[0];
  if (row.as_deposit) return 'that tx hash is already recorded as a deposit';
  if (row.as_payout) return 'that tx hash is already recorded as a payout';
  if (row.as_refund) return 'that tx hash is already recorded as a refund';
  return null;
}

/**
 * 환불 기록 (한 트랜잭션). 잠근 뒤 다시 검사하므로 그 사이 바뀐 상태는 거부된다.
 * @returns {Promise<{ refundedAmount: string }>} 거부되면 OpsError throw (롤백)
 */
async function recordRefund(pool, rewardId, hash) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { reward, refundedAmount } = await inspectReward(client, rewardId, true);
    const reason = refusalReason(reward, refundedAmount) || (await hashInUse(client, hash));
    if (reason) throw new OpsError('REFUSED', reason);
    await client.query(`UPDATE bounty_reward SET status = 'REFUNDED' WHERE id = $1`, [rewardId]);
    await client.query(
      `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, before_data, after_data)
       VALUES (NULL, 'REWARD_REFUNDED', 'bounty_reward', $1, jsonb_build_object('status', $2::text),
               jsonb_build_object('txHash', $3::text, 'refundedAmount', $4::text, 'source', $5::text))`,
      [rewardId, reward.reward_status, hash, refundedAmount, SOURCE],
    );
    await client.query('COMMIT');
    return { refundedAmount };
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
  // --tx는 값을 받는 옵션이라 parseArgs(불리언 플래그만)에 넘기기 전에 분리한다
  const rest = [];
  let rawHash;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--tx') {
      rawHash = argv[i + 1];
      i += 1;
    } else {
      rest.push(argv[i]);
    }
  }
  let parsed;
  try {
    parsed = parseArgs(rest, ['dry-run', 'yes']);
  } catch (err) {
    log(`${err.message}\n${USAGE}`);
    return 2;
  }
  const { flags, positional } = parsed;
  const hash = normalizeTxHash(rawHash);
  if (positional.length !== 1 || !UUID_RE.test(positional[0]) || !hash) {
    log(USAGE);
    return 2;
  }
  const rewardId = positional[0].toLowerCase();

  const { reward, refundedAmount } = await inspectReward(deps.pool, rewardId);
  const reason = refusalReason(reward, refundedAmount) || (await hashInUse(deps.pool, hash));
  if (reason) {
    log(`refused  ${rewardId} — ${reason}`);
    return 1;
  }
  log(`reward   ${rewardId}  bounty=${reward.bounty_id} (${reward.bounty_status})  status=${reward.reward_status}  deposited=${reward.deposited_amount}  paid=${reward.paid_total}`);
  log(`plan     reward ${reward.reward_status} -> REFUNDED, refundedAmount=${refundedAmount}, txHash=${hash} (+ audit REWARD_REFUNDED)`);
  if (flags['dry-run']) {
    log('dry-run  nothing written');
    return 0;
  }
  if (!flags.yes && !(await prompt(`Record refund of ${refundedAmount} for reward ${rewardId} (tx ${hash})?`))) {
    log('aborted  nothing written (non-interactive runs need --yes)');
    return 1;
  }
  try {
    const done = await recordRefund(deps.pool, rewardId, hash);
    log(`done     reward ${rewardId} REFUNDED (refundedAmount=${done.refundedAmount})`);
    return 0;
  } catch (err) {
    if (err instanceof OpsError) {
      log(`refused  ${rewardId} — ${err.message}`);
      return 1;
    }
    throw err;
  }
}

module.exports = { run, recordRefund, inspectReward, normalizeTxHash, TERMINAL_PAYOUT_STATUSES, REFUNDABLE };

if (require.main === module) runCli(run);
