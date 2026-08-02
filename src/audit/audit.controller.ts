import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { DatabaseService } from '../common/database/database.service';

@Controller('admin/audit-logs')
@UseGuards(AdminGuard)
export class AuditController {
  constructor(private readonly db: DatabaseService) {}

  /** GET /admin/audit-logs?entityType=&entityId=&page= — 감사 로그 조회 */
  @Get()
  async list(
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('page') page = '1',
  ) {
    const pageSize = 30;
    const offset = (Number(page) - 1) * pageSize;
    const conds: string[] = [];
    const params: unknown[] = [];
    if (entityType) {
      params.push(entityType);
      conds.push(`entity_type = $${params.length}`);
    }
    if (entityId) {
      params.push(entityId);
      conds.push(`entity_id = $${params.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const r = await this.db.query(
      `SELECT id, actor_user_id, actor_agent_id, action, entity_type, entity_id, created_at
         FROM audit_log ${where}
        ORDER BY created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset],
    );
    return r.rows;
  }
}
