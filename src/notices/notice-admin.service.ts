import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../common/database/database.service';

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
              status, published_at, created_at
         FROM notice WHERE deleted_at IS NULL ORDER BY created_at DESC`,
    );
    return r.rows;
  }

  async create(adminId: string, input: {
    title: string; summary?: string; body: string; category: string;
    thumbnailUrl?: string; externalUrl?: string; publish?: boolean;
  }) {
    const r = await this.db.query<{ id: string }>(
      `INSERT INTO notice (created_by, title, summary, body, category, thumbnail_url, external_url, status, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [adminId, input.title, input.summary ?? null, input.body, input.category,
       input.thumbnailUrl ?? null, input.externalUrl ?? null,
       input.publish ? 'PUBLISHED' : 'DRAFT',
       input.publish ? new Date() : null],
    );
    await this.audit.record(adminId, input.publish ? 'NOTICE_PUBLISHED' : 'NOTICE_CREATED', 'notice', r.rows[0].id);
    return r.rows[0];
  }

  async update(noticeId: string, input: {
    title?: string; summary?: string; body?: string; category?: string;
    thumbnailUrl?: string; externalUrl?: string; publish?: boolean;
  }, adminId: string) {
    const fields: Array<[string, unknown]> = [
      ['title', input.title], ['summary', input.summary], ['body', input.body],
      ['category', input.category], ['thumbnail_url', input.thumbnailUrl], ['external_url', input.externalUrl],
    ].filter((entry) => entry[1] !== undefined) as Array<[string, unknown]>;
    if (input.publish !== undefined) {
      fields.push(['status', input.publish ? 'PUBLISHED' : 'DRAFT']);
      fields.push(['published_at', input.publish ? new Date() : null]);
    }
    if (!fields.length) return { id: noticeId };
    const assignments = fields.map(([column], index) => `${column} = $${index + 2}`).join(', ');
    const r = await this.db.query(
      `UPDATE notice SET ${assignments} WHERE id = $1 AND deleted_at IS NULL RETURNING id, status`,
      [noticeId, ...fields.map(([, value]) => value)],
    );
    if (!r.rowCount) throw new NotFoundException('NOTICE_NOT_FOUND');
    await this.audit.record(adminId, 'NOTICE_UPDATED', 'notice', noticeId);
    return r.rows[0];
  }

  async remove(noticeId: string, adminId: string) {
    const r = await this.db.query(
      `UPDATE notice SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
      [noticeId],
    );
    if (!r.rowCount) throw new NotFoundException('NOTICE_NOT_FOUND');
    await this.audit.record(adminId, 'NOTICE_DELETED', 'notice', noticeId);
    return r.rows[0];
  }
}
