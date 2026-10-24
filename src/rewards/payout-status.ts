/**
 * payout/보상 상태 규칙의 **단일 출처** — "어떤 payout이 열려 있나 / 끝났나 / 배정 상한을 차지하나 / 수상자가 아직 받을 몫이 있나".
 *
 * 여기를 바꾸면 같이 움직이는 곳 (전부 이 파일을 import한다 — 사본을 새로 쓰지 말 것):
 *   - rewards/rewards.service.ts        requestPayout(배정 상한), markApproved/markPaid(전이 가능 상태), advanceRewardStatus(보상 PAID 판정)
 *   - rewards/payout.worker.ts          승인 대기 경고
 *   - bounties/admin/bounty-lifecycle.service.ts   COMPLETED 전이 차단(UNPAID_WINNERS)
 *   - bounties/admin/bounty-admin.service.ts       삭제 차단(BOUNTY_HAS_OPEN_FUNDS)
 *   - bounties/admin/bounty-operations.query.ts    운영 화면 allocated_amount / cap
 *   - users/account-withdrawal.service.ts          탈퇴 차단(열린 payout, 미요청 보상)
 *   - users/submissions 응답의 payoutStatus / payment_status (payoutStatusSql)
 * src 밖 사본 (JS/SQL이라 import할 수 없다 — payout-status.spec.ts가 어긋나면 실패시킨다):
 *   - scripts/record-refund.js          TERMINAL_PAYOUT_STATUSES
 *   - scripts/mainnet-preflight.sql     [blocker] 3. payout_open 의 NOT IN 목록
 *   - docs/runbook.md §7.4 의 수동 SQL (문서 — 손으로 맞춘다)
 * 정적 가드(test-support/status-literals.spec.ts)가 src에서 payout 상태 집합 리터럴과 상한식 LEAST(…, deposited_amount)를
 * 이 파일 밖에서 쓰지 못하게 막는다.
 *
 * 의존성 없는 모듈이다 (users/submissions 경로가 rewards.service → nfts → ESM SDK를 끌어오지 않게).
 */

/** payout 테이블 CHECK와 같은 전체 상태 (supabase/migrations/0006_rewards.sql — payout-status.spec.ts가 대조) */
export const PAYOUT_ROW_STATUSES = ['REQUESTED', 'AWAITING_MULTISIG_APPROVAL', 'APPROVED', 'BROADCASTING', 'PAID', 'FAILED', 'CANCELLED'] as const;
export type PayoutRowStatus = (typeof PAYOUT_ROW_STATUSES)[number];

/** 멀티시그 승인을 기다리는 상태 — markApproved가 받는 상태, PayoutWorker의 48시간 경고 대상 */
export const AWAITING_APPROVAL_PAYOUT_STATUSES = ['REQUESTED', 'AWAITING_MULTISIG_APPROVAL'] as const satisfies readonly PayoutRowStatus[];

/** 송금할 수 있는(승인된) 상태 — markPaid가 받는 상태 */
export const SENDABLE_PAYOUT_STATUSES = ['APPROVED', 'BROADCASTING'] as const satisfies readonly PayoutRowStatus[];

/**
 * 진행 중(열린) payout — 하나라도 있으면 탈퇴·바운티 삭제·환불 기록·mainnet 전환·COMPLETED 전이를 막는다.
 * 사람이 승인/송금을 마쳐야 끝나는 상태들이다.
 */
export const OPEN_PAYOUT_STATUSES = [...AWAITING_APPROVAL_PAYOUT_STATUSES, ...SENDABLE_PAYOUT_STATUSES] as const;

/** 종료 상태 — OPEN_PAYOUT_STATUSES의 여집합. FAILED는 수동으로만 기록된다(코드가 쓰지 않는다) */
export const TERMINAL_PAYOUT_STATUSES = ['PAID', 'CANCELLED', 'FAILED'] as const satisfies readonly PayoutRowStatus[];

/**
 * 배정 상한을 차지하는 상태 — CANCELLED만 빠진다(취소는 배정을 풀어 준다, docs/runbook.md §7.4).
 * FAILED는 "보내지 못한 배정"이라 계속 차지한다: 그 수상자는 아직 받을 몫이 있고(PENDING), 운영자가 정정/취소로 닫아야 한다.
 */
