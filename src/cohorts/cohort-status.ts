/**
 * 기수(cohort)·기수 지원서(cohort_application)의 상태/값 집합과 규칙의 단일 출처.
 *
 * 기수 상태 흐름 (운영자 전이): DRAFT -> OPEN -> CLOSED, 그리고 CLOSED -> OPEN (재오픈, 다른 OPEN 기수가 없을 때만).
 *   동시에 OPEN 인 기수는 하나뿐이다: 부분 유니크 인덱스 `uq_cohort_single_open`(0018)이 집행하고, 서비스는 사전 검사로 구체적인 코드를 준다.
 * 지원서 상태 흐름: SUBMITTED -> ACCEPTED / REJECTED (운영자 심사, 결정 변경 가능: ACCEPTED <-> REJECTED),
 *   SUBMITTED -> WITHDRAWN (본인 철회 · 회원 탈퇴), WITHDRAWN -> SUBMITTED (재지원, 같은 행을 다시 연다).
 *   ACCEPTED 는 멤버 지정이 아니다 (user.is_member 는 운영자가 멤버 관리에서 따로 켠다).
 *
 * 규칙을 바꿀 때는 이 파일만 고친다. 값 자체를 바꾸려면 DB CHECK(0018)도 새 마이그레이션으로 바꿔야 한다. cohort-status.spec.ts 가 둘을 대조한다.
 * 변경이 닿는 곳: cohort-admin.service.ts(전이·삭제), cohort-applications.service.ts(지원·수정·철회·재지원),
 *   cohort-application-admin.service.ts(심사), cohort-withdrawal.ts(회원 탈퇴), cohort-fields.ts(입력 DTO).
 * 상태 집합 리터럴(`['ACCEPTED','REJECTED']`)을 이 밖에서 새로 만들지 않는다: status-literals.spec.ts 가 막는다.
 */
export const CohortStatus = {
  DRAFT: 'DRAFT',
  OPEN: 'OPEN',
  CLOSED: 'CLOSED',
} as const;
export type CohortStatus = (typeof CohortStatus)[keyof typeof CohortStatus];

export const CohortApplicationStatus = {
  SUBMITTED: 'SUBMITTED',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
  WITHDRAWN: 'WITHDRAWN',
} as const;
export type CohortApplicationStatus = (typeof CohortApplicationStatus)[keyof typeof CohortApplicationStatus];

const COHORT_TRANSITIONS: Record<CohortStatus, readonly CohortStatus[]> = {
  [CohortStatus.DRAFT]: [CohortStatus.OPEN],
  [CohortStatus.OPEN]: [CohortStatus.CLOSED],
  [CohortStatus.CLOSED]: [CohortStatus.OPEN],
};

export const CohortStatusPolicy = {
  /** 모든 상태 값 (DB CHECK 와 같은 집합) */
  all: (): string[] => Object.values(CohortStatus),
  /** 운영자가 이 상태에서 보낼 수 있는 다음 상태 */
  allowedTransitions: (from: string): CohortStatus[] => [...(COHORT_TRANSITIONS[from as CohortStatus] ?? [])],
  canTransition: (from: string, to: string): boolean => (COHORT_TRANSITIONS[from as CohortStatus] ?? []).includes(to as CohortStatus),
  /** 전이 요청 DTO 의 `to` 로 받는 값 (DRAFT 로 되돌리는 전이는 없다) */
  transitionTargets: (): CohortStatus[] => [CohortStatus.OPEN, CohortStatus.CLOSED],
};

/** 운영자 심사 결정: 결정 값이 곧 심사 후 상태다 */
const REVIEW_DECISIONS = [CohortApplicationStatus.ACCEPTED, CohortApplicationStatus.REJECTED] as const;
export type CohortReviewDecision = (typeof REVIEW_DECISIONS)[number];

export const CohortApplicationPolicy = {
  all: (): string[] => Object.values(CohortApplicationStatus),
  reviewDecisions: (): CohortReviewDecision[] => [...REVIEW_DECISIONS],
  /** 지원자가 내용을 고치거나 철회할 수 있나 (기수가 아직 접수 중이라는 조건은 별도) */
  isEditable: (status: string): boolean => status === CohortApplicationStatus.SUBMITTED,
  /** 철회한 지원만 같은 기수에 다시 지원할 수 있다 (같은 행을 다시 연다) */
  canReapply: (status: string): boolean => status === CohortApplicationStatus.WITHDRAWN,
  /** 운영자가 심사(또는 결정 변경)할 수 있나: 철회된 지원서는 이미 끝난 것 */
  isReviewable: (status: string): boolean => status !== CohortApplicationStatus.WITHDRAWN,
};

/** 지원서 선택지: DB CHECK(0018)와 같은 값 */
export const WEB3_EXPERIENCES = ['LT_1Y', 'Y1_3', 'GT_3Y'] as const;
export const ACTIVITY_TYPES = ['DEVELOPER', 'CONTENT_CREATOR', 'KOL', 'COMMUNITY_MARKETING', 'RESEARCHER', 'BIZDEV', 'STUDENT', 'OTHER'] as const;
/** 관심 분야는 활동 유형에서 STUDENT 를 뺀 것 (+ OTHER) */
export const INTEREST_AREAS = ['DEVELOPER', 'CONTENT_CREATOR', 'KOL', 'COMMUNITY_MARKETING', 'RESEARCHER', 'BIZDEV', 'OTHER'] as const;
/** 활동 유형/관심 분야의 "기타": 이 값이면 상세(`...Other`)가 필수다 */
export const OTHER = 'OTHER';

/**
 * 지금 지원을 받는 기수인가 (SQL 조각): OPEN 이고 지금이 [opens_at, closes_at] 안 (비어 있는 쪽은 제한 없음).
 * 공개 `GET /cohorts/current` 의 acceptingApplications, 지원·수정이 같은 식을 쓴다: 사본을 만들지 않는다.
 */
export const cohortAcceptingSql = (alias = 'c'): string =>
  `(${alias}.status = 'OPEN' AND (${alias}.opens_at IS NULL OR ${alias}.opens_at <= now()) AND (${alias}.closes_at IS NULL OR ${alias}.closes_at >= now()))`;
