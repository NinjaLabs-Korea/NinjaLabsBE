import { sqlColumnPrefix } from '../common/database/sql-alias';

/**
 * "활성 유저" SQL 조건의 단일 출처: 정지(SUSPENDED)·탈퇴(WITHDRAWN, deleted_at)가 아닌 유저.
 * 로그인 코드 교환, refresh 회전·유예, AuthGuard 상태 확인, AdminGuard, Agent API 키 소유자, 지원·제출 자격(BountyActor),
 * 제출 승인 시 수령자 잠금, 탈퇴 대상 잠금, 공개 프로필, 멤버 목록이 같은 조건을 쓴다.
 *
 * `deleted_at IS NULL`만 보는 곳("탈퇴하지 않음", 예: 프로필 저장·지갑 연결의 동시 탈퇴 검사, payout 수령자)은 정지 유저도 통과시키는
 * 다른 규칙이라 이 조각을 쓰지 않는다.
 *
 * @param u 유저 테이블 별칭. 빈 문자열이면 접두사 없이(`FROM "user" WHERE ...` 단독 테이블)
 */
export function activeUserSql(u = 'u'): string {
  const c = sqlColumnPrefix(u, 'activeUserSql');
  return `${c}status = 'ACTIVE' AND ${c}deleted_at IS NULL`;
}
