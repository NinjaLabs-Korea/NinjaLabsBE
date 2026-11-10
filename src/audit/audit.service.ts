import { Injectable } from '@nestjs/common';
import { DatabaseService, QueryRunner } from '../common/database/database.service';
import { currentRequestIp } from '../common/http/request-context';
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
    await this.insert(runner, actorId ?? null, action, entityType, entityId, change);
  }

  /**
   * 실제 INSERT. 값이 있는 컬럼만 문장에 넣는다 - before/after도 IP도 없는 호출(단위 테스트, 크론·워커)은 예전과 같은 4컬럼 문장이다.
   * `ip_address`는 HTTP 요청 안에서만 채운다(common/http/request-context.ts: Express `req.ip`, trust proxy 홉 기준). 요청 밖이면 NULL.
   */
  private async insert(
    runner: QueryRunner,
    actorId: string | null,
    action: string,
    entityType: string,
    entityId: string,
    change?: AuditChange,
  ): Promise<void> {
    const columns = ['actor_user_id', 'action', 'entity_type', 'entity_id'];
    const values = ['$1', '$2', '$3', '$4'];
    const params: unknown[] = [actorId, action, entityType, entityId];
    const add = (column: string, cast: string, value: unknown) => {
      params.push(value);
      columns.push(column);
      values.push(`$${params.length}${cast}`);
    };
    if (change) {
      add('before_data', '::jsonb', change.before === undefined ? null : JSON.stringify(change.before));
      add('after_data', '::jsonb', change.after === undefined ? null : JSON.stringify(change.after));
    }
    const ip = currentRequestIp();
    if (ip) add('ip_address', '::inet', ip);
    await runner.query(
      `INSERT INTO audit_log (${columns.join(', ')})
       VALUES (${values.join(', ')})`,
      params,
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
