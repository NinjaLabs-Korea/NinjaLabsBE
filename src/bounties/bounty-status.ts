/**
 * 바운티 상태 규칙의 단일 출처.
 *
 * 상태를 추가·변경할 때는 이 파일만 고친다. 서비스들은 여기 정의된
 * 집합/전이표를 참조할 뿐, 상태 문자열 배열을 직접 만들지 않는다.
 */
export const BountyStatus = {
  DRAFT: 'DRAFT',
  FUNDING_PENDING: 'FUNDING_PENDING',
  OPEN: 'OPEN',
  SUBMISSION_CLOSED: 'SUBMISSION_CLOSED',
  IN_REVIEW: 'IN_REVIEW',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
} as const;

export type BountyStatus = (typeof BountyStatus)[keyof typeof BountyStatus];

/** 제출물 심사·지급 요청·재제출이 가능한 (아직 종료되지 않은) 진행 상태 */
const IN_PROGRESS: readonly string[] = [
  BountyStatus.OPEN,
  BountyStatus.SUBMISSION_CLOSED,
  BountyStatus.IN_REVIEW,
];

/** 더 이상 심사할 수 없는 종료 상태 */
const FINISHED: readonly string[] = [BountyStatus.COMPLETED, BountyStatus.CANCELLED];

/** 운영자가 수동으로 일으킬 수 있는 상태 전이 */
const TRANSITIONS: Readonly<Record<string, readonly BountyStatus[]>> = {
  [BountyStatus.DRAFT]: [BountyStatus.FUNDING_PENDING, BountyStatus.OPEN, BountyStatus.CANCELLED],
  [BountyStatus.FUNDING_PENDING]: [BountyStatus.OPEN, BountyStatus.CANCELLED],
  [BountyStatus.OPEN]: [BountyStatus.SUBMISSION_CLOSED, BountyStatus.CANCELLED],
  [BountyStatus.SUBMISSION_CLOSED]: [BountyStatus.IN_REVIEW, BountyStatus.OPEN],
  [BountyStatus.IN_REVIEW]: [BountyStatus.COMPLETED, BountyStatus.OPEN],
};

/** 전이 시 최초 1회 기록하는 타임스탬프 컬럼 */
const TRANSITION_STAMP_COLUMN: Readonly<Partial<Record<BountyStatus, string>>> = {
  [BountyStatus.OPEN]: 'opened_at',
  [BountyStatus.IN_REVIEW]: 'review_started_at',
  [BountyStatus.COMPLETED]: 'completed_at',
};

export const BountyStatusPolicy = {
  isInProgress: (status: string): boolean => IN_PROGRESS.includes(status),
  isFinished: (status: string): boolean => FINISHED.includes(status),
  canTransition: (from: string, to: string): boolean =>
    (TRANSITIONS[from] as readonly string[] | undefined)?.includes(to) ?? false,
  stampColumnFor: (to: string): string | undefined =>
    TRANSITION_STAMP_COLUMN[to as BountyStatus],
};
