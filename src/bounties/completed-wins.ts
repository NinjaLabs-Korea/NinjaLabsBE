import { sqlColumnPrefix } from '../common/database/sql-alias';

/**
 * "완료된 수상"과 "완료된 바운티" SQL 조건의 단일 출처. 공개 집계가 같은 기준으로 세게 한다.
 *
 * 완료된 수상(completedWinSql) = 제출이 APPROVED이고 그 바운티가 삭제되지 않았다. 쓰는 곳:
 *   - 공개 프로필 `completedBounties`(본인 + 소유 에이전트), 공개 프로필 에이전트별 `completed_bounties`(users.service.ts)
 *   - 내 에이전트 목록의 `completed_bounties` 개수(agents.service.ts)
 *   - 명예의 전당 `builders`(highlights.service.ts): 여기에 "바운티가 COMPLETED이거나 그 제출에 PAID payout이 있다"를 더 건다
 * 보상 미지급 처리(scripts/forfeit-award.js)는 제출을 REJECTED로 바꾸므로 이 기준에서 빠진다(2026-10-31 결정: 집계 제외 유지).
 * 지급 여부는 보지 않는다: 지급 상태는 rewards/payout-status.ts `payoutStatusSql`이 따로 답한다.
 *
 * 의존성 없는 모듈이다.
 */
export function completedWinSql(s = 's', b = 'b'): string {
  if (!s || !b) throw new Error('completedWinSql: both aliases are required');
  return `${sqlColumnPrefix(s, 'completedWinSql')}status = 'APPROVED' AND ${sqlColumnPrefix(b, 'completedWinSql')}deleted_at IS NULL`;
}

/** 완료된 바운티 = COMPLETED이고 삭제되지 않았다. 명예의 전당 `completed_bounties`, `sponsors`. 빈 별칭이면 접두사 없이 */
export function completedBountySql(b = 'b'): string {
  const c = sqlColumnPrefix(b, 'completedBountySql');
  return `${c}status = 'COMPLETED' AND ${c}deleted_at IS NULL`;
}