export const ALLOCATED_PAYOUT_STATUSES = [...OPEN_PAYOUT_STATUSES, 'PAID', 'FAILED'] as const;

/** 배정됐지만 아직 지급되지 않은 상태 (= ALLOCATED − PAID) — 하나라도 있으면 보상을 PAID로 닫지 않는다 (advanceRewardStatus) */
export const UNSETTLED_PAYOUT_STATUSES = [...OPEN_PAYOUT_STATUSES, 'FAILED'] as const;

/** payout을 새로 요청할 수 있는(입금 확인된) 보상 상태 — requestPayout, 회원 탈퇴의 미요청 보상 검사, 아래 지급 상태가 같이 쓴다 */
export const PAYABLE_REWARD_STATUSES = ['FUNDED', 'PARTIALLY_PAID', 'PAID'] as const;

/** 제출 하나의 지급 상태(응답 값) — `GET /users/:nickname` completedBounties[].payoutStatus, `GET /submissions/me` payment_status */
export const PAYOUT_STATUSES = ['PAID', 'PARTIALLY_PAID', 'PENDING', 'NONE'] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function alias(name: string, fn: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`${fn}: alias must be an identifier`);
  return name;
}

/**
 * 상태 목록 → SQL `IN (...)` 안에 넣을 리터럴 목록 (`'A', 'B'`). 이 파일의 상수만 넘긴다 — 사용자 입력이 아니다.
 * 바인딩(`= ANY($n::text[])`)을 쓸 수 없는 조각(payoutStatusSql처럼 다른 쿼리에 끼워 넣는 식)용.
 */
export function sqlStatusList(statuses: readonly string[]): string {
  if (!statuses.length || statuses.some((status) => !/^[A-Z_]+$/.test(status))) throw new Error('sqlStatusList: expected upper-case status constants');
  return statuses.map((status) => `'${status}'`).join(', ');
}

/** 보상 `<rw>`의 배정 상한 — LEAST(게시 금액, 입금액). 초과 입금은 상한을 올리지 않는다 (2026-10-24 결정, docs/decisions.md) */
export function rewardCapSql(rw = 'rw'): string {
  const r = alias(rw, 'rewardCapSql');
  return `LEAST(${r}.amount, ${r}.deposited_amount)`;
}

/** 보상 `<rw>`에 배정된 금액 — ALLOCATED_PAYOUT_STATUSES payout의 합계 (스칼라 서브쿼리, numeric) */
export function allocatedPayoutSumSql(rw = 'rw', p = 'p'): string {
  const r = alias(rw, 'allocatedPayoutSumSql');
  const x = alias(p, 'allocatedPayoutSumSql');
  return `(SELECT COALESCE(SUM(${x}.amount), 0) FROM payout ${x} WHERE ${x}.bounty_reward_id = ${r}.id AND ${x}.status IN (${sqlStatusList(ALLOCATED_PAYOUT_STATUSES)}))`;
}

/** 보상 `<rw>`에 실제 지급된 금액 — PAID payout의 합계 (스칼라 서브쿼리, numeric) */
export function paidPayoutSumSql(rw = 'rw', p = 'p'): string {
  const r = alias(rw, 'paidPayoutSumSql');
  const x = alias(p, 'paidPayoutSumSql');
  return `(SELECT COALESCE(SUM(${x}.amount), 0) FROM payout ${x} WHERE ${x}.bounty_reward_id = ${r}.id AND ${x}.status = 'PAID')`;
}

/** 보상 `<rw>`에 여유분이 남았나 — 배정 상한 > 배정 합계. requestPayout이 새 payout을 받아 줄 수 있는 조건(금액 > 0)과 같다 */
export function rewardHeadroomSql(rw = 'rw', p = 'p'): string {
  return `${rewardCapSql(rw)} > ${allocatedPayoutSumSql(rw, p)}`;
}

/**
 * 제출 `<s>`의 수령자(제출자, 에이전트 제출이면 그 소유자)가 탈퇴하지 않았나 — requestPayout의 수령자 조건(u.deleted_at IS NULL)과 같다.
 * 지갑 조건은 넣지 않는다: 지갑은 다시 연결할 수 있지만 탈퇴는 되돌릴 수 없다.
 */
