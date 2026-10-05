import { Injectable } from '@nestjs/common';
import { DatabaseService, QueryRunner } from '../common/database/database.service';

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
}
