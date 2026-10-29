import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../common/database/database.service';
import { isForeignKeyViolation } from '../common/database/pg-errors';
import { assertMediaPathExists } from '../common/validation/media-reference';
import { assertChangedUrlsStrict, isPublicHttpUrl, isPublicHttpUrlOrMediaPath, isSitePath } from '../common/validation/url';

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
    // 없는 bountyId는 FK(fk_highlight_bounty) 위반 → 400 BOUNTY_NOT_FOUND (예전엔 23503 500). 트랜잭션은 이미 롤백된 뒤다
    return this.db.tx(async (tx) => {
      await assertMediaPathExists(tx, input.imageUrl);
      const r = await tx.query<{ id: string }>(
        `INSERT INTO platform_highlight
           (created_by, type, title, description, image_url, link_url, bounty_id, display_order, is_published, published_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [adminId, input.type, input.title, input.description,
         input.imageUrl ?? null, input.linkUrl ?? null, input.bountyId ?? null,
         input.displayOrder ?? 0, input.publish ?? false,
         input.publish ? new Date() : null],
      );
      await this.audit.record(adminId, 'HIGHLIGHT_CREATED', 'platform_highlight', r.rows[0].id, tx);
      return r.rows[0];
    }).catch((err: unknown) => {
      if (isForeignKeyViolation(err, 'fk_highlight_bounty')) throw new BadRequestException('BOUNTY_NOT_FOUND');
      throw err;
    });
  }

  async update(highlightId: string, input: {
    type?: string; title?: string; description?: string; imageUrl?: string;
    linkUrl?: string; displayOrder?: number; publish?: boolean;
  }, adminId: string) {
    const fields: Array<[string, unknown]> = [
      ['type', input.type], ['title', input.title], ['description', input.description],
      ['image_url', input.imageUrl], ['link_url', input.linkUrl], ['display_order', input.displayOrder],
    ].filter((entry) => entry[1] !== undefined) as Array<[string, unknown]>;
    const expressions: string[] = [];
    if (input.publish !== undefined) {
      fields.push(['is_published', input.publish]);
      // 최초 발행 시각은 유지 — 이미 발행된 하이라이트를 다시 publish:true로 저장해도 published_at(목록 2차 정렬)을 덮지 않는다 (notice-admin과 같은 규칙)
      if (input.publish) expressions.push('published_at = COALESCE(published_at, now())');
      else fields.push(['published_at', null]);
    }
    if (!fields.length) {
      // 바꿀 게 없는 PATCH도 없는 하이라이트는 404 — 존재하지 않는 id에 200 `{ id }`를 돌려주지 않는다
      const exists = await this.db.query(`SELECT 1 FROM platform_highlight WHERE id = $1`, [highlightId]);
      if (!exists.rowCount) throw new NotFoundException('HIGHLIGHT_NOT_FOUND');
      return { id: highlightId };
    }
    const assignments = [
      ...fields.map(([column], index) => `${column} = $${index + 2}`),
      ...expressions,
    ].join(', ');
    return this.db.tx(async (tx) => {
      await assertMediaPathExists(tx, input.imageUrl);
      // 수정 DTO는 완화 규칙이지만 바뀐 URL은 생성 DTO와 같은 엄격 규칙을 지켜야 한다 (localhost·사설 IP 우회 방지)
      await assertChangedUrlsStrict(tx, {
        table: 'platform_highlight', id: highlightId, notFoundCode: 'HIGHLIGHT_NOT_FOUND',
        pairs: [
          { next: input.imageUrl, column: 'image_url', strict: isPublicHttpUrlOrMediaPath, message: 'imageUrl must be a public http(s) URL (no localhost or private addresses) or a /media/<uuid> path' },
          { next: input.linkUrl, column: 'link_url', strict: (v) => isPublicHttpUrl(v) || isSitePath(v), message: 'linkUrl must be a public http(s) URL (no localhost or private addresses) or a site-relative path' },
        ],
      });
      const r = await tx.query(
        `UPDATE platform_highlight SET ${assignments} WHERE id = $1 RETURNING id, is_published`,
        [highlightId, ...fields.map(([, value]) => value)],
      );
      if (!r.rowCount) throw new NotFoundException('HIGHLIGHT_NOT_FOUND');
      await this.audit.record(adminId, 'HIGHLIGHT_UPDATED', 'platform_highlight', highlightId, tx);
      return r.rows[0];
    });
  }

  async remove(highlightId: string, adminId: string) {
    return this.db.tx(async (tx) => {
      const r = await tx.query(`DELETE FROM platform_highlight WHERE id = $1 RETURNING id`, [highlightId]);
      if (!r.rowCount) throw new NotFoundException('HIGHLIGHT_NOT_FOUND');
      await this.audit.record(adminId, 'HIGHLIGHT_DELETED', 'platform_highlight', highlightId, tx);
      return r.rows[0];
    });
  }
}
