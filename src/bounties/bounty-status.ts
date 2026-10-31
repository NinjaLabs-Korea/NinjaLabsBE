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

/** 마감이 아직 앞날의 접수를 좌우하는 상태 - 여기서만 운영자 수정 시 마감을 과거로 옮기는 것을 거부한다 (bounty-admin.service.ts) */
const DEADLINE_ENFORCED: readonly string[] = [
  BountyStatus.DRAFT,
  BountyStatus.FUNDING_PENDING,
  BountyStatus.OPEN,
];

/** 운영자 전이의 도착 상태 - DRAFT로 돌아가는 전이는 없다. 감사 action `BOUNTY_<도착 상태>`의 집합이기도 하다(audit/audit-actions.ts) */
export type BountyTransitionTarget = Exclude<BountyStatus, typeof BountyStatus.DRAFT>;

/** 운영자가 수동으로 일으킬 수 있는 상태 전이 */
const TRANSITIONS: Readonly<Record<string, readonly BountyTransitionTarget[]>> = {
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
  /** 진행 상태 목록 - SQL `= ANY($n::text[])` 바인딩용 (복사본) */
  inProgressStatuses: (): string[] => [...IN_PROGRESS],
  isFinished: (status: string): boolean => FINISHED.includes(status),
  enforcesFutureDeadline: (status: string): boolean => DEADLINE_ENFORCED.includes(status),
  /** 운영 화면이 버튼으로 보여 줄, 현재 상태에서 운영자가 일으킬 수 있는 전이 목록 (전이표 순서) */
  transitionsFrom: (from: string): readonly string[] => TRANSITIONS[from] ?? [],
  canTransition: (from: string, to: string): to is BountyTransitionTarget =>
    (TRANSITIONS[from] as readonly string[] | undefined)?.includes(to) ?? false,
  stampColumnFor: (to: string): string | undefined =>
    TRANSITION_STAMP_COLUMN[to as BountyStatus],
};

/**
 * 공개 노출 조건 (공개 목록·상세가 공유하는 단일 출처): 삭제되지 않았고 한 번이라도 OPEN된 바운티.
 * opened_at은 → OPEN 전이에서만 `COALESCE(opened_at, now())`로 최초 1회 찍히고(TRANSITION_STAMP_COLUMN) 이후 지워지지 않는다.
 * SUBMISSION_CLOSED·IN_REVIEW·COMPLETED는 OPEN을 거쳐야만 닿으므로 모두 opened_at이 있다.
 * DRAFT/FUNDING_PENDING에서 바로 CANCELLED된 바운티는 opened_at이 NULL이라 계속 비공개다 - 상태 목록(`NOT IN ('DRAFT', …)`)으로
 * 거르면 그런 바운티가 취소되는 순간 공개됐다. 열린 뒤 취소된 바운티는 계속 공개된다.
 */
export function publicBountySql(b = 'b'): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(b)) throw new Error('publicBountySql: alias must be an identifier');
  return `${b}.deleted_at IS NULL AND ${b}.opened_at IS NOT NULL`;
}
