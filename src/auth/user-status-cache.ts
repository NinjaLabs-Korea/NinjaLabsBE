/**
 * AuthGuard의 유저 상태 캐시 - access JWT는 발급 시점 스냅샷이라, 정지(SUSPENDED/WITHDRAWN)·삭제된 유저도 만료(15분)까지 통과하던 것을 막는다.
 * 요청마다 DB를 치지 않도록 인스턴스(프로세스)별로 유저당 결과를 30초 보관한다 - 따라서 정지/삭제는 **최대 30초 늦게** 반영된다
 * (레플리카마다 독립 캐시, docs/security.md). 어드민 경로는 AdminGuard가 캐시 없이 매번 다시 확인하므로 즉시 반영된다.
 *
 * 여기를 고치는 경우:
 *   - 반영 지연(30초)이나 상한(1만 항목)을 바꿀 때 → 아래 두 상수만. docs/security.md의 같은 숫자도 함께 고친다.
 *   - "ACTIVE"의 정의(어떤 행을 통과시킬지)는 여기가 아니라 AuthService.assertActiveUser의 SQL이다 - 이 파일은 DB를 모른다.
 */
export const USER_STATUS_CACHE_TTL_MS = 30_000;
/** 캐시 상한 - 넘으면 가장 오래 넣은 항목부터 버린다 (Map 삽입 순서) */
export const USER_STATUS_CACHE_MAX = 10_000;

/** userId → (ACTIVE이고 삭제되지 않았는지, 확인 시각 ms). 순수 메모리 구조 - 시각은 호출자가 넘긴다(테스트에서 시계 고정) */
export class UserStatusCache {
  private readonly entries = new Map<string, { active: boolean; checkedAt: number }>();

  /** 아직 신선한(TTL 안) 결과가 있으면 그 값, 없거나 낡았으면 undefined - undefined면 호출자가 DB를 다시 본다 */
  get(userId: string, now: number): boolean | undefined {
    const cached = this.entries.get(userId);
    return cached && now - cached.checkedAt < USER_STATUS_CACHE_TTL_MS ? cached.active : undefined;
  }

  /** 결과 기록 - 지웠다 다시 넣어 삽입 순서(=제거 순서)를 갱신하고, 상한을 넘으면 가장 오래된 항목 하나를 버린다 */
  set(userId: string, active: boolean, now: number): void {
    this.entries.delete(userId);
    this.entries.set(userId, { active, checkedAt: now });
    if (this.entries.size > USER_STATUS_CACHE_MAX) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  /** 한 유저 항목 삭제 - 다음 확인은 DB로 간다 */
  forget(userId: string): void {
    this.entries.delete(userId);
  }

  has(userId: string): boolean {
    return this.entries.has(userId);
  }

  get size(): number {
    return this.entries.size;
  }
}
