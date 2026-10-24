/**
 * 지원서(bounty_application) 상태 규칙의 단일 출처.
 *
 * 상태 흐름: PENDING → APPROVED / REJECTED (운영자 심사), PENDING → WITHDRAWN (본인 철회·탈퇴), WITHDRAWN → PENDING (재지원, 같은 행).
 * 규칙(누가 어느 상태에서 무엇을 할 수 있는지)을 바꿀 때는 이 파일만 고친다. 규칙표는 application-status.spec.ts가 고정한다.
 *
 * 여기를 바꾸면 영향 받는 곳:
 *   - 재지원 가능:              applications/applications.service.ts (apply)
 *   - 승인은 접수 중에만:        applications/application-review.service.ts
 *   - 심사 결정 목록:            applications/application-review.controller.ts의 DTO `@IsIn`
 *
 * 상태 **값** 자체를 추가/개명하려면 DB CHECK(supabase/migrations/0004_bounties.sql)도 새 마이그레이션으로 바꿔야 한다 —
 * application-status.spec.ts가 둘이 같은지 검사한다.
 * 심사·철회는 PENDING에서만 된다 — 이 규칙은 동시성 보호를 위해 SQL 조건부 UPDATE(`WHERE ... AND status = 'PENDING'`)가 직접
 * 집행하므로 TS helper가 없다 (값 개명 시 grep 대상: applications.service.ts, application-review.service.ts, participation-withdrawal.ts (회원 탈퇴),
 * bounty-lifecycle.service.ts). 같은 이유로 재지원의 `status = 'WITHDRAWN'` 조건도 SQL에 있다.
 */
export const ApplicationStatus = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  WITHDRAWN: 'WITHDRAWN',
} as const;

export type ApplicationStatus = (typeof ApplicationStatus)[keyof typeof ApplicationStatus];

/** 운영자 심사 결정 — 결정 값이 곧 심사 후 상태다 (POST /admin/applications/:id/review 의 decision) */
const REVIEW_DECISIONS = [ApplicationStatus.APPROVED, ApplicationStatus.REJECTED] as const;

export type ApplicationReviewDecision = (typeof REVIEW_DECISIONS)[number];

export const ApplicationStatusPolicy = {
  /** 모든 상태 값 (DB CHECK와 같은 집합, 순서는 정의 순) */
  all: (): string[] => Object.values(ApplicationStatus),
  /** API가 받는 심사 결정 목록 — DTO `@IsIn` 용 (복사본) */
  reviewDecisions: (): ApplicationReviewDecision[] => [...REVIEW_DECISIONS],
  /** 같은 바운티에 다시 지원할 수 있나 — 철회한 지원만 (같은 행을 다시 연다). 아니면 409 ALREADY_APPLIED */
  canReapply: (status: string): boolean => status === ApplicationStatus.WITHDRAWN,
  /** 이 결정이 바운티 접수 중(OPEN + 마감 전)에만 허용되나 — 승인만. 반려는 접수가 끝나도 정리용으로 허용 */
  needsOpenIntake: (decision: string): boolean => decision === ApplicationStatus.APPROVED,
};
