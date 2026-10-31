import { Injectable } from '@nestjs/common';
import { DatabaseService, QueryRunner } from '../common/database/database.service';
import { AUDIT_ACTIONS, AuditAction } from './audit-actions';

export const AUDIT_LOG_PAGE_SIZE = 30;

/** 결정이 바뀐 감사 행에 남기는 이전/이후 값 (예: 기수 지원서 심사 결정 변경). 개인정보·시크릿을 넣지 않는다 */
export type AuditChange = { before?: Record<string, unknown>; after?: Record<string, unknown> };

/**
 * 감사 로그 기록의 단일 진입점. action과 entity_type은 audit-actions.ts 카탈로그로 타입이 묶인다(값은 그대로 저장).
 * 트랜잭션 안에서 호출할 때는 runner로 tx를 넘겨 같은 트랜잭션에 기록한다.
 */
@Injectable()
export class AuditService {
  constructor(private readonly db: DatabaseService) {}

  async record<A extends AuditAction>(
    actorId: string | undefined,
    action: A,
    entityType: (typeof AUDIT_ACTIONS)[A],
    entityId: string,
    runner: QueryRunner = this.db,
    change?: AuditChange,
  ): Promise<void> {
    // before/after 가 없으면 예전과 같은 문장 그대로 (대부분의 호출)
    if (!change) {
      await runner.query(
        `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id)
         VALUES ($1, $2, $3, $4)`,
        [actorId ?? null, action, entityType, entityId],
      );
      return;
    }
    await runner.query(
      `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, before_data, after_data)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
      [actorId ?? null, action, entityType, entityId,
       change.before === undefined ? null : JSON.stringify(change.before),
       change.after === undefined ? null : JSON.stringify(change.after)],
    );
  }

  /**
   * Agent API 키로 한 행위 - 유저 id가 없으므로 `actor_agent_id`를 채운다. 둘 다 비면 운영 스크립트가 남긴 행으로 읽히기 때문에
   * (api-contract.md "운영 스크립트" action 표시 규칙) 에이전트 행위는 이 메서드로 남긴다.
   */
  async recordAgentAction<A extends AuditAction>(
    agentId: string,
    action: A,
    entityType: (typeof AUDIT_ACTIONS)[A],
    entityId: string,
    runner: QueryRunner = this.db,
  ): Promise<void> {
    await runner.query(
      `INSERT INTO audit_log (actor_agent_id, action, entity_type, entity_id)
       VALUES ($1, $2, $3, $4)`,
      [agentId, action, entityType, entityId],
    );
  }

  /**
   * 운영자 조회 - 최신순, 30건/페이지. 필터는 파라미터 바인딩으로만 조립한다.
   * 사람이 읽을 수 있게 행위자 닉네임(`actor_nickname`, 에이전트면 `actor_agent_name`)과 `before_data`/`after_data`(금액·해시·변경 내용)를 함께 준다 -
   * 2인 승인 규칙의 '누가 요청, 누가 승인'과 지급 분쟁 절차(runbook 7.4)가 UUID 한 줄로는 읽히지 않는다. 운영자 전용 엔드포인트다.
   */
  async list(filter: { page: number; entityType?: string; entityId?: string }) {
    const pageSize = AUDIT_LOG_PAGE_SIZE;
    const offset = (filter.page - 1) * pageSize;
    const conds: string[] = [];
    const params: unknown[] = [];
    if (filter.entityType) {
      params.push(filter.entityType);
      conds.push(`a.entity_type = $${params.length}`);
    }
    if (filter.entityId) {
      params.push(filter.entityId);
      conds.push(`a.entity_id = $${params.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const [items, total] = await Promise.all([
      this.db.query(
        `SELECT a.id, a.actor_user_id, a.actor_agent_id, a.action, a.entity_type, a.entity_id, a.created_at,
                u.nickname AS actor_nickname, ag.name AS actor_agent_name, a.before_data, a.after_data
           FROM audit_log a
           LEFT JOIN "user" u ON u.id = a.actor_user_id
           LEFT JOIN agent ag ON ag.id = a.actor_agent_id
          ${where}
          ORDER BY a.created_at DESC, a.id -- 한 트랜잭션의 감사 행은 created_at(now())이 같다 - 페이지 경계가 흔들리지 않게
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, pageSize, offset],
      ),
      this.db.query<{ total: number }>(`SELECT count(*)::int AS total FROM audit_log a ${where}`, params),
    ]);
    return { items: items.rows, page: filter.page, pageSize, total: total.rows[0].total };
  }
}
