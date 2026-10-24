/**
 * 제출물(bounty_submission) 상태 규칙의 단일 출처.
 *
 * 규칙(어떤 상태가 "심사 가능"·"미결"·"확정"인지, 심사 결정이 어느 상태로 가는지, 언제 코멘트가 필수인지)을
 * 바꿀 때는 이 파일만 고친다. 서비스들은 여기 정의된 집합/표를 참조할 뿐, 상태 문자열 배열을 직접 만들지 않는다.
 * 규칙표는 submission-status.spec.ts가 문서 겸 회귀 테스트로 고정한다 — 규칙을 바꾸면 그 표도 같이 고친다.
 *
 * 여기를 바꾸면 영향 받는 곳:
 *   - 심사 가능/코멘트 필수/결정→상태: submissions/submission-review.service.ts (+ 컨트롤러 DTO의 @IsIn)
 *   - 재제출 가능/확정:                 submissions/submissions.service.ts
 *   - 미결(unresolved):                 admin/bounty-lifecycle.service.ts (COMPLETED 전이 차단), participation-withdrawal.ts (회원 탈퇴 시 철회)
 *
 * 상태 **값** 자체를 추가/개명하려면 DB CHECK(supabase/migrations/0005_submissions.sql)도 새 마이그레이션으로 바꿔야 한다 —
 * submission-status.spec.ts가 이 파일의 값 집합과 마이그레이션 CHECK가 같은지 검사한다.
 * SQL 안의 단일 값 비교(`status = 'APPROVED'` 등)는 읽기 쉬움을 위해 리터럴로 남겨 두었다 (값 개명 시 grep 대상).
 * 두 개 이상의 상태로 된 집합은 반드시 아래 helper + `= ANY($n::text[])` 바인딩으로 쓴다 (test-support/status-literals.spec.ts가 검사).
 */
export const SubmissionStatus = {
  SUBMITTED: 'SUBMITTED',
  IN_REVIEW: 'IN_REVIEW',
  REVISION_REQUESTED: 'REVISION_REQUESTED',
  RESUBMITTED: 'RESUBMITTED',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  /** 제출자 탈퇴 시 미결 제출을 철회한 상태 (participation-withdrawal.ts) */
  WITHDRAWN: 'WITHDRAWN',
} as const;

export type SubmissionStatus = (typeof SubmissionStatus)[keyof typeof SubmissionStatus];

/**
 * 운영자 심사 결정 (POST /admin/submissions/:id/review 의 decision).
 * DB CHECK에는 'REOPEN'도 있지만 API로 노출하지 않는다 (예약값).
 */
export const SubmissionDecision = {
  START_REVIEW: 'START_REVIEW',
  REQUEST_REVISION: 'REQUEST_REVISION',
  APPROVE: 'APPROVE',
  REJECT: 'REJECT',
} as const;

export type SubmissionDecision = (typeof SubmissionDecision)[keyof typeof SubmissionDecision];

/** 결정 → 심사 후 제출 상태 */
const STATUS_AFTER: Readonly<Record<SubmissionDecision, SubmissionStatus>> = {
  [SubmissionDecision.START_REVIEW]: SubmissionStatus.IN_REVIEW,
  [SubmissionDecision.REQUEST_REVISION]: SubmissionStatus.REVISION_REQUESTED,
  [SubmissionDecision.APPROVE]: SubmissionStatus.APPROVED,
  [SubmissionDecision.REJECT]: SubmissionStatus.REJECTED,
};

/** 심사 대기 — 네 결정 모두 받을 수 있는 상태 */
const AWAITING_REVIEW: readonly string[] = [
  SubmissionStatus.SUBMITTED,
  SubmissionStatus.RESUBMITTED,
  SubmissionStatus.IN_REVIEW,
];

/**
 * 미결 — 심사가 끝나지 않은 상태. 심사 대기 + 수정 요청 후 재제출을 기다리는 REVISION_REQUESTED.
 * 바운티 COMPLETED 전이를 막고(UNRESOLVED_SUBMISSIONS), 제출자 탈퇴 시 WITHDRAWN으로 철회된다.
 */
const UNRESOLVED: readonly string[] = [...AWAITING_REVIEW, SubmissionStatus.REVISION_REQUESTED];

/** 확정 — 더 이상 제출자가 수정할 수 없는 상태 (재제출 시 409 SUBMISSION_FINALIZED) */
const FINALIZED: readonly string[] = [SubmissionStatus.APPROVED, SubmissionStatus.REJECTED];

/**
 * 수정 요청 중인 제출을 바로 반려하는 경우 — 재제출이 오지 않은(버려진) 리비전을 닫는 유일한 길이다.
 * 제출자에게 이유를 남겨야 하므로 코멘트가 필수다.
 */
const isAbandonedRevisionReject = (status: string, decision: string): boolean =>
  status === SubmissionStatus.REVISION_REQUESTED && decision === SubmissionDecision.REJECT;

export const SubmissionStatusPolicy = {
  /** 모든 상태 값 (DB CHECK와 같은 집합, 순서는 정의 순) */
  all: (): string[] => Object.values(SubmissionStatus),
  /** API가 받는 심사 결정 목록 — DTO `@IsIn` 용 (복사본) */
  decisions: (): string[] => Object.values(SubmissionDecision),
  /** 결정 후 제출 상태. 모르는 결정이면 undefined */
  statusAfter: (decision: string): SubmissionStatus | undefined =>
    STATUS_AFTER[decision as SubmissionDecision],
  /** 현재 상태에서 이 결정을 내릴 수 있나 — 아니면 400 SUBMISSION_NOT_REVIEWABLE */
  canReview: (status: string, decision: string): boolean =>
    AWAITING_REVIEW.includes(status) || isAbandonedRevisionReject(status, decision),
  /** 코멘트(비어 있지 않은)가 필수인가 — 수정 요청, 그리고 버려진 리비전 반려. 아니면 400 REVISION_COMMENT_REQUIRED */
  requiresComment: (status: string, decision: string): boolean =>
    decision === SubmissionDecision.REQUEST_REVISION || isAbandonedRevisionReject(status, decision),
  /** 미결 상태 목록 — SQL `= ANY($n::text[])` 바인딩용 (복사본) */
  unresolvedStatuses: (): string[] => [...UNRESOLVED],
  isFinalized: (status: string): boolean => FINALIZED.includes(status),
  /**
   * 접수가 닫힌 뒤(바운티가 OPEN이 아니거나 마감이 지남)에도 재제출할 수 있나 — 수정 요청을 받은 제출만.
   * 아니면 400 BOUNTY_NOT_OPEN / DEADLINE_PASSED (submissions.service.ts)
   */
  canResubmitAfterIntakeClosed: (status: string): boolean => status === SubmissionStatus.REVISION_REQUESTED,
};
