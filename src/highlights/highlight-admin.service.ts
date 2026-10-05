import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../common/database/database.service';

/** 운영자용 Hall of Fame 하이라이트 관리 */
@Injectable()
export class HighlightAdminService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async list() {
    const r = await this.db.query(
      `SELECT id, type, title, description, image_url, link_url, bounty_id,
              display_order, is_published, published_at
         FROM platform_highlight ORDER BY display_order, created_at DESC`,
    );
    return r.rows;
  }

  async create(adminId: string, input: {
    type: string; title: string; description: string;
    imageUrl?: string; linkUrl?: string; bountyId?: string;
    displayOrder?: number; publish?: boolean;
  }) {
    const r = await this.db.query<{ id: string }>(
      `INSERT INTO platform_highlight
         (created_by, type, title, description, image_url, link_url, bounty_id, display_order, is_published, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [adminId, input.type, input.title, input.description,
       input.imageUrl ?? null, input.linkUrl ?? null, input.bountyId ?? null,
       input.displayOrder ?? 0, input.publish ?? false,
       input.publish ? new Date() : null],
    );
    await this.audit.record(adminId, 'HIGHLIGHT_CREATED', 'platform_highlight', r.rows[0].id);
    return r.rows[0];
  }

  async update(highlightId: string, input: {
    type?: string; title?: string; description?: string; imageUrl?: string;
    linkUrl?: string; displayOrder?: number; publish?: boolean;
  }, adminId: string) {
    const fields: Array<[string, unknown]> = [
      ['type', input.type], ['title', input.title], ['description', input.description],
      ['image_url', input.imageUrl], ['link_url', input.linkUrl], ['display_order', input.displayOrder],
    ].filter((entry) => entry[1] !== undefined) as Array<[string, unknown]>;
    if (input.publish !== undefined) {
      fields.push(['is_published', input.publish]);
      fields.push(['published_at', input.publish ? new Date() : null]);
    }
    if (!fields.length) return { id: highlightId };
    const assignments = fields.map(([column], index) => `${column} = $${index + 2}`).join(', ');
    const r = await this.db.query(
      `UPDATE platform_highlight SET ${assignments} WHERE id = $1 RETURNING id, is_published`,
      [highlightId, ...fields.map(([, value]) => value)],
    );
    if (!r.rowCount) throw new NotFoundException('HIGHLIGHT_NOT_FOUND');
    await this.audit.record(adminId, 'HIGHLIGHT_UPDATED', 'platform_highlight', highlightId);
    return r.rows[0];
  }

  async remove(highlightId: string, adminId: string) {
    const r = await this.db.query(`DELETE FROM platform_highlight WHERE id = $1 RETURNING id`, [highlightId]);
    if (!r.rowCount) throw new NotFoundException('HIGHLIGHT_NOT_FOUND');
    await this.audit.record(adminId, 'HIGHLIGHT_DELETED', 'platform_highlight', highlightId);
    return r.rows[0];
  }
}
