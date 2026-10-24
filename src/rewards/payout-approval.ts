/**
 * payout 승인의 2인 규칙 (docs/decisions.md "payout 승인 2인 규칙", docs/security.md).
 *
 * 기본: payout을 요청한 운영자(payout.requested_by)는 그 payout을 승인할 수 없다 → 403 PAYOUT_SELF_APPROVAL.
 * 운영자가 한 명뿐인 배포를 위한 탈출구: `PAYOUT_ALLOW_SELF_APPROVAL=true`(정확히 `true`, 대소문자·앞뒤 공백 무시)이면
 * 자기 승인을 허용하되 warn 로그 + 감사 `PAYOUT_SELF_APPROVED`(PAYOUT_APPROVED 대신)로 남긴다. 그 밖의 값/미설정은 false.
 */
export const PAYOUT_ALLOW_SELF_APPROVAL_ENV = 'PAYOUT_ALLOW_SELF_APPROVAL';

export function allowsPayoutSelfApproval(raw: string | undefined): boolean {
  return raw?.trim().toLowerCase() === 'true';
}
