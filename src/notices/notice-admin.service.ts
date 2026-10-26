import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../common/database/database.service';
import { assertMediaPathExists } from '../common/validation/media-reference';

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

  async create(adminId: string, input: {
    title: string; summary?: string; body: string; category: string;
    thumbnailUrl?: string; externalUrl?: string; eventDate?: string | null; publish?: boolean;
  }) {
    // 행사 날짜는 EVENT 공지만의 것이다 - 다른 분류에 붙으면 공개 목록이 "Event date"를 그 카드에 그린다 (수정은 조용히 비운다: update 참고)
    if (input.eventDate != null && input.category !== 'EVENT') throw new BadRequestException('EVENT_DATE_ONLY_FOR_EVENT');
    return this.db.tx(async (tx) => {
      await assertMediaPathExists(tx, input.thumbnailUrl);
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
    ].filter((entry) => entry[1] !== undefined) as Array<[string, unknown]>;
    const expressions: string[] = [];
    if (input.publish !== undefined) {
      fields.push(['status', input.publish ? 'PUBLISHED' : 'DRAFT']);
      // 최초 발행 시각은 유지 — 이미 발행된 공지를 다시 publish:true로 저장해도 published_at을 덮지 않는다
      if (input.publish) expressions.push('published_at = COALESCE(published_at, now())');
      else fields.push(['published_at', null]);
    }
    // 행사 날짜는 EVENT 공지에만 남는다. 수정은 400 대신 조용히 맞춘다 - FE 수정 폼은 저장된 값을 그대로 되보내서, 400이면 날짜가 붙어 있던 옛 공지를 고칠 수 없다.
    //  - 분류를 EVENT 밖으로 바꾸면(또는 EVENT 아닌 분류로 저장하면) 날짜를 비운다
    //  - 분류를 안 보내고 날짜만 보내면 저장된 분류가 EVENT일 때만 반영한다 (CASE)
    if (input.category !== undefined && input.category !== 'EVENT') {
      expressions.push('event_date = NULL');
    } else if (input.eventDate !== undefined) {
      if (input.category === undefined && input.eventDate !== null) {
        fields.push(['event_date_if_event', input.eventDate]);
      } else {
        fields.push(['event_date', input.eventDate]);
      }
    }
    if (!fields.length) {
      // 바꿀 게 없는 PATCH도 없는/삭제된 공지는 404 — 존재하지 않는 id에 200 `{ id }`를 돌려주지 않는다
      const exists = await this.db.query(`SELECT 1 FROM notice WHERE id = $1 AND deleted_at IS NULL`, [noticeId]);
      if (!exists.rowCount) throw new NotFoundException('NOTICE_NOT_FOUND');
      return { id: noticeId };
    }
    const assignments = [
      ...fields.map(([column], index) => (column === 'event_date_if_event'
        ? `event_date = CASE WHEN category = 'EVENT' THEN $${index + 2}::date ELSE NULL END`
        : `${column} = $${index + 2}`)),
      ...expressions,
    ].join(', ');
    return this.db.tx(async (tx) => {
      await assertMediaPathExists(tx, input.thumbnailUrl);
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
