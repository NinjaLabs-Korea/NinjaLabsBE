/**
 * 돈 경로 SQL 표적 변형 목록 - mutation/run-sql-mutants.mjs가 하나씩 적용한다.
 *   id    고정 식별자 (P: payout-status.ts, R: rewards.service.ts, L: bounty-lifecycle.service.ts, D: 삭제 가드, W: 탈퇴 가드,
 *         C: completed-wins.ts, F: record-refund.js, A: forfeit-award.js, V: 제출 심사, M: 지급 주소(0029))
 *   from  원문 (파일에 정확히 한 번 나와야 한다. 코드가 바뀌어 STALE이 되면 여기를 고친다)
 *   to    바꿀 값
 *   why   어떤 버그를 흉내 내나
 *   equivalent  살아남아도 구멍이 아닌 변형이면 그 이유 (점수에서 뺀다)
 */
const PS = 'src/rewards/payout-status.ts';
const RS = 'src/rewards/rewards.service.ts';
const LC = 'src/bounties/admin/bounty-lifecycle.service.ts';
const BA = 'src/bounties/admin/bounty-admin.service.ts';
const AW = 'src/users/account-withdrawal.service.ts';
const CW = 'src/bounties/completed-wins.ts';
const RR = 'scripts/record-refund.js';
const FA = 'scripts/forfeit-award.js';
const SR = 'src/bounties/submissions/submission-review.service.ts';
const SY = 'src/bounties/submissions/system-review.ts';
const SP = 'src/bounties/submission-status.ts';
const SS = 'src/bounties/submissions/submissions.service.ts';
const OQ = 'src/bounties/admin/bounty-operations.query.ts';
const PWD = 'src/bounties/participation-withdrawal.ts';

