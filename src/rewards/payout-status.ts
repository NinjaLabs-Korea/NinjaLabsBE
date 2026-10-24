/**
 * 제출 하나의 지급 상태 — `GET /users/:nickname` completedBounties[].payoutStatus와 `GET /submissions/me` payment_status가 같은 SQL을 쓴다.
 * 의존성 없는 모듈이다 (users/submissions 경로가 rewards.service → nfts → ESM SDK를 끌어오지 않게).
 */

/** payout을 새로 요청할 수 있는(입금 확인된) 보상 상태 — requestPayout, 회원 탈퇴의 미요청 보상 검사, 아래 지급 상태가 같이 쓴다 */
export const PAYABLE_REWARD_STATUSES = ['FUNDED', 'PARTIALLY_PAID', 'PAID'] as const;

export const PAYOUT_STATUSES = ['PAID', 'PARTIALLY_PAID', 'PENDING', 'NONE'] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

/**
 * 승인된 제출 `<s>`(바운티 `<b>`)의 지급 상태 SQL 식.
 *   owed = 그 바운티의 보상 중 입금 확인 상태(FUNDED/PARTIALLY_PAID/PAID)이면서
 *          (이 제출의 payout 행이 이미 있거나 — 상태 무관,
 *           여유분 LEAST(amount, deposited_amount) − 취소 아닌 payout 합계 > 0 이 남은 것 — requestPayout이 아직 받아 줄 수 있음)
 *   paid = owed 중 이 제출의 PAID payout이 있는 것
 *   NONE           owed가 비었다 (보상 없음 / 입금 전 / 다른 수상자가 다 가져감)
 *   PAID           paid = owed
 *   PARTIALLY_PAID 0 < paid < owed
 *   PENDING        paid = 0
 * 별칭은 식별자만 받는다 (SQL에 그대로 들어간다).
 */
export function payoutStatusSql(submission = 's', bounty = 'b'): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(submission) || !/^[a-z_][a-z0-9_]*$/.test(bounty)) throw new Error('payoutStatusSql: alias must be an identifier');
  const payable = PAYABLE_REWARD_STATUSES.map((status) => `'${status}'`).join(', ');
  return `(SELECT CASE WHEN count(*) = 0 THEN 'NONE'
                     WHEN count(*) FILTER (WHERE owed.paid) = count(*) THEN 'PAID'
                     WHEN count(*) FILTER (WHERE owed.paid) > 0 THEN 'PARTIALLY_PAID'
                     ELSE 'PENDING' END
           FROM (SELECT EXISTS (SELECT 1 FROM payout px WHERE px.bounty_reward_id = rw.id AND px.submission_id = ${submission}.id
                                   AND px.status = 'PAID') AS paid
                   FROM bounty_reward rw
                  WHERE rw.bounty_id = ${bounty}.id
                    AND rw.status IN (${payable})
                    AND (EXISTS (SELECT 1 FROM payout px WHERE px.bounty_reward_id = rw.id AND px.submission_id = ${submission}.id)
                         OR LEAST(rw.amount, rw.deposited_amount) >
                            (SELECT COALESCE(SUM(px.amount), 0) FROM payout px WHERE px.bounty_reward_id = rw.id AND px.status <> 'CANCELLED'))) owed)`;
}
