import { AuditService } from '../audit/audit.service';
import { QueryRunner } from '../common/database/database.service';
import { ownedAgentIdsSql } from './owned-agents';

/**
 * 에이전트/API key 폐기 SQL의 단일 출처 — AgentsService(rotateKey/revoke)와 회원 탈퇴(users/account-withdrawal.service.ts)가 쓴다.
 * 모두 호출자의 트랜잭션 안에서 실행한다.
 *
 * agents.service.ts가 아니라 이 파일에 두는 이유: agents.service는 지갑 서명 검증(ADR-36 → ESM 전용 @cosmjs)을 끌어와
 * users 경로(단위 테스트·test-db 포함)가 import하면 jest가 모듈을 못 불러온다. 여기는 DB/감사만 의존한다.
 */

/** 한 에이전트의 ACTIVE 키를 전부 REVOKED로 (재발급·폐기 공용) */
export async function revokeActiveAgentKeys(tx: QueryRunner, agentId: string): Promise<void> {
  await tx.query(
    `UPDATE agent_api_key SET status = 'REVOKED', revoked_at = now()
      WHERE agent_id = $1 AND status = 'ACTIVE'`,
    [agentId],
  );
}

/**
 * 한 유저가 소유한 에이전트를 전부 폐기 — 삭제되지 않은 비-REVOKED 에이전트 → REVOKED, 소유 에이전트의 ACTIVE 키 → REVOKED
 * (이미 REVOKED/삭제된 에이전트에 남은 키 포함), 새로 폐기된 에이전트마다 감사 AGENT_REVOKED(actorId)를 순서대로 남긴다.
 * @returns 이번에 REVOKED로 바뀐 에이전트 id
 */
export async function revokeAllAgentsOfOwner(
  tx: QueryRunner,
  audit: AuditService,
  ownerUserId: string,
  actorId: string,
): Promise<string[]> {
  const agents = (await tx.query(
    `UPDATE agent SET status = 'REVOKED'
      WHERE owner_user_id = $1 AND deleted_at IS NULL AND status <> 'REVOKED'
      RETURNING id`,
    [ownerUserId],
  )) as { rows: Array<{ id: string }> };
  await tx.query(
    `UPDATE agent_api_key SET status = 'REVOKED', revoked_at = now()
      WHERE status = 'ACTIVE' AND agent_id = ANY(${ownedAgentIdsSql('$1', 'including-deleted')})`,
    [ownerUserId],
  );
  const ids = agents.rows.map((agent) => agent.id);
  for (const id of ids) {
    await audit.record(actorId, 'AGENT_REVOKED', 'agent', id, tx);
  }
  return ids;
}
