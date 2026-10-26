import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../common/database/database.service';
import { isMediaPath } from '../common/validation/url';

/** 운영자용 공지 관리 (초안 포함 전체 목록, 작성/수정/발행/삭제) */
@Injectable()
export class NoticeAdminService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async list() {
    const r = await this.db.query(
      `SELECT id, title, summary, body, category, thumbnail_url, external_url,
              status, published_at, created_at,
              event_date::text AS event_date
         FROM notice WHERE deleted_at IS NULL ORDER BY created_at DESC`,
    );
    return r.rows;
  }

  /**
   * 썸네일이 `/media/<uuid>` 경로면 그 에셋이 실제로 있어야 한다 - 없는 경로를 저장하면 공개 공지가 깨진 이미지를 그린다.
   * 없으면 400 REFERENCE_NOT_FOUND (다른 FK 없는 참조와 같은 코드). http(s) URL은 외부라 확인하지 않는다.
   */
  private async assertMediaExists(tx: Pick<DatabaseService, 'query'>, thumbnailUrl: string | undefined): Promise<void> {
    if (!thumbnailUrl || !isMediaPath(thumbnailUrl)) return;
    const found = await tx.query<{ x: number }>(`SELECT 1 AS x FROM media_asset WHERE id = $1`, [thumbnailUrl.slice('/media/'.length).toLowerCase()]);
    if (!found.rowCount) throw new BadRequestException('REFERENCE_NOT_FOUND');
  }

  async create(adminId: string, input: {
    title: string; summary?: string; body: string; category: string;
    thumbnailUrl?: string; externalUrl?: string; eventDate?: string | null; publish?: boolean;
  }) {
    return this.db.tx(async (tx) => {
      await this.assertMediaExists(tx, input.thumbnailUrl);
      const r = await tx.query<{ id: string }>(
        `INSERT INTO notice (created_by, title, summary, body, category, thumbnail_url, external_url, status, published_at, event_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date)
         RETURNING id`,
        [adminId, input.title, input.summary ?? null, input.body, input.category,
         input.thumbnailUrl ?? null, input.externalUrl ?? null,
         input.publish ? 'PUBLISHED' : 'DRAFT',
         input.publish ? new Date() : null, input.eventDate ?? null],
      );
      await this.audit.record(adminId, input.publish ? 'NOTICE_PUBLISHED' : 'NOTICE_CREATED', 'notice', r.rows[0].id, tx);
      return r.rows[0];
    });
  }

  async update(noticeId: string, input: {
    title?: string; summary?: string; body?: string; category?: string;
    thumbnailUrl?: string; externalUrl?: string; eventDate?: string | null; publish?: boolean;
  }, adminId: string) {
    const fields: Array<[string, unknown]> = [
      ['title', input.title], ['summary', input.summary], ['body', input.body],
      ['category', input.category], ['thumbnail_url', input.thumbnailUrl], ['external_url', input.externalUrl],
      ['event_date', input.eventDate],
    ].filter((entry) => entry[1] !== undefined) as Array<[string, unknown]>;
    const expressions: string[] = [];
    if (input.publish !== undefined) {
      fields.push(['status', input.publish ? 'PUBLISHED' : 'DRAFT']);
      // 최초 발행 시각은 유지 — 이미 발행된 공지를 다시 publish:true로 저장해도 published_at을 덮지 않는다
      if (input.publish) expressions.push('published_at = COALESCE(published_at, now())');
      else fields.push(['published_at', null]);
    }
    if (!fields.length) {
      // 바꿀 게 없는 PATCH도 없는/삭제된 공지는 404 — 존재하지 않는 id에 200 `{ id }`를 돌려주지 않는다
      const exists = await this.db.query(`SELECT 1 FROM notice WHERE id = $1 AND deleted_at IS NULL`, [noticeId]);
      if (!exists.rowCount) throw new NotFoundException('NOTICE_NOT_FOUND');
      return { id: noticeId };
    }
    const assignments = [
      ...fields.map(([column], index) => `${column} = $${index + 2}`),
      ...expressions,
    ].join(', ');
    return this.db.tx(async (tx) => {
      await this.assertMediaExists(tx, input.thumbnailUrl);
      const r = await tx.query(
        `UPDATE notice SET ${assignments} WHERE id = $1 AND deleted_at IS NULL RETURNING id, status`,
        [noticeId, ...fields.map(([, value]) => value)],
      );
      if (!r.rowCount) throw new NotFoundException('NOTICE_NOT_FOUND');
      await this.audit.record(adminId, 'NOTICE_UPDATED', 'notice', noticeId, tx);
      return r.rows[0];
    });
  }

  async remove(noticeId: string, adminId: string) {
    return this.db.tx(async (tx) => {
      const r = await tx.query(
        `UPDATE notice SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
        [noticeId],
      );
      if (!r.rowCount) throw new NotFoundException('NOTICE_NOT_FOUND');
      await this.audit.record(adminId, 'NOTICE_DELETED', 'notice', noticeId, tx);
      return r.rows[0];
    });
  }
}
