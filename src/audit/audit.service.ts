import { Injectable } from '@nestjs/common';
import { DatabaseService, QueryRunner } from '../common/database/database.service';

export const AUDIT_LOG_PAGE_SIZE = 30;

/**
 * 감사 로그 기록의 단일 진입점.
 * 트랜잭션 안에서 호출할 때는 runner로 tx를 넘겨 같은 트랜잭션에 기록한다.
 */
@Injectable()
export class AuditService {
  constructor(private readonly db: DatabaseService) {}

  async record(
    actorId: string | undefined,
    action: string,
    entityType: string,
    entityId: string,
    runner: QueryRunner = this.db,
  ): Promise<void> {
    await runner.query(
      `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id)
       VALUES ($1, $2, $3, $4)`,
      [actorId ?? null, action, entityType, entityId],
    );
  }

  /**
   * Agent API 키로 한 행위 — 유저 id가 없으므로 `actor_agent_id`를 채운다. 둘 다 비면 운영 스크립트가 남긴 행으로 읽히기 때문에
   * (api-contract.md "운영 스크립트" action 표시 규칙) 에이전트 행위는 이 메서드로 남긴다.
   */
  async recordAgentAction(
    agentId: string,
    action: string,
    entityType: string,
    entityId: string,
    runner: QueryRunner = this.db,
  ): Promise<void> {
    await runner.query(
      `INSERT INTO audit_log (actor_agent_id, action, entity_type, entity_id)
       VALUES ($1, $2, $3, $4)`,
      [agentId, action, entityType, entityId],
    );
  }

  /** 운영자 조회 — 최신순, 30건/페이지. 필터는 파라미터 바인딩으로만 조립한다 */
  async list(filter: { page: number; entityType?: string; entityId?: string }) {
    const pageSize = AUDIT_LOG_PAGE_SIZE;
    const offset = (filter.page - 1) * pageSize;
    const conds: string[] = [];
    const params: unknown[] = [];
    if (filter.entityType) {
      params.push(filter.entityType);
      conds.push(`entity_type = $${params.length}`);
    }
    if (filter.entityId) {
      params.push(filter.entityId);
      conds.push(`entity_id = $${params.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const [items, total] = await Promise.all([
      this.db.query(
        `SELECT id, actor_user_id, actor_agent_id, action, entity_type, entity_id, created_at
           FROM audit_log ${where}
          ORDER BY created_at DESC, id -- 한 트랜잭션의 감사 행은 created_at(now())이 같다 — 페이지 경계가 흔들리지 않게
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, pageSize, offset],
      ),
      this.db.query<{ total: number }>(`SELECT count(*)::int AS total FROM audit_log ${where}`, params),
    ]);
    return { items: items.rows, page: filter.page, pageSize, total: total.rows[0].total };
  }
}