export function recipientActiveSql(submission = 's'): string {
  const s = alias(submission, 'recipientActiveSql');
  return `EXISTS (SELECT 1 FROM "user" rcp WHERE rcp.deleted_at IS NULL
                     AND rcp.id = COALESCE(${s}.submitter_user_id, (SELECT ax.owner_user_id FROM agent ax WHERE ax.id = ${s}.agent_id)))`;
}

/**
 * 승인된 제출 `<s>`(바운티 `<b>`)의 지급 상태 SQL 식.
 *   owed = 그 바운티의 보상 중 입금 확인 상태(PAYABLE_REWARD_STATUSES)이면서 이 제출이 받을 몫이 있는 것:
 *            (a) 이 제출의 배정된 payout 행(ALLOCATED — 취소 아님)이 있다, 또는
 *            (b) 이 제출의 payout 행이 **하나도** 없고 보상에 여유분이 남았고 수령자(제출자 또는 에이전트 소유자)가 탈퇴하지 않았다
 *                — requestPayout이 아직 받아 줄 수 있다. 탈퇴한 수령자는 requestPayout이 404라 영영 받을 수 없다
 *                (풀이 가득 찼을 때 탈퇴한 뒤 다른 수상이 취소돼 여유분이 생기는 경우 — 이걸 빼면 COMPLETED가 영영 막힌다).
 *                지갑만 없는 수령자는 다시 연결하면 받을 수 있으므로 계속 owed다.
 *          취소된 payout만 있는 제출은 (a)도 (b)도 아니다: 취소는 수상 취소이고, requestPayout은 (보상, 제출)에 행이 있으면
 *          상태와 무관하게 409 PAYOUT_ALREADY_REQUESTED라 다시 받을 수 없다 → NONE.
 *   paid = owed 중 이 제출의 PAID payout이 있는 것
 *   NONE           owed가 비었다 (보상 없음 / 입금 전 / 다른 수상자가 다 가져감 / 수상 취소 / 미요청인데 수령자 탈퇴)
 *   PAID           paid = owed
 *   PARTIALLY_PAID 0 < paid < owed
 *   PENDING        paid = 0
 * 별칭은 식별자만 받는다 (SQL에 그대로 들어간다).
 */
export function payoutStatusSql(submission = 's', bounty = 'b'): string {
  const s = alias(submission, 'payoutStatusSql');
  const b = alias(bounty, 'payoutStatusSql');
  const mine = `px.bounty_reward_id = rw.id AND px.submission_id = ${s}.id`;
  return `(SELECT CASE WHEN count(*) = 0 THEN 'NONE'
                     WHEN count(*) FILTER (WHERE owed.paid) = count(*) THEN 'PAID'
                     WHEN count(*) FILTER (WHERE owed.paid) > 0 THEN 'PARTIALLY_PAID'
                     ELSE 'PENDING' END
           FROM (SELECT EXISTS (SELECT 1 FROM payout px WHERE ${mine}
                                   AND px.status = 'PAID') AS paid
                   FROM bounty_reward rw
                  WHERE rw.bounty_id = ${b}.id
                    AND rw.status IN (${sqlStatusList(PAYABLE_REWARD_STATUSES)})
                    AND (EXISTS (SELECT 1 FROM payout px WHERE ${mine} AND px.status IN (${sqlStatusList(ALLOCATED_PAYOUT_STATUSES)}))
                         OR (NOT EXISTS (SELECT 1 FROM payout px WHERE ${mine})
                             AND ${rewardHeadroomSql('rw', 'px')}
                             AND ${recipientActiveSql(s)}))) owed)`;
}

/**
 * 승인된 제출 `<s>`가 아직 받을 몫을 다 받지 못했나 (payoutStatusSql이 PENDING/PARTIALLY_PAID) — COMPLETED 전이 차단(UNPAID_WINNERS)이
 * 응답의 payoutStatus와 같은 규칙을 쓰게 한다. 보상이 소진됐거나 수상이 취소된 제출은 막지 않는다.
 */
export function owesUnpaidRewardSql(submission = 's', bounty = 'b'): string {
  return `${payoutStatusSql(submission, bounty)} IN ('PENDING', 'PARTIALLY_PAID')`;
}
