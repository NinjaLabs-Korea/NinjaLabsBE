import { sqlColumnPrefix, sqlParam } from '../common/database/sql-alias';

/**
 * "유저가 소유한 에이전트" SQL 조각의 단일 출처. 의존성 없는 모듈이다(agents.service는 ESM 전용 서명 라이브러리를 끌어온다).
 *
 * 에이전트 행의 `deleted_at`은 버려진 미검증 에이전트를 다른 사람이 같은 지갑으로 등록할 때만 찍힌다(agents.service retireReusableAgents).
 * 그런 에이전트는 키를 받은 적이 없어 지원·제출 행이 없지만, 두 범위는 목적이 달라 호출부가 명시한다:
 *   - 'live':              삭제되지 않은 에이전트만. "내 지원/제출 내역", 내 에이전트의 지원 철회, 공개 프로필 완료 목록처럼 지금 보이는 소유 관계
 *   - 'including-deleted': 삭제된 에이전트까지. 회원 탈퇴의 참여 철회·열린 payout·미요청 보상 검사, 소유 에이전트 키 일괄 폐기처럼
 *                          하나라도 빠뜨리면 안 되는 안전 검사(더 넓게 잡는 쪽이 안전하다)
 *
 * 이 조각을 쓰지 않는 소유 조건(의도적으로 다르다):
 *   - 등록·폐기 대상 고르기(`deleted_at IS NULL AND status <> 'REVOKED'`, agent-revocation.ts / wallets.service.ts): 부분 유니크 인덱스와 같은 조건
 *   - 공개 프로필 에이전트 목록(`... AND status = 'ACTIVE'`, users.service.ts): 검증된 에이전트만 공개
 *   - 한 에이전트 id의 소유 확인(`id = $1 AND owner_user_id = $2 AND deleted_at IS NULL`, agents.service.ts)
 */
export type OwnedAgentScope = 'live' | 'including-deleted';

/** 유저 `ownerParam`이 소유한 에이전트 id 배열 - `x.agent_id = ANY(${ownedAgentIdsSql('$1', 'live')})` */
export function ownedAgentIdsSql(ownerParam: string, scope: OwnedAgentScope): string {
  const owner = sqlParam(ownerParam, 'ownedAgentIdsSql');
  return scope === 'live'
    ? `ARRAY(SELECT id FROM agent WHERE owner_user_id = ${owner} AND deleted_at IS NULL)`
    : `ARRAY(SELECT id FROM agent WHERE owner_user_id = ${owner})`;
}

/**
 * 참여 행(지원 또는 제출) `<row>`의 사람: 본인 참여면 그 유저, 에이전트 참여면 에이전트 소유자(에이전트 삭제 여부 무관 - 참여의 주인은 바뀌지 않는다).
 * `userColumn`은 `submitter_user_id`/`applicant_user_id`, 서브쿼리 별칭은 바깥 문장과 겹치지 않게 호출부가 고른다.
 */
export function participantUserIdSql(row: string, userColumn: 'submitter_user_id' | 'applicant_user_id', agentAlias: string): string {
  if (!row || !agentAlias) throw new Error('participantUserIdSql: both aliases are required');
  const r = sqlColumnPrefix(row, 'participantUserIdSql');
  const a = sqlColumnPrefix(agentAlias, 'participantUserIdSql');
  return `COALESCE(${r}${userColumn}, (SELECT ${a}owner_user_id FROM agent ${agentAlias} WHERE ${a}id = ${r}agent_id))`;
}