export const MUTANTS = [
  // ── payout-status.ts: 상태 집합 (원소 하나 빠짐 / 더함) ──
  { id: 'P1', file: PS, from: `export const AWAITING_APPROVAL_PAYOUT_STATUSES = ['REQUESTED', 'AWAITING_MULTISIG_APPROVAL']`, to: `export const AWAITING_APPROVAL_PAYOUT_STATUSES = ['REQUESTED']`, why: '승인 대기 집합에서 AWAITING_MULTISIG_APPROVAL 누락 (열린 payout으로 안 셈)' },
  { id: 'P2', file: PS, from: `export const SENDABLE_PAYOUT_STATUSES = ['APPROVED', 'BROADCASTING']`, to: `export const SENDABLE_PAYOUT_STATUSES = ['APPROVED']`, why: '송금 가능 집합에서 BROADCASTING 누락' },
  { id: 'P3', file: PS, from: `export const ALLOCATED_PAYOUT_STATUSES = [...OPEN_PAYOUT_STATUSES, 'PAID', 'FAILED']`, to: `export const ALLOCATED_PAYOUT_STATUSES = [...OPEN_PAYOUT_STATUSES, 'PAID']`, why: '배정 집합에서 FAILED 누락 (FAILED가 상한을 풀어 이중 배정)' },
  { id: 'P4', file: PS, from: `export const ALLOCATED_PAYOUT_STATUSES = [...OPEN_PAYOUT_STATUSES, 'PAID', 'FAILED']`, to: `export const ALLOCATED_PAYOUT_STATUSES = [...OPEN_PAYOUT_STATUSES, 'FAILED']`, why: '배정 집합에서 PAID 누락 (지급된 몫을 다시 배정)' },
  { id: 'P5', file: PS, from: `export const ALLOCATED_PAYOUT_STATUSES = [...OPEN_PAYOUT_STATUSES, 'PAID', 'FAILED']`, to: `export const ALLOCATED_PAYOUT_STATUSES = [...OPEN_PAYOUT_STATUSES, 'PAID', 'FAILED', 'CANCELLED']`, why: '배정 집합에 CANCELLED 추가 (취소가 상한을 안 풂)' },
  { id: 'P6', file: PS, from: `export const ALLOCATED_PAYOUT_STATUSES = [...OPEN_PAYOUT_STATUSES, 'PAID', 'FAILED']`, to: `export const ALLOCATED_PAYOUT_STATUSES = [...SENDABLE_PAYOUT_STATUSES, 'PAID', 'FAILED']`, why: '배정 집합에서 승인 대기(REQUESTED) 누락 (요청만 된 몫을 다시 배정)' },
  { id: 'P7', file: PS, from: `export const UNSETTLED_PAYOUT_STATUSES = [...OPEN_PAYOUT_STATUSES, 'FAILED']`, to: `export const UNSETTLED_PAYOUT_STATUSES = [...OPEN_PAYOUT_STATUSES]`, why: '미정산 집합에서 FAILED 누락 (FAILED가 남아도 보상 PAID로 닫음)' },
  { id: 'P8', file: PS, from: `export const UNSETTLED_PAYOUT_STATUSES = [...OPEN_PAYOUT_STATUSES, 'FAILED']`, to: `export const UNSETTLED_PAYOUT_STATUSES = [...SENDABLE_PAYOUT_STATUSES, 'FAILED']`, why: '미정산 집합에서 승인 대기 누락' },
  { id: 'P9', file: PS, from: `export const PAYABLE_REWARD_STATUSES = ['FUNDED', 'PARTIALLY_PAID', 'PAID']`, to: `export const PAYABLE_REWARD_STATUSES = ['FUNDED', 'PARTIALLY_PAID']`, why: '지급 가능 보상에서 PAID 누락 (maxWinners 인상 뒤 추가 지급 불가)' },
  { id: 'P10', file: PS, from: `export const PAYABLE_REWARD_STATUSES = ['FUNDED', 'PARTIALLY_PAID', 'PAID']`, to: `export const PAYABLE_REWARD_STATUSES = ['FUNDED', 'PAID']`, why: '지급 가능 보상에서 PARTIALLY_PAID 누락' },
  { id: 'P11', file: PS, from: `export const PAYABLE_REWARD_STATUSES = ['FUNDED', 'PARTIALLY_PAID', 'PAID']`, to: `export const PAYABLE_REWARD_STATUSES = ['FUNDED', 'PARTIALLY_PAID', 'PAID', 'DEPOSIT_PENDING']`, why: '입금 전 보상을 지급 가능으로 봄' },
  { id: 'P12', file: PS, from: `export const TERMINAL_PAYOUT_STATUSES = ['PAID', 'CANCELLED', 'FAILED']`, to: `export const TERMINAL_PAYOUT_STATUSES = ['PAID', 'CANCELLED']`, why: '종료 집합에서 FAILED 누락 (탈퇴를 FAILED payout이 막음)' },
  // ── payout-status.ts: SQL 조각 ──
  { id: 'P13', file: PS, from: 'return `LEAST(${r}.amount, ${r}.deposited_amount)`;', to: 'return `GREATEST(${r}.amount, ${r}.deposited_amount)`;', why: '배정 상한 LEAST -> GREATEST (초과 입금분까지 배정)' },
  { id: 'P14', file: PS, from: 'return `LEAST(${r}.amount, ${r}.deposited_amount)`;', to: 'return `${r}.amount`;', why: '배정 상한이 입금액을 무시 (게시 금액만)' },
  { id: 'P15', file: PS, from: "WHERE ${x}.bounty_reward_id = ${r}.id AND ${x}.status = 'PAID')`;", to: "WHERE ${x}.bounty_reward_id = ${r}.id AND ${x}.status <> 'CANCELLED')`;", why: 'PAID 합계가 미지급 payout까지 셈 (삭제 가드가 남은 돈을 놓침)' },
  { id: 'P16', file: PS, from: 'return `COALESCE(${r}.deposited_amount, 0) > ${paidPayoutSumSql(rw, p)}`;', to: 'return `COALESCE(${r}.deposited_amount, 0) >= ${paidPayoutSumSql(rw, p)}`;', why: '남은 돈 판정 경계 > -> >= (전액 지급된 보상도 돈이 남았다고 봄)' },
  { id: 'P17', file: PS, from: 'return `COALESCE(${r}.deposited_amount, 0) > ${paidPayoutSumSql(rw, p)}`;', to: 'return `COALESCE(${r}.amount, 0) > ${paidPayoutSumSql(rw, p)}`;', why: '남은 돈을 입금액이 아니라 게시 금액과 비교 (초과 입금분 놓침)' },
  { id: 'P18', file: PS, from: 'return `${rewardCapSql(rw)} > ${allocatedPayoutSumSql(rw, p)}`;', to: 'return `${rewardCapSql(rw)} >= ${allocatedPayoutSumSql(rw, p)}`;', why: '여유분 경계 > -> >= (상한 소진 보상도 여유 있다고 봄)' },
  { id: 'P19', file: PS, from: 'return `NOT EXISTS (SELECT 1 FROM payout ${x} WHERE ${x}.bounty_reward_id = ${r}.id AND ${x}.submission_id = ${s}.id) AND ${rewardHeadroomSql(r, x)}`;', to: 'return `NOT EXISTS (SELECT 1 FROM payout ${x} WHERE ${x}.bounty_reward_id = ${r}.id) AND ${rewardHeadroomSql(r, x)}`;', why: '지급 요청 가능: 제출 조건 누락 (다른 수상자 payout이 있으면 요청 불가로 봄)' },
  { id: 'P20', file: PS, from: 'return `NOT EXISTS (SELECT 1 FROM payout ${x} WHERE ${x}.bounty_reward_id = ${r}.id AND ${x}.submission_id = ${s}.id) AND ${rewardHeadroomSql(r, x)}`;', to: 'return `NOT EXISTS (SELECT 1 FROM payout ${x} WHERE ${x}.bounty_reward_id = ${r}.id AND ${x}.submission_id = ${s}.id)`;', why: '지급 요청 가능: 여유분 조건 누락' },
  { id: 'P21', file: PS, from: 'return `NOT EXISTS (SELECT 1 FROM payout ${x} WHERE ${x}.bounty_reward_id = ${r}.id AND ${x}.submission_id = ${s}.id) AND ${rewardHeadroomSql(r, x)}`;', to: 'return `NOT EXISTS (SELECT 1 FROM payout ${x} WHERE ${x}.bounty_reward_id = ${r}.id AND ${x}.submission_id = ${s}.id AND ${x}.status <> \'CANCELLED\') AND ${rewardHeadroomSql(r, x)}`;', why: '지급 요청 가능: 취소된 payout만 있는 쌍을 다시 요청 가능으로 봄 (멱등 키와 불일치)' },
  { id: 'P22', file: PS, from: 'return `EXISTS (SELECT 1 FROM "user" rcp WHERE rcp.deleted_at IS NULL', to: 'return `EXISTS (SELECT 1 FROM "user" rcp WHERE TRUE', why: '수령자 탈퇴 여부 무시 (탈퇴 수상자를 받을 몫이 있다고 봄 -> COMPLETED 영구 차단)' },
  { id: 'P23', file: PS, from: "WHEN count(*) FILTER (WHERE owed.paid) = count(*) THEN 'PAID'", to: "WHEN count(*) FILTER (WHERE owed.paid) > 0 THEN 'PAID'", why: '지급 상태: 일부만 지급돼도 PAID' },
  { id: 'P24', file: PS, from: "WHEN count(*) FILTER (WHERE owed.paid) > 0 THEN 'PARTIALLY_PAID'", to: "WHEN count(*) FILTER (WHERE owed.paid) >= 0 THEN 'PARTIALLY_PAID'", why: '지급 상태: PENDING이 PARTIALLY_PAID로' },
  { id: 'P25', file: PS, from: '                                   AND px.status = \'PAID\') AS paid', to: '                                   AND px.status <> \'CANCELLED\') AS paid', why: '지급 상태: 승인만 된 payout을 지급됨으로 셈' },
  { id: 'P26', file: PS, from: 'AND (EXISTS (SELECT 1 FROM payout px WHERE ${mine} AND px.status IN (${sqlStatusList(ALLOCATED_PAYOUT_STATUSES)}))', to: 'AND (EXISTS (SELECT 1 FROM payout px WHERE ${mine})', why: '지급 상태 owed (a): 취소된 payout도 받을 몫으로 셈 (지급 취소 수상자가 PENDING)' },
  { id: 'P27', file: PS, from: '                    AND rw.status IN (${sqlStatusList(PAYABLE_REWARD_STATUSES)})\n                    AND (EXISTS', to: '                    AND (EXISTS', why: '지급 상태: 입금 전 보상도 owed로 셈' },
  { id: 'P28', file: PS, from: '                         OR (${payoutRequestableSql(\'rw\', s, \'px\')}\n                             AND ${recipientActiveSql(s)}))) owed)`;', to: '                         OR (${payoutRequestableSql(\'rw\', s, \'px\')}))) owed)`;', why: '지급 상태 owed (b): 수령자 탈퇴 조건 누락' },
  { id: 'P29', file: PS, from: "return `${payoutStatusSql(submission, bounty)} IN ('PENDING', 'PARTIALLY_PAID')`;", to: "return `${payoutStatusSql(submission, bounty)} IN ('PENDING')`;", why: '받을 몫 판정에서 PARTIALLY_PAID 누락 (일부 지급 수상자를 두고 완료)' },
  { id: 'P30', file: PS, from: "return `${payoutStatusSql(submission, bounty)} IN ('PENDING', 'PARTIALLY_PAID')`;", to: "return `${payoutStatusSql(submission, bounty)} IN ('PARTIALLY_PAID')`;", why: '받을 몫 판정에서 PENDING 누락 (미지급 수상자를 두고 완료/취소)' },

  // ── rewards.service.ts ──
  { id: 'R1', file: RS, from: "WHERE id = $1 AND status = 'DEPOSIT_PENDING' AND $3::numeric >= amount", to: "WHERE id = $1 AND status = 'DEPOSIT_PENDING' AND $3::numeric > amount", why: '입금 확인 경계 >= -> > (정확히 게시 금액 입금을 거부)' },
  { id: 'R2', file: RS, from: "WHERE id = $1 AND status = 'DEPOSIT_PENDING' AND $3::numeric >= amount", to: "WHERE id = $1 AND $3::numeric >= amount", why: '입금 확인: 상태 조건 누락 (이미 FUNDED 보상의 입금액을 덮어씀)' },
  { id: 'R3', file: RS, from: "WHERE id = $1 AND status = 'DEPOSIT_PENDING' AND $3::numeric >= amount", to: "WHERE id = $1 AND status = 'DEPOSIT_PENDING'", why: '입금 확인: 금액 미달 검사 누락' },
  { id: 'R4', file: RS, from: "`SELECT 1 FROM bounty_reward WHERE id = $1 AND status = 'DEPOSIT_PENDING' AND amount > $2::numeric`", to: "`SELECT 1 FROM bounty_reward WHERE id = $1 AND status = 'DEPOSIT_PENDING' AND amount >= $2::numeric`", why: '금액 미달 판정 경계 (오류 코드 구분)', equivalent: '첫 UPDATE가 depositedAmount >= amount면 이미 성공하므로 이 조회에 오는 PENDING 행은 항상 amount > depositedAmount다. 경계 행(=)은 여기 도달하지 않는다' },
  { id: 'R5', file: RS, from: "WHERE rw.id = $1 AND b.deleted_at IS NULL FOR UPDATE OF b`, [rewardId]);\n      if (!parent.rowCount) throw new NotFoundException('REWARD_NOT_FOUND_OR_NOT_PENDING');", to: "WHERE rw.id = $1 FOR UPDATE OF b`, [rewardId]);\n      if (!parent.rowCount) throw new NotFoundException('REWARD_NOT_FOUND_OR_NOT_PENDING');", why: '입금 확인: 삭제된 바운티 입금 허용' },
  { id: 'R6', file: RS, from: "const asPayout = await tx.query(`SELECT 1 FROM payout WHERE payout_tx_hash = $1 LIMIT 1`, [hash]);", to: "const asPayout = await tx.query(`SELECT 1 FROM payout WHERE payout_tx_hash = $1 AND false LIMIT 1`, [hash]);", why: '입금 확인: 지급 해시 재사용 검사 누락' },
  { id: 'R7', file: RS, from: "`SELECT 1 FROM audit_log WHERE action = 'REWARD_REFUNDED' AND after_data->>'txHash' = $1 LIMIT 1`", to: "`SELECT 1 FROM audit_log WHERE action = 'REWARD_REFUNDED' AND after_data->>'txHash' = $1 AND false LIMIT 1`", why: '입금/지급: 환불 해시 재사용 검사 누락' },
  { id: 'R8', file: RS, from: "`SELECT 1 FROM audit_log WHERE action = 'REWARD_REFUNDED' AND after_data->>'txHash' = $1 LIMIT 1`", to: "`SELECT 1 FROM audit_log WHERE after_data->>'txHash' = $1 LIMIT 1`", why: '환불 해시 검사가 action을 안 봄 (다른 감사 행의 txHash로 오탐)' },
  { id: 'R9', file: RS, from: "WHERE rw.id = $1 AND b.deleted_at IS NULL FOR UPDATE OF b`, [rewardId]);\n      if (!parent.rowCount) throw new NotFoundException('REWARD_NOT_FOUND');", to: "WHERE rw.id = $1 FOR UPDATE OF b`, [rewardId]);\n      if (!parent.rowCount) throw new NotFoundException('REWARD_NOT_FOUND');", why: '지급 요청: 삭제된 바운티 허용' },
  { id: 'R10', file: RS, from: `JOIN "user" u ON u.id = COALESCE(s.submitter_user_id, a.owner_user_id) AND u.deleted_at IS NULL\n          WHERE s.id = $1 AND s.status = 'APPROVED' AND s.bounty_id = $2 FOR SHARE OF u\``, to: `JOIN "user" u ON u.id = COALESCE(s.submitter_user_id, a.owner_user_id)\n          WHERE s.id = $1 AND s.status = 'APPROVED' AND s.bounty_id = $2 FOR SHARE OF u\``, why: '지급 요청: 탈퇴한 수령자에게 payout 생성' },
  { id: 'R11', file: RS, from: "WHERE s.id = $1 AND s.status = 'APPROVED' AND s.bounty_id = $2 FOR SHARE OF u`", to: "WHERE s.id = $1 AND s.bounty_id = $2 FOR SHARE OF u`", why: '지급 요청(수령자 확인): 승인 안 된 제출에 payout 생성', equivalent: '뒤의 제출 조회(R11b가 겨누는 FOR UPDATE OF s 문장)가 같은 APPROVED 조건으로 404를 내므로 이 문장의 조건은 방어적 중복이다' },
  { id: 'R11b', file: RS, from: "WHERE s.id = $1 AND s.status = 'APPROVED' AND s.bounty_id = $2\n          FOR UPDATE OF s`", to: "WHERE s.id = $1 AND s.bounty_id = $2\n          FOR UPDATE OF s`", why: '지급 요청(제출 잠금): 승인 안 된 제출에 payout 생성', equivalent: '앞의 수령자 확인 문장(R11)이 같은 APPROVED 조건으로 이미 404를 낸다. 둘 사이 승인 상태는 바뀌지 않는다(APPROVED는 확정 상태, forfeit-award는 payout과 제출 잠금으로 직렬화)' },
  { id: 'R12', file: RS, from: "WHERE s.id = $1 AND s.status = 'APPROVED' AND s.bounty_id = $2 FOR SHARE OF u`", to: "WHERE s.id = $1 AND s.status = 'APPROVED' FOR SHARE OF u`", why: '지급 요청(수령자 확인): 다른 바운티의 제출에 이 보상으로 payout 생성 ($2 미사용이라 42P18로도 죽는다)' },
  { id: 'R12b', file: RS, from: "WHERE s.id = $1 AND s.status = 'APPROVED' AND s.bounty_id = $2\n          FOR UPDATE OF s`", to: "WHERE s.id = $1 AND s.status = 'APPROVED' AND s.bounty_id::text <> $2::text\n          FOR UPDATE OF s`", why: '지급 요청(제출 잠금): 바운티 조건 반전' },
  { id: 'R31', file: RS, from: "WHERE s.id = $1 AND s.status = 'APPROVED' AND s.bounty_id = $2\n          FOR UPDATE OF s`", to: "WHERE s.id = $1 AND s.status = 'APPROVED' AND s.bounty_id = $2`", why: '지급 요청: 제출 행을 잠그지 않고 주소를 읽음 (주소 변경과 경합하면 옛 주소를 스냅샷)' },
  { id: 'R32', file: RS, from: "`SELECT s.payout_address FROM bounty_submission s", to: "`SELECT COALESCE(s.payout_address, (SELECT w.address FROM wallet w WHERE w.user_id = s.submitter_user_id LIMIT 1)) AS payout_address FROM bounty_submission s", why: '지급 요청: 주소가 없으면 지갑 주소로 대체 (PAYOUT_ADDRESS_NOT_SET 우회)' },
  { id: 'R13', file: RS, from: "`SELECT id FROM payout WHERE bounty_reward_id = $1 AND submission_id = $2`", to: "`SELECT id FROM payout WHERE bounty_reward_id = $1 AND submission_id = $2 AND status <> 'CANCELLED'`", why: '중복 검사가 취소된 payout을 무시 (멱등 키 위반 500)' },
  { id: 'R14', file: RS, from: "`SELECT id FROM payout WHERE bounty_reward_id = $1 AND submission_id = $2`", to: "`SELECT id FROM payout WHERE bounty_reward_id = $1`", why: '중복 검사가 제출을 안 봄 (두 번째 수상자 요청을 409)' },
  { id: 'R15', file: RS, from: "WHERE p.payout_tx_hash = $2 AND p.status = 'PAID' AND p.id <> $1`", to: "WHERE p.payout_tx_hash = $2 AND p.id <> $1`", why: 'markPaid 재사용 검사가 미지급 payout의 해시도 셈' },
  { id: 'R16', file: RS, from: "WHERE p.payout_tx_hash = $2 AND p.status = 'PAID' AND p.id <> $1`", to: "WHERE p.payout_tx_hash = $2 AND p.status = 'PAID'`", why: 'markPaid 재사용 검사가 자기 자신을 셈' },
  { id: 'R17', file: RS, from: "count(*) FILTER (WHERE rw.bounty_id <> $3::uuid)::int AS other_bounty", to: "count(*) FILTER (WHERE rw.bounty_id = $3::uuid)::int AS other_bounty", why: 'markPaid: 같은 바운티 재사용을 409, 다른 바운티 재사용 허용' },
  { id: 'R18', file: RS, from: "const asDeposit = await tx.query(`SELECT 1 FROM bounty_reward WHERE deposit_tx_hash = $1 LIMIT 1`, [hash]);", to: "const asDeposit = await tx.query(`SELECT 1 FROM bounty_reward WHERE deposit_tx_hash = $1 AND false LIMIT 1`, [hash]);", why: 'markPaid: 입금 해시 재사용 검사 누락' },
  { id: 'R19', file: RS, from: "`SELECT requested_by FROM payout\n          WHERE id = $1 AND status IN (${sqlStatusList(AWAITING_APPROVAL_PAYOUT_STATUSES)}) FOR UPDATE`", to: "`SELECT requested_by FROM payout\n          WHERE id = $1 FOR UPDATE`", why: '승인: 상태 검사보다 2인 규칙이 먼저 (이미 승인된 payout에 403)' },
  { id: 'R20', file: RS, from: "`UPDATE payout SET status = 'APPROVED', approved_by = $2, approved_at = now()\n          WHERE id = $1 AND status IN (${sqlStatusList(AWAITING_APPROVAL_PAYOUT_STATUSES)})", to: "`UPDATE payout SET status = 'APPROVED', approved_by = $2, approved_at = now()\n          WHERE id = $1", why: '승인 UPDATE의 상태 조건 누락', equivalent: '같은 tx에서 바로 앞 SELECT ... FOR UPDATE가 같은 상태 조건으로 행을 잠갔으므로 UPDATE 시점의 상태는 바뀔 수 없다(방어적 중복 조건)' },
  { id: 'R21', file: RS, from: "WHERE id = $1 AND status IN (${sqlStatusList(SENDABLE_PAYOUT_STATUSES)})\n          RETURNING id, status, payout_tx_hash", to: "WHERE id = $1\n          RETURNING id, status, payout_tx_hash", why: 'markPaid: 승인 안 된(REQUESTED) payout을 PAID로' },
  { id: 'R23', file: RS, from: "WHEN p.unsettled_count = 0 AND (p.paid_count >= b.max_winners OR p.paid_amount >= ${rewardCapSql('rw')}) THEN 'PAID'", to: "WHEN (p.paid_count >= b.max_winners OR p.paid_amount >= ${rewardCapSql('rw')}) THEN 'PAID'", why: '보상 PAID 판정: 미정산 payout 무시' },
  { id: 'R24', file: RS, from: "WHEN p.unsettled_count = 0 AND (p.paid_count >= b.max_winners OR p.paid_amount >= ${rewardCapSql('rw')}) THEN 'PAID'", to: "WHEN p.unsettled_count = 0 AND (p.paid_count > b.max_winners OR p.paid_amount >= ${rewardCapSql('rw')}) THEN 'PAID'", why: '보상 PAID 판정: 수상자 수 경계 >= -> >' },
  { id: 'R25', file: RS, from: "WHEN p.unsettled_count = 0 AND (p.paid_count >= b.max_winners OR p.paid_amount >= ${rewardCapSql('rw')}) THEN 'PAID'", to: "WHEN p.unsettled_count = 0 AND (p.paid_count >= b.max_winners OR p.paid_amount > ${rewardCapSql('rw')}) THEN 'PAID'", why: '보상 PAID 판정: 금액 경계 >= -> >' },
  { id: 'R26', file: RS, from: "WHEN p.unsettled_count = 0 AND (p.paid_count >= b.max_winners OR p.paid_amount >= ${rewardCapSql('rw')}) THEN 'PAID'", to: "WHEN p.unsettled_count = 0 AND (p.paid_count >= b.max_winners AND p.paid_amount >= ${rewardCapSql('rw')}) THEN 'PAID'", why: '보상 PAID 판정: OR -> AND' },
  { id: 'R27', file: RS, from: "WHEN p.unsettled_count = 0 AND (p.paid_count >= b.max_winners OR p.paid_amount >= ${rewardCapSql('rw')}) THEN 'PAID'", to: "WHEN p.unsettled_count = 0 AND (p.paid_count >= b.max_winners OR p.paid_amount >= rw.amount) THEN 'PAID'", why: '보상 PAID 판정: 상한 대신 게시 금액 (입금 부족 보상이 영영 PAID 안 됨)', equivalent: 'confirmDeposit은 depositedAmount >= amount일 때만 FUNDED로 바꾸므로 PAYABLE 상태 보상에서는 LEAST(amount, deposited_amount) = amount다. 입금 부족 보상은 이 UPDATE에 오지 않는다' },
  { id: 'R28', file: RS, from: "          AND rw.status IN (${sqlStatusList(PAYABLE_REWARD_STATUSES)})\n          AND p.paid_count > 0`,", to: "          AND p.paid_count > 0`,", why: '보상 재계산: 환불/취소된 보상 상태도 덮어씀' },
  { id: 'R29', file: RS, from: "          AND rw.status IN (${sqlStatusList(PAYABLE_REWARD_STATUSES)})\n          AND p.paid_count > 0`,", to: "          AND rw.status IN (${sqlStatusList(PAYABLE_REWARD_STATUSES)})`,", why: '보상 재계산: 지급 0건인데 PARTIALLY_PAID로' },
  { id: 'R30', file: RS, from: "COALESCE(SUM(amount) FILTER (WHERE status = 'PAID'), 0) AS paid_amount", to: "COALESCE(SUM(amount) FILTER (WHERE status <> 'CANCELLED'), 0) AS paid_amount", why: '보상 재계산: 미지급 payout 금액을 지급액으로 셈', equivalent: 'paid_amount는 PAID 판정에서 unsettled_count = 0과 AND로만 쓰인다. 미정산이 0이면 취소 아닌 payout은 전부 PAID라 두 합계가 같다' },

  // ── bounty-lifecycle.service.ts ──
  { id: 'L1', file: LC, from: "(SELECT count(*)::int FROM bounty_application WHERE bounty_id = $1 AND status = 'PENDING') AS pending", to: "(SELECT count(*)::int FROM bounty_application WHERE bounty_id = $1 AND status <> 'REJECTED') AS pending", why: '대기 지원 집계가 승인 지원까지 셈' },
  { id: 'L2', file: LC, from: "AND (s.submitter_user_id = a.applicant_user_id OR s.agent_id = a.agent_id))", to: "AND (s.submitter_user_id = a.applicant_user_id))", why: '미제출 참가자: 에이전트 제출을 못 봄' },
  { id: 'L3', file: LC, from: "AND EXISTS (SELECT 1 FROM \"user\" ou WHERE ou.deleted_at IS NULL", to: "AND EXISTS (SELECT 1 FROM \"user\" ou WHERE TRUE", why: '미제출 참가자: 탈퇴자도 셈 (접수 마감 영구 차단)' },
  { id: 'L4', file: LC, from: "ag.deleted_at IS NULL AND ag.status <> 'REVOKED'", to: "ag.deleted_at IS NULL", why: '미제출 참가자: 폐기 에이전트도 셈' },
  { id: 'L5', file: LC, from: "        AND status NOT IN (${sqlStatusList(PAYABLE_REWARD_STATUSES)})) AS unfunded", to: "        AND status = 'DEPOSIT_PENDING') AS unfunded", why: '미입금 보상: REFUND_PENDING/CANCELLED 보상을 입금된 것으로 봄' },
  { id: 'L6', file: LC, from: "WHERE rw.bounty_id = $1 AND p.status IN (${sqlStatusList(OPEN_PAYOUT_STATUSES)})) AS unpaid", to: "WHERE rw.bounty_id = $1 AND p.status IN (${sqlStatusList(AWAITING_APPROVAL_PAYOUT_STATUSES)})) AS unpaid", why: '진행 중 payout: 승인됐지만 미송금(APPROVED)을 안 셈' },
  { id: 'L7', file: LC, from: "WHERE rw.bounty_id = $1 AND p.status IN (${sqlStatusList(OPEN_PAYOUT_STATUSES)})) AS unpaid", to: "WHERE p.status IN (${sqlStatusList(OPEN_PAYOUT_STATUSES)})) AS unpaid", why: '진행 중 payout: 다른 바운티 payout까지 셈' },
  { id: 'L8', file: LC, from: "WHERE s.bounty_id = $1 AND s.status = 'APPROVED' AND ${owesUnpaidRewardSql('s', 'b')}) AS unawarded", to: "WHERE s.bounty_id = $1 AND ${owesUnpaidRewardSql('s', 'b')}) AS unawarded", why: '받을 몫 집계: 승인 안 된 제출도 셈' },
  { id: 'L9', file: LC, from: "        WHERE bounty_id = $1 AND status = $4`,", to: "        WHERE bounty_id = $1`,", why: '취소 연쇄: 승인된 지원까지 반려' },
  { id: 'L10', file: LC, from: "        WHERE bounty_id = $1 AND status = ANY($3::text[])\n        RETURNING id`,", to: "        WHERE bounty_id = $1 AND status <> 'REJECTED'\n        RETURNING id`,", why: '취소 연쇄: 승인된(지급 끝난) 제출까지 반려' },

  // ── 삭제 가드 / 탈퇴 가드 (payout-status 조각을 쓰는 돈 판정) ──
  { id: 'D1', file: BA, from: "               AND (rw.status = 'REFUND_PENDING'\n                    OR (rw.status", to: "               AND ((rw.status", why: '삭제 가드: REFUND_PENDING 보상을 놓침' },
  { id: 'D2', file: BA, from: "WHERE rw.bounty_id = $1 AND p.status IN (${sqlStatusList(OPEN_PAYOUT_STATUSES)})) AS open_payouts`", to: "WHERE rw.bounty_id = $1 AND p.status IN (${sqlStatusList(AWAITING_APPROVAL_PAYOUT_STATUSES)})) AS open_payouts`", why: '삭제 가드: 승인된 미송금 payout을 놓침' },
  { id: 'W1', file: AW, from: "          WHERE p.status <> ALL($2::text[])", to: "          WHERE p.status <> ALL($2::text[]) AND p.status <> 'APPROVED'", why: '탈퇴 가드: 승인된 미송금 payout을 놓침' },
  { id: 'W2', file: AW, from: "            AND (s.submitter_user_id = $1\n                 OR s.agent_id", to: "            AND (false\n                 OR s.agent_id", why: '탈퇴 가드: 본인 제출의 payout(주소 기반·레거시 지갑 기반 모두)을 놓침. BE PR2부터 수령자는 지갑이 아니라 제출로 판단한다' },

  // ── completed-wins.ts ──
  { id: 'C1', file: CW, from: "return `${sqlColumnPrefix(s, 'completedWinSql')}status = 'APPROVED' AND", to: "return `${sqlColumnPrefix(s, 'completedWinSql')}status <> 'REJECTED' AND", why: '완료 수상: 심사 중 제출도 셈' },
  { id: 'C2', file: CW, from: "AND ${sqlColumnPrefix(b, 'completedWinSql')}deleted_at IS NULL`;", to: "AND TRUE`;", why: '완료 수상: 삭제된 바운티도 셈' },
  { id: 'C3', file: CW, from: "return `${c}status = 'COMPLETED' AND ${c}deleted_at IS NULL`;", to: "return `${c}status = 'COMPLETED'`;", why: '완료 바운티: 삭제된 바운티도 셈' },

  // ── scripts/record-refund.js ──
  { id: 'F1', file: RR, from: "(SELECT COALESCE(SUM(p.amount), 0)::text FROM payout p WHERE p.bounty_reward_id = rw.id AND p.status = 'PAID') AS paid_total", to: "(SELECT COALESCE(SUM(p.amount), 0)::text FROM payout p WHERE p.bounty_reward_id = rw.id) AS paid_total", why: '환불: 표시용 PAID 합계가 취소분까지 셈' },
  { id: 'F2', file: RR, from: "(SELECT (rw.deposited_amount - COALESCE(SUM(p.amount), 0))::text FROM payout p WHERE p.bounty_reward_id = rw.id AND p.status = 'PAID') AS refunded_amount", to: "(SELECT (rw.deposited_amount - COALESCE(SUM(p.amount), 0))::text FROM payout p WHERE p.bounty_reward_id = rw.id AND p.status <> 'CANCELLED') AS refunded_amount", why: '환불액에서 FAILED payout도 뺌 (스폰서에게 덜 돌려줌)' },
  { id: 'F3', file: RR, from: "(SELECT (rw.deposited_amount - COALESCE(SUM(p.amount), 0))::text FROM payout p WHERE p.bounty_reward_id = rw.id AND p.status = 'PAID') AS refunded_amount", to: "(SELECT (LEAST(rw.amount, rw.deposited_amount) - COALESCE(SUM(p.amount), 0))::text FROM payout p WHERE p.bounty_reward_id = rw.id AND p.status = 'PAID') AS refunded_amount", why: '환불액을 입금액이 아니라 상한 기준으로 (초과 입금분 미환불)' },
  { id: 'F4', file: RR, from: "(SELECT count(*) FROM bounty_reward WHERE deposit_tx_hash = $1)::int AS as_deposit", to: "0 AS as_deposit", why: '환불: 입금 해시 재사용 허용' },
  { id: 'F5', file: RR, from: "(SELECT count(*) FROM payout WHERE payout_tx_hash = $1)::int AS as_payout", to: "0 AS as_payout", why: '환불: 지급 해시 재사용 허용' },
  { id: 'F6', file: RR, from: "(SELECT count(*) FROM audit_log WHERE action = 'REWARD_REFUNDED' AND after_data->>'txHash' = $1)::int AS as_refund", to: "0 AS as_refund", why: '환불: 같은 환불 해시 두 번 기록 허용' },
  { id: 'F7', file: RR, from: "await client.query(`UPDATE bounty_reward SET status = 'REFUNDED' WHERE id = $1`, [rewardId]);", to: "await client.query(`UPDATE bounty_reward SET status = 'REFUND_PENDING' WHERE id = $1`, [rewardId]);", why: '환불 기록이 REFUNDED가 아님 (삭제 가드 안 풀림)' },

  // ── scripts/forfeit-award.js ──
  { id: 'A1', file: FA, from: "(SELECT count(*)::int FROM payout p WHERE p.submission_id = s.id) AS payouts", to: "(SELECT count(*)::int FROM payout p WHERE p.submission_id = s.id AND p.status <> 'CANCELLED') AS payouts", why: '보상 미지급: 취소된 payout이 있는 제출도 허용' },
  { id: 'A2', file: FA, from: "(SELECT count(*)::int FROM nft n WHERE n.submission_id = s.id) AS nfts", to: "0 AS nfts", why: '보상 미지급: NFT가 있는(지급된) 제출도 허용' },
  { id: 'A3', file: FA, from: "b.status AS bounty_status, b.deleted_at IS NOT NULL AS bounty_deleted,", to: "b.status AS bounty_status, false AS bounty_deleted,", why: '보상 미지급: 삭제된 바운티 허용' },
  { id: 'A4', file: FA, from: "await client.query(`UPDATE bounty_submission SET status = 'REJECTED', reviewed_at = now() WHERE id = $1`, [submissionId]);", to: "await client.query(`UPDATE bounty_submission SET reviewed_at = now() WHERE id = $1`, [submissionId]);", why: '보상 미지급: 제출이 APPROVED로 남음 (COMPLETED 계속 차단)' },
  { id: 'A5', file: FA, from: "`SELECT id, is_admin, status, deleted_at IS NOT NULL AS deleted FROM \"user\" WHERE id = $1`", to: "`SELECT id, is_admin, status, false AS deleted FROM \"user\" WHERE id = $1`", why: '보상 미지급: 탈퇴한 운영자 id 허용', equivalent: '회원 탈퇴(account-withdrawal.service.ts)는 status = WITHDRAWN과 deleted_at을 같은 UPDATE로 쓴다. refusalReason이 status !== ACTIVE로 이미 거부하므로 deleted 열은 방어적 중복이다(순수 함수 분기는 forfeit-award.spec.ts가 따로 덮는다)' },


  // ── 지급 주소 (submissions.service.ts setPayoutAddress / mySubmissions, bounty-operations.query.ts, participation-withdrawal.ts) ──
  { id: 'M1', file: SS, from: "`SELECT s.status, s.payout_address, s.payout_address_updated_at", to: "`SELECT 'APPROVED' AS status, s.payout_address, s.payout_address_updated_at", why: '지급 주소: APPROVED 검사 누락 (심사 중·반려 제출에도 주소 저장)' },
  { id: 'M2', file: SS, from: "WHERE s.id = $1 AND s.submitter_user_id = $2\n          FOR UPDATE OF s`", to: "WHERE s.id = $1 AND (s.submitter_user_id = $2 OR true)\n          FOR UPDATE OF s`", why: '지급 주소: 소유권 검사 누락 (남의 제출 주소를 바꿈)' },
  { id: 'M3', file: SS, from: "           JOIN bounty b ON b.id = s.bounty_id AND b.deleted_at IS NULL\n          WHERE s.id = $1 AND s.submitter_user_id = $2", to: "           JOIN bounty b ON b.id = s.bounty_id\n          WHERE s.id = $1 AND s.submitter_user_id = $2", why: '지급 주소: 삭제된 바운티의 제출에도 주소 저장' },
  { id: 'M4', file: SS, from: "WHERE s.id = $1 AND s.submitter_user_id = $2\n          FOR UPDATE OF s`", to: "WHERE s.id = $1 AND s.submitter_user_id = $2`", why: '지급 주소: 제출 행을 잠그지 않음 (requestPayout과 경합하면 요청 뒤에 주소가 바뀜)' },
  { id: 'M5', file: SS, from: "`SELECT 1 FROM payout WHERE submission_id = $1 LIMIT 1`", to: "`SELECT 1 FROM payout WHERE submission_id = $1 AND false LIMIT 1`", why: '지급 주소: 잠금 검사 누락 (요청 뒤에도 주소 변경)' },
  { id: 'M6', file: SS, from: "`SELECT 1 FROM payout WHERE submission_id = $1 LIMIT 1`", to: "`SELECT 1 FROM payout WHERE submission_id = $1 AND status <> 'CANCELLED' LIMIT 1`", why: '지급 주소: 취소된 payout만 있으면 잠금 해제 (requestPayout은 그 제출에 다시 요청하지 않는다)' },
  { id: 'M7', file: SS, from: "                AND NOT EXISTS (SELECT 1 FROM payout px WHERE px.submission_id = s.id)) AS payout_address_editable,", to: "                ) AS payout_address_editable,", why: '/submissions/me: 요청 뒤에도 주소 수정 가능으로 표시' },
  { id: 'M8', file: SS, from: "(s.submitter_user_id = $1 AND s.status = 'APPROVED'\n", to: "(s.submitter_user_id = $1\n", why: '/submissions/me: 승인 안 된 제출을 주소 수정 가능으로 표시' },
  { id: 'M9', file: OQ, from: "CASE WHEN s.status = 'APPROVED' AND owner.deleted_at IS NULL THEN owner.email END AS email", to: "CASE WHEN s.status = 'APPROVED' THEN owner.email END AS email", why: '운영 화면: 탈퇴한 수상자의 (익명화된) 이메일 노출' },
  { id: 'M10', file: OQ, from: "CASE WHEN s.status = 'APPROVED' AND owner.deleted_at IS NULL THEN owner.email END AS email", to: "CASE WHEN owner.deleted_at IS NULL THEN owner.email END AS email", why: '운영 화면: 승인 안 된 제출자의 이메일 노출' },
  { id: 'M11', file: OQ, from: "COALESCE(p.recipient_address, w.address) AS recipient_address", to: "p.recipient_address AS recipient_address", why: '운영 화면: 0029 이전 지갑 기반 payout의 수령 주소가 사라짐' },
  { id: 'M12', file: PWD, from: "WHERE submitter_user_id = $1 AND payout_address IS NOT NULL`", to: "WHERE submitter_user_id = $1 AND payout_address IS NOT NULL AND false`", why: '탈퇴: 지급 주소를 지우지 않음' },

  // ── submission-review.service.ts / system-review.ts / submission-status.ts (제출 심사) ──
  { id: 'V1', file: SR, from: 'WHERE s.id = $1 AND b.deleted_at IS NULL FOR UPDATE OF b`', to: 'WHERE s.id = $1 FOR UPDATE OF b`', why: '심사: 삭제된 바운티의 제출도 심사' },
  { id: 'V2', file: SR, from: 'WHERE s.id = $1 AND b.deleted_at IS NULL FOR UPDATE OF b`', to: 'WHERE s.id = $1 AND b.deleted_at IS NULL`', why: '심사: 바운티 행 잠금 제거 (동시 승인이 max_winners 초과)' },
  { id: 'V3', file: SR, from: 'if (!BountyStatusPolicy.isInProgress(parent.rows[0].status))', to: 'if (false)', why: '심사: 바운티 상태 검사 제거 (종료된 바운티도 심사)' },
  { id: 'V4', file: SR, from: "\n                  AND ${activeUserSql('u')}\n            WHERE s.id = $1", to: "\n            WHERE s.id = $1", why: '승인: 제출자 활성 검사 제거 (정지/탈퇴 제출자 승인)' },
  { id: 'V5', file: SR, from: 'JOIN "user" u ON u.id = COALESCE(s.submitter_user_id, a.owner_user_id)', to: 'JOIN "user" u ON u.id = s.submitter_user_id', why: '승인: 에이전트 제출의 소유자를 확인하지 않음' },
  { id: 'V6', file: SR, from: '            FOR SHARE OF u`', to: '`', why: '승인: 제출자 유저 행 FOR SHARE 제거 (탈퇴와 경합)' },
  { id: 'V7', file: SR, from: 'if (decision === SubmissionDecision.APPROVE) {\n        const submitter', to: 'if (decision === SubmissionDecision.APPROVE && false) {\n        const submitter', why: '승인: 제출자 검사 블록 전체 제거' },
  { id: 'V8', file: SR, from: 'WHERE id = $1 FOR UPDATE`,\n        [submissionId],\n      );\n      if (!sub.rowCount)', to: 'WHERE id = $1`,\n        [submissionId],\n      );\n      if (!sub.rowCount)', why: '심사: 제출 행 잠금 제거 (동시 심사가 서로 덮어씀)' },
  { id: 'V9', file: SR, from: 'if (!SubmissionStatusPolicy.canReview(sub.rows[0].status, decision)) {', to: 'if (false) {', why: '심사: 심사 가능 상태 검사 제거' },
  { id: 'V10', file: SR, from: 'if (revisionNo !== undefined && revisionNo !== sub.rows[0].current_revision_no) {', to: 'if (revisionNo !== undefined && revisionNo > sub.rows[0].current_revision_no) {', why: '심사: 지난 리비전 번호(작은 값)를 현재로 받아들임' },
  { id: 'V11', file: SR, from: 'if (revisionNo !== undefined && revisionNo !== sub.rows[0].current_revision_no) {', to: 'if (revisionNo !== undefined && revisionNo < sub.rows[0].current_revision_no) {', why: '심사: 아직 없는 리비전 번호(큰 값)를 현재로 받아들임' },
  { id: 'V12', file: SR, from: "&& !comment?.trim()) {", to: "&& !comment) {", why: '코멘트 필수: 공백만 있는 코멘트 허용' },
  { id: 'V13', file: SR, from: "if (SubmissionStatusPolicy.requiresComment(sub.rows[0].status, decision) && !comment?.trim()) {", to: "if (SubmissionStatusPolicy.requiresComment(sub.rows[0].status, decision) && false) {", why: '코멘트 필수 규칙 제거' },
  { id: 'V14', file: SR, from: ">= Number(parent.rows[0].max_winners)", to: "> Number(parent.rows[0].max_winners)", why: 'max_winners 경계 >= -> > (한 명 더 승인)' },
  { id: 'V15', file: SR, from: ">= Number(parent.rows[0].max_winners)", to: ">= Number(parent.rows[0].max_winners) * 1000000", why: 'max_winners 검사 무력화' },
  { id: 'V16', file: SR, from: "`SELECT count(*) FROM bounty_submission WHERE bounty_id = $1 AND status = 'APPROVED'`", to: "`SELECT count(*) FROM bounty_submission WHERE bounty_id = $1 AND status <> 'REJECTED'`", why: '승인 수 집계가 승인 외 상태까지 셈' },
  { id: 'V17', file: SR, from: "`SELECT count(*) FROM bounty_submission WHERE bounty_id = $1 AND status = 'APPROVED'`", to: "`SELECT count(*) FROM bounty_submission WHERE status = 'APPROVED' AND $1::uuid IS NOT NULL`", why: '승인 수 집계가 다른 바운티 승인까지 셈' },
  { id: 'V18', file: SR, from: "`UPDATE bounty_submission SET status = $2, reviewed_at = now() WHERE id = $1`", to: "`UPDATE bounty_submission SET status = $2 WHERE id = $1`", why: '심사: reviewed_at 기록 누락' },
  { id: 'V19', file: SR, from: "comment?.trim() || null);", to: "comment || null);", why: '심사 코멘트를 trim하지 않고 저장' },
  { id: 'V20', file: SR, from: "`SUBMISSION_${decision as SubmissionDecision}`", to: "`SUBMISSION_REVIEWED`", why: '감사 행 액션 이름이 결정을 구분하지 않음' },
  { id: 'V21', file: SR, from: "recordReviews(tx, [submissionId], adminId, decision as SubmissionDecision,", to: "recordReviews(tx, [], adminId, decision as SubmissionDecision,", why: '심사 기록(submission_review) 누락' },
  { id: 'V22', file: SY, from: "sr.revision_no = s.current_revision_no)", to: "sr.revision_no = 1)", why: '심사 기록이 현재 리비전이 아니라 1번 리비전을 가리킴' },
  { id: 'V23', file: SY, from: "$2::uuid, $3::text, $4::text", to: "$2::uuid, $3::text, NULL::text", why: '심사 기록에 코멘트가 저장되지 않음' },
  { id: 'V24', file: SP, from: "(AWAITING_REVIEW.includes(status) && !(status === SubmissionStatus.IN_REVIEW && decision === SubmissionDecision.START_REVIEW)) ||", to: "(AWAITING_REVIEW.includes(status)) ||", why: 'IN_REVIEW에 START_REVIEW 중복 허용' },
  { id: 'V25', file: SP, from: "decision === SubmissionDecision.REQUEST_REVISION || isAbandonedRevisionReject(status, decision),", to: "decision === SubmissionDecision.REQUEST_REVISION,", why: '버려진 리비전 반려에 코멘트 불필요' },
  { id: 'V26', file: SP, from: "status === SubmissionStatus.REVISION_REQUESTED && decision === SubmissionDecision.REJECT;", to: "status === SubmissionStatus.REVISION_REQUESTED;", why: '수정 요청 중인 제출에 모든 결정 허용 (승인 포함)' },
  { id: 'V27', file: SP, from: "const AWAITING_REVIEW: readonly string[] = [\n  SubmissionStatus.SUBMITTED,\n  SubmissionStatus.RESUBMITTED,\n  SubmissionStatus.IN_REVIEW,\n];", to: "const AWAITING_REVIEW: readonly string[] = [\n  SubmissionStatus.SUBMITTED,\n  SubmissionStatus.IN_REVIEW,\n];", why: '심사 대기에서 RESUBMITTED 누락' },
];
