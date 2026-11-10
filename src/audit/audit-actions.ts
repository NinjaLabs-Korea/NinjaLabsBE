/**
 * 감사 로그 `audit_log.action` 값의 **단일 출처** (값 -> entity_type). `AuditService.record()`는 이 카탈로그의
 * 키만 받으므로 오타나 새 이름은 컴파일에서 막힌다. 값은 운영 DB에 이미 쌓인 문자열이라 **이름을 바꾸지 않는다**(바꾸면 감사 화면 라벨과
 * `users.service.ts`의 닉네임 쿨다운 조회처럼 action으로 과거 행을 찾는 코드가 옛 행을 놓친다). 새 행위는 여기에 추가하고
 * `docs/api-contract.md` "감사 action 카탈로그" 표에 같은 행을 넣는다(audit-actions.spec.ts가 양방향 대조).
 *
 * 동적으로 만드는 이름(`BOUNTY_${to}`, `SUBMISSION_${decision}`, `APPLICATION_${decision}`, `COHORT_APPLICATION_${decision}`)도
 * 가능한 값 전부를 나열한다: 템플릿 리터럴 타입이 이 집합에 들어맞아야 컴파일된다.
 *
 * 의존성 없는 모듈이다.
 */
export const AUDIT_ACTIONS = {
  // 바운티 (bounty-admin.service.ts; 전이는 BountyStatusPolicy 전이표의 도착 상태 전부)
  BOUNTY_CREATED: 'bounty',
  BOUNTY_UPDATED: 'bounty',
  BOUNTY_DELETED: 'bounty',
  BOUNTY_FUNDING_PENDING: 'bounty',
  BOUNTY_OPEN: 'bounty',
  BOUNTY_SUBMISSION_CLOSED: 'bounty',
  BOUNTY_IN_REVIEW: 'bounty',
  BOUNTY_COMPLETED: 'bounty',
  BOUNTY_CANCELLED: 'bounty',
  // 바운티 지원 (application-review.service.ts, applications.service.ts)
  APPLICATION_SUBMITTED: 'bounty_application',
  APPLICATION_APPROVED: 'bounty_application',
  APPLICATION_REJECTED: 'bounty_application',
  APPLICATION_REAPPLIED: 'bounty_application',
  APPLICATION_WITHDRAWN: 'bounty_application',
  // 제출 (submissions.service.ts)
  SUBMISSION_SUBMITTED: 'bounty_submission',
  SUBMISSION_RESUBMITTED: 'bounty_submission',
  // 지급 주소 (submissions.service.ts setPayoutAddress; 마스킹된 주소만)
  PAYOUT_ADDRESS_SET: 'bounty_submission',
  // 제출 심사 (submission-review.service.ts, SubmissionDecision 전부)
  SUBMISSION_START_REVIEW: 'bounty_submission',
  SUBMISSION_REQUEST_REVISION: 'bounty_submission',
  SUBMISSION_APPROVE: 'bounty_submission',
  SUBMISSION_REJECT: 'bounty_submission',
  // 보상·지급 (rewards.service.ts)
  REWARD_DEPOSIT_CONFIRMED: 'bounty_reward',
  PAYOUT_REQUESTED: 'payout',
  PAYOUT_APPROVED: 'payout',
  PAYOUT_SELF_APPROVED: 'payout',
  PAYOUT_PAID: 'payout',
  // 기수 (cohort-admin.service.ts)
  COHORT_CREATED: 'cohort',
  COHORT_UPDATED: 'cohort',
  COHORT_DELETED: 'cohort',
  COHORT_QUESTIONS_UPDATED: 'cohort',
  COHORT_OPENED: 'cohort',
  COHORT_CLOSED: 'cohort',
  COHORT_REOPENED: 'cohort',
  // 기수 지원서 (cohort-applications.service.ts, cohort-application-admin.service.ts)
  COHORT_APPLICATION_SUBMITTED: 'cohort_application',
  COHORT_APPLICATION_REAPPLIED: 'cohort_application',
  COHORT_APPLICATION_UPDATED: 'cohort_application',
  COHORT_APPLICATION_WITHDRAWN: 'cohort_application',
  COHORT_APPLICATION_ACCEPTED: 'cohort_application',
  COHORT_APPLICATION_REJECTED: 'cohort_application',
  // 공지·하이라이트 (notice-admin.service.ts, highlight-admin.service.ts)
  NOTICE_CREATED: 'notice',
  NOTICE_PUBLISHED: 'notice',
  NOTICE_UPDATED: 'notice',
  NOTICE_DELETED: 'notice',
  HIGHLIGHT_CREATED: 'platform_highlight',
  HIGHLIGHT_UPDATED: 'platform_highlight',
  HIGHLIGHT_DELETED: 'platform_highlight',
  // 사용자 (account-withdrawal.service.ts, users.service.ts, member-admin.service.ts, user-avatar.service.ts)
  USER_WITHDRAWN: 'user',
  USER_NICKNAME_CHANGED: 'user',
  USER_MEMBER_GRANTED: 'user',
  USER_MEMBER_REVOKED: 'user',
  USER_AVATAR_UPDATED: 'user',
  USER_AVATAR_REMOVED: 'user',
} as const;

export type AuditAction = keyof typeof AUDIT_ACTIONS;

/**
 * 서버 코드가 아니라 운영 스크립트(`scripts/*.js`)와 runbook 수동 SQL만 쓰는 action. JS/SQL이라 위 타입을 import할 수 없어 따로 둔다
 * (audit-actions.spec.ts가 각 값이 그 파일에 실제로 있는지 본다). 감사 화면은 이 action을 "운영 스크립트"로 표시한다(docs/api-contract.md).
 */
export const SCRIPT_AUDIT_ACTIONS = {
  ADMIN_GRANTED: 'user',
  ADMIN_REVOKED: 'user',
  REWARD_REFUNDED: 'bounty_reward',
  SUBMISSION_AWARD_FORFEITED: 'bounty_submission',
  PAYOUT_CORRECTED_MANUAL: 'payout',
  PAYOUT_CANCELLED_MANUAL: 'payout',
} as const;

/**
 * 지금 코드는 더 남기지 않지만 운영 DB에 과거 행이 있는 action. 감사 화면 라벨을 유지하려고 계약(docs/api-contract.md 표, contract/constants.json
 * `audit.legacyActions`)에 남긴다. `AuditService.record()`의 타입(AuditAction)에는 들어가지 않으므로 새로 남길 수 없다.
 * - `WALLET_REPLACED`: 대표 수령 지갑 교체(0024~0028). 지갑 모듈 제거(BE PR2, 2026-11-10 결정)로 더 생기지 않는다
 * - `AGENT_VERIFIED`, `AGENT_KEY_ROTATED`, `AGENT_REVOKED`: 에이전트 등록 검증·키 회전·폐기. 에이전트 제거(BE PR4, 2026-11-11 결정)로 더 생기지 않는다(`actor_agent_*`는 과거 행 때문에 목록이 계속 읽는다)
 * - `NFT_JOB_RETRIED`, `NFT_JOB_REQUEUED`: NFT 잡 재시도(API)와 재큐(스크립트). NFT 제거(BE PR3, 2026-11-11 결정)로 더 생기지 않는다
 */
export const LEGACY_AUDIT_ACTIONS = {
  WALLET_REPLACED: 'user',
  NFT_JOB_RETRIED: 'nft_job',
  NFT_JOB_REQUEUED: 'nft_job',
  AGENT_VERIFIED: 'agent',
  AGENT_KEY_ROTATED: 'agent',
  AGENT_REVOKED: 'agent',
} as const;
