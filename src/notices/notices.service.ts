import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../common/database/database.service';

@Injectable()
export class NoticesService {
  constructor(private readonly db: DatabaseService) {}

  /** 발행된 공지/소식 목록 (공개, 단순 페이지네이션) */
  async list(page = 1, pageSize = 10, category?: string) {
    const offset = (page - 1) * pageSize;
    const where = category
      ? `status = 'PUBLISHED' AND deleted_at IS NULL AND category = $3`
      : `status = 'PUBLISHED' AND deleted_at IS NULL`;
    const listParams = category ? [pageSize, offset, category] : [pageSize, offset];

    const items = await this.db.query(
      `SELECT id, title, summary, category, thumbnail_url, external_url, published_at
         FROM notice WHERE ${where}
        ORDER BY published_at DESC
        LIMIT $1 OFFSET $2`,
      listParams,
    );

    const countWhere = category
      ? `status = 'PUBLISHED' AND deleted_at IS NULL AND category = $1`
      : `status = 'PUBLISHED' AND deleted_at IS NULL`;
    const total = await this.db.query<{ count: string }>(
      `SELECT count(*) FROM notice WHERE ${countWhere}`,
      category ? [category] : [],
    );

    return {
      items: items.rows,
      page,
      pageSize,
      total: Number(total.rows[0].count),
    };
  }

  /** 공지 상세 (공개) — 삭제/비공개면 404 → FE는 목록으로 안내 */
  async detail(id: string) {
    const r = await this.db.query(
      `SELECT id, title, summary, body, category, thumbnail_url, external_url, published_at
         FROM notice
        WHERE id = $1 AND status = 'PUBLISHED' AND deleted_at IS NULL`,
      [id],
    );
    if (!r.rowCount) throw new NotFoundException('NOTICE_NOT_FOUND');
    return r.rows[0];
  }
}
